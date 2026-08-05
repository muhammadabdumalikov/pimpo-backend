import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_MAX_ITERATIONS,
  LlmEvent,
  LlmModelOption,
  LlmProvider,
  LlmRunOptions,
  MAX_OUTPUT_TOKENS,
} from './llm-provider.interface';

/**
 * Anthropic adapter — the reference implementation of the tool loop.
 *
 * We drive the loop manually rather than using the SDK's beta tool runner
 * because the same loop shape has to hold across three providers, and we need
 * to interleave our own SSE events (`tool_start` / `tool_end`) into it.
 */
export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({apiKey, maxRetries: 1});
  }

  async test(signal?: AbortSignal): Promise<void> {
    // One-token round trip: proves the key is valid and the model is reachable
    // without burning a real answer.
    await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 16,
        messages: [{role: 'user', content: 'Reply with OK.'}],
      },
      {signal},
    );
  }

  async listModels(signal?: AbortSignal): Promise<LlmModelOption[]> {
    // Every model the Messages API lists is chat-capable, so no filtering is
    // needed here. The API returns newest first.
    const page = await this.client.models.list({limit: 40}, {signal});
    return page.data.map((m) => ({id: m.id, label: m.display_name || m.id}));
  }

  async *run(opts: LlmRunOptions): AsyncGenerator<LlmEvent, void, void> {
    const {system, history, question, tools, executeTool, signal} = opts;
    const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    const messages: Anthropic.MessageParam[] = [
      ...history.map(
        (t): Anthropic.MessageParam => ({role: t.role, content: t.content}),
      ),
      {role: 'user', content: question},
    ];

    const toolDefs: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          // Stable prefix (persona + tool guidance + schema notes) is the whole
          // system block, so one breakpoint caches it across every question.
          // Nothing volatile goes above this line.
          system: [
            {
              type: 'text',
              text: system,
              cache_control: {type: 'ephemeral'},
            },
          ],
          messages,
          tools: toolDefs,
          // Adaptive thinking: the model decides how much reasoning a question
          // needs. `medium` effort keeps a chat answer responsive; raise it if
          // multi-step questions start being answered shallowly.
          thinking: {type: 'adaptive'},
          output_config: {effort: 'medium'},
        },
        {signal},
      );

      // Text deltas stream straight through to the browser.
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          yield {type: 'text', delta: event.delta.text};
        }
      }

      const message = await stream.finalMessage();

      if (message.usage) {
        yield {
          type: 'usage',
          inputTokens: message.usage.input_tokens ?? 0,
          outputTokens: message.usage.output_tokens ?? 0,
        };
      }

      // Safety classifiers can decline; `content` may be empty, so this must be
      // checked before anything reads content[0].
      if (message.stop_reason === 'refusal') {
        yield {
          type: 'error',
          message: 'The model declined to answer this question.',
          retryable: false,
        };
        return;
      }

      const toolUses = message.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      if (toolUses.length === 0) return; // final answer already streamed

      // Echo the assistant turn back verbatim — thinking blocks included, which
      // the API requires when continuing on the same model.
      messages.push({role: 'assistant', content: message.content});

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of toolUses) {
        const args = (call.input ?? {}) as Record<string, unknown>;
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

        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(result),
          is_error: !ok,
        });
      }

      // All results go back in ONE user turn — splitting them trains the model
      // out of parallel tool calls.
      messages.push({role: 'user', content: results});
    }

    yield {
      type: 'error',
      message: `Stopped after ${maxIterations} steps without a final answer.`,
      retryable: true,
    };
  }
}
