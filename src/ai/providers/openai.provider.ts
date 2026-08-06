import OpenAI from 'openai';
import {
  DEFAULT_MAX_ITERATIONS,
  LlmEvent,
  LlmProvider,
  LlmRunOptions,
  MAX_OUTPUT_TOKENS,
  displayOnlyNames,
  turnEndsHere,
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
    const displayOnly = displayOnlyNames(tools);

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
          // `completion_tokens` already includes reasoning tokens; they are
          // broken out here only so the log can show how much of the output
          // charge bought thinking the owner never sees.
          yield {
            type: 'usage',
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            cachedInputTokens:
              chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
            thinkingTokens:
              chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
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

      const outcomes: {name: string; ok: boolean}[] = [];
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
          // Unparsable arguments are a failure the model must see and fix.
          outcomes.push({name: call.name, ok: false});
          continue;
        }

        yield {type: 'tool_start', id: call.id, name: call.name, args};
        const startedAt = Date.now();
        const {ok, result} = await executeTool(call.name, args);
        outcomes.push({name: call.name, ok});
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

      // The answer was written alongside the render call, so there is nothing
      // left for another round-trip to produce.
      if (turnEndsHere(text, outcomes, displayOnly)) {
        return;
      }
    }

    yield {
      type: 'error',
      message: `Stopped after ${maxIterations} steps without a final answer.`,
      retryable: true,
    };
  }
}
