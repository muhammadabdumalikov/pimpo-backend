import OpenAI from 'openai';
import {
  DEFAULT_MAX_ITERATIONS,
  LlmEvent,
  LlmModelOption,
  LlmProvider,
  LlmRunOptions,
  MAX_OUTPUT_TOKENS,
} from './llm-provider.interface';

/**
 * OpenAI adapter (Chat Completions + function calling).
 *
 * Same loop shape as the Anthropic adapter; the differences are mechanical:
 * the system prompt is a message rather than a top-level field, tool calls
 * arrive as deltas that must be accumulated, and each result is its own
 * `role: 'tool'` message instead of one batched user turn.
 */
export class OpenAiProvider implements LlmProvider {
  readonly id = 'openai' as const;
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new OpenAI({apiKey, maxRetries: 1});
  }

  async test(signal?: AbortSignal): Promise<void> {
    await this.client.chat.completions.create(
      {
        model: this.model,
        max_completion_tokens: 16,
        messages: [{role: 'user', content: 'Reply with OK.'}],
      },
      {signal},
    );
  }

  async listModels(signal?: AbortSignal): Promise<LlmModelOption[]> {
    const page = await this.client.models.list({signal});

    // The catalogue mixes in embeddings, audio, image and moderation models.
    // A DENYLIST rather than an allowlist: worst case an irrelevant entry shows
    // up in the dropdown, whereas an allowlist would hide a chat model released
    // after this code was written — which is the failure we are fixing.
    const NOT_CHAT =
      /^(text-embedding|whisper|tts|dall-e|gpt-image|omni-moderation|text-moderation|davinci|babbage|sora)/;

    return page.data
      .filter((m) => !NOT_CHAT.test(m.id))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .map((m) => ({id: m.id, label: m.id}));
  }

  async *run(opts: LlmRunOptions): AsyncGenerator<LlmEvent, void, void> {
    const {system, history, question, tools, executeTool, signal} = opts;
    const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {role: 'system', content: system},
      ...history.map(
        (t): OpenAI.Chat.ChatCompletionMessageParam =>
          t.role === 'user'
            ? {role: 'user', content: t.content}
            : {role: 'assistant', content: t.content},
      ),
      {role: 'user', content: question},
    ];

    const toolDefs: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      },
    }));

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          max_completion_tokens: MAX_OUTPUT_TOKENS,
          messages,
          tools: toolDefs,
          stream: true,
          stream_options: {include_usage: true},
        },
        {signal},
      );

      let text = '';
      // Tool calls stream in fragments keyed by index; `arguments` arrives as a
      // partial JSON string that only parses once the block is complete.
      const pending = new Map<
        number,
        {id: string; name: string; args: string}
      >();

      for await (const chunk of stream) {
        if (chunk.usage) {
          yield {
            type: 'usage',
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          };
        }

        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          text += delta.content;
          yield {type: 'text', delta: delta.content};
        }

        for (const tc of delta.tool_calls ?? []) {
          const slot = pending.get(tc.index) ?? {id: '', name: '', args: ''};
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          pending.set(tc.index, slot);
        }
      }

      const calls = [...pending.values()].filter((c) => c.name);
      if (calls.length === 0) return; // final answer already streamed

      messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: {name: c.name, arguments: c.args || '{}'},
        })),
      });

      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.args || '{}') as Record<string, unknown>;
        } catch {
          // Malformed argument JSON is a model error, not ours — hand it back
          // as a failed tool result so it can retry with valid arguments.
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({
              error: 'Arguments were not valid JSON. Send valid JSON.',
            }),
          });
          continue;
        }

        yield {type: 'tool_start', id: call.id, name: call.name, args};
        const startedAt = Date.now();
        const {ok, result} = await executeTool(call.name, args);
        yield {
          type: 'tool_end',
          id: call.id,
          name: call.name,
          ok,
          ms: Date.now() - startedAt,
        };

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }

    yield {
      type: 'error',
      message: `Stopped after ${maxIterations} steps without a final answer.`,
      retryable: true,
    };
  }
}
