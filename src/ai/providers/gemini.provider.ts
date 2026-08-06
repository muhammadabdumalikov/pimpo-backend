import {
  Content,
  FunctionDeclaration,
  GenerateContentResponseUsageMetadata,
  GoogleGenAI,
  Part,
  Schema,
} from '@google/genai';
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
 * Google Gemini adapter.
 *
 * Structural differences from the other two: the system prompt lives in
 * `config.systemInstruction`, the abort signal goes inside `config` rather
 * than a request-options argument, turns are `user` / `model` (not
 * `assistant`), and tool results are `functionResponse` parts batched into a
 * single user turn — closer to Anthropic's shape than OpenAI's.
 */
export class GeminiProvider implements LlmProvider {
  readonly id = 'gemini' as const;
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new GoogleGenAI({apiKey});
  }

  async test(signal?: AbortSignal): Promise<void> {
    await this.client.models.generateContent({
      model: this.model,
      contents: [{role: 'user', parts: [{text: 'Reply with OK.'}]}],
      config: {maxOutputTokens: 16, abortSignal: signal},
    });
  }

  async *run(opts: LlmRunOptions): AsyncGenerator<LlmEvent, void, void> {
    const {system, history, question, tools, executeTool, signal} = opts;
    const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    const contents: Content[] = [
      ...history.map(
        (t): Content => ({
          role: t.role === 'assistant' ? 'model' : 'user',
          parts: [{text: t.content}],
        }),
      ),
      {role: 'user', parts: [{text: question}]},
    ];

    const functionDeclarations: FunctionDeclaration[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      // Gemini accepts an OpenAPI-subset schema, which our JSON Schema objects
      // already conform to (object / string / number / boolean / array + enum).
      parameters: t.parameters as unknown as Schema,
    }));
    const displayOnly = displayOnlyNames(tools);

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const stream = await this.client.models.generateContentStream({
        model: this.model,
        contents,
        config: {
          systemInstruction: system,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          tools: [{functionDeclarations}],
          abortSignal: signal,
        },
      });

      const calls: {
        /** Our id for pairing tool_start/tool_end in the UI. */
        id: string;
        /** Gemini's own id, present only for parallel calls. */
        apiId?: string;
        name: string;
        args: Record<string, unknown>;
      }[] = [];
      // Accumulated VERBATIM, never rebuilt from the values we extracted below.
      const modelParts: Part[] = [];
      // Gemini repeats cumulative usage on many chunks. Keeping only the last
      // and reporting once per iteration avoids a log line per chunk that would
      // otherwise read as dozens of separate charges for one round-trip.
      let usage: GenerateContentResponseUsageMetadata | undefined;
      // Visible prose only (thought parts excluded), to decide whether this
      // turn already answered the question.
      let turnText = '';

      for await (const chunk of stream) {
        // Reading `candidates[0].content.parts` rather than the `chunk.text` /
        // `chunk.functionCalls` convenience getters is load-bearing: those
        // getters project out the values and drop everything else on the part,
        // including `thoughtSignature`. Gemini requires that signature to be
        // echoed back on the next request — without it the follow-up call fails
        // with "Function call is missing a thought_signature in functionCall
        // parts". So we keep each part as it arrived and hand it straight back.
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          modelParts.push(part);

          // `thought: true` marks the model's internal reasoning — it belongs in
          // the echoed history but must not be streamed to the shop owner.
          if (part.text && !part.thought) {
            turnText += part.text;
            yield {type: 'text', delta: part.text};
          }

          if (part.functionCall?.name) {
            calls.push({
              // Gemini only sets `id` for parallel calls; fall back to a
              // deterministic local id so tool_start/tool_end can be paired.
              id:
                part.functionCall.id ??
                `${part.functionCall.name}-${iteration}-${calls.length}`,
              apiId: part.functionCall.id,
              name: part.functionCall.name,
              args: part.functionCall.args ?? {},
            });
          }
        }

        if (chunk.usageMetadata) usage = chunk.usageMetadata;
      }

      if (usage) {
        // `candidatesTokenCount` is the ANSWER only — thinking is counted in
        // `thoughtsTokenCount` and billed as output, so leaving it out
        // under-reports the real charge (badly, on the thinking-heavy models).
        const thinking = usage.thoughtsTokenCount ?? 0;
        yield {
          type: 'usage',
          inputTokens: usage.promptTokenCount ?? 0,
          outputTokens: (usage.candidatesTokenCount ?? 0) + thinking,
          // Non-zero means Gemini's implicit cache absorbed our stable prefix.
          cachedInputTokens: usage.cachedContentTokenCount ?? 0,
          thinkingTokens: thinking,
        };
      }

      if (calls.length === 0) return; // final answer already streamed

      // Echo the model turn exactly as received, then answer every call in one
      // user turn.
      contents.push({role: 'model', parts: modelParts});

      const responseParts: Part[] = [];
      const outcomes: {name: string; ok: boolean}[] = [];
      for (const call of calls) {
        yield {
          type: 'tool_start',
          id: call.id,
          name: call.name,
          args: call.args,
        };

        const startedAt = Date.now();
        const {ok, result} = await executeTool(call.name, call.args);
        outcomes.push({name: call.name, ok});
        yield {
          type: 'tool_end',
          id: call.id,
          name: call.name,
          ok,
          ms: Date.now() - startedAt,
        };

        responseParts.push({
          functionResponse: {
            // Echo Gemini's id when it gave one — that is how it matches a
            // response to its call when several run in parallel. Omitted (not
            // faked) otherwise, since our synthetic id means nothing to the API.
            ...(call.apiId ? {id: call.apiId} : {}),
            name: call.name,
            // Must be an object; wrap scalars/arrays so the API accepts them.
            response: {result} as Record<string, unknown>,
          },
        });
      }

      // The answer was written alongside the render call, so there is nothing
      // left for another round-trip to produce.
      if (turnEndsHere(turnText, outcomes, displayOnly)) {
        return;
      }

      contents.push({role: 'user', parts: responseParts});
    }

    yield {
      type: 'error',
      message: `Stopped after ${maxIterations} steps without a final answer.`,
      retryable: true,
    };
  }
}
