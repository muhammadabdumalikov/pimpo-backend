import Anthropic from '@anthropic-ai/sdk';
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
    const displayOnly = displayOnlyNames(tools);

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

      // Text deltas stream straight through to the browser. `turnText` is kept
      // only to decide whether this turn already answered the question.
      let turnText = '';
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          turnText += event.delta.text;
          yield {type: 'text', delta: event.delta.text};
        }
      }

      const message = await stream.finalMessage();

      if (message.usage) {
        // `input_tokens` counts only the UNCACHED part — the SDK docs spell it
        // out: total input is input + cache_creation + cache_read. Reporting
        // the bare field would hide the entire cached prefix, which on a warm
        // cache is most of the request.
        const cacheRead = message.usage.cache_read_input_tokens ?? 0;
        const cacheWrite = message.usage.cache_creation_input_tokens ?? 0;
        yield {
          type: 'usage',
          inputTokens:
            (message.usage.input_tokens ?? 0) + cacheRead + cacheWrite,
          // Anthropic already folds thinking into output_tokens, so there is no
          // separate `thinkingTokens` to report here.
          outputTokens: message.usage.output_tokens ?? 0,
          cachedInputTokens: cacheRead,
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
      const outcomes: {name: string; ok: boolean}[] = [];
      for (const call of toolUses) {
        const args = (call.input ?? {}) as Record<string, unknown>;
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

        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(result),
          is_error: !ok,
        });
      }

      // The answer was written alongside the render call, so there is nothing
      // left for another round-trip to produce.
      if (turnEndsHere(turnText, outcomes, displayOnly)) {
        return;
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
