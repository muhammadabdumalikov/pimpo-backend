import {
  PROVIDER_MODELS,
  displayOnlyNames,
  estimateCostUsd,
  isValidModelId,
  turnEndsHere,
  type LlmToolDef,
} from './llm-provider.interface';

/**
 * `turnEndsHere` decides whether to skip a model round-trip. Getting it wrong
 * in the permissive direction truncates a real answer mid-sentence, so every
 * case below that returns false is a guard worth keeping — the cost of a false
 * negative is one extra call, the cost of a false positive is a broken answer.
 */
describe('turnEndsHere', () => {
  const DISPLAY_ONLY = new Set(['render_result']);
  const ok = (name: string) => ({name, ok: true});
  const failed = (name: string) => ({name, ok: false});
  const ANSWER = 'Bu oy 7 352 000 so‘m tushum bo‘ldi.';

  it('ends the loop when a complete answer accompanies the render call', () => {
    expect(turnEndsHere(ANSWER, [ok('render_result')], DISPLAY_ONLY)).toBe(
      true,
    );
  });

  it('ends the loop when the model rendered twice in the same turn', () => {
    expect(
      turnEndsHere(
        ANSWER,
        [ok('render_result'), ok('render_result')],
        DISPLAY_ONLY,
      ),
    ).toBe(true);
  });

  it('continues when a real tool ran — the model has not seen its result yet', () => {
    expect(turnEndsHere(ANSWER, [ok('sales_summary')], DISPLAY_ONLY)).toBe(
      false,
    );
  });

  it('continues when a real tool ran alongside the render call', () => {
    expect(
      turnEndsHere(
        ANSWER,
        [ok('sales_summary'), ok('render_result')],
        DISPLAY_ONLY,
      ),
    ).toBe(false);
  });

  it('continues when nothing was called', () => {
    expect(turnEndsHere(ANSWER, [], DISPLAY_ONLY)).toBe(false);
  });

  it('continues when the model rendered without saying anything', () => {
    expect(turnEndsHere('', [ok('render_result')], DISPLAY_ONLY)).toBe(false);
    expect(turnEndsHere('   \n ', [ok('render_result')], DISPLAY_ONLY)).toBe(
      false,
    );
  });

  it('continues on a lead-in that promises more', () => {
    // The exact failure this guard exists for: cutting here would leave the
    // owner with a colon and a table, and no answer.
    expect(
      turnEndsHere('Bu oy sotuvlaringiz:', [ok('render_result')], DISPLAY_ONLY),
    ).toBe(false);
    // Trailing whitespace must not hide the colon.
    expect(
      turnEndsHere(
        'Natijalar quyidagicha:  \n',
        [ok('render_result')],
        DISPLAY_ONLY,
      ),
    ).toBe(false);
    // A finished sentence followed by a new lead-in is still a lead-in.
    expect(
      turnEndsHere(
        `${ANSWER} Tafsilotlar:`,
        [ok('render_result')],
        DISPLAY_ONLY,
      ),
    ).toBe(false);
  });

  it('continues when no sentence has been finished', () => {
    expect(
      turnEndsHere('Bu oy tushum kamaydi', [ok('render_result')], DISPLAY_ONLY),
    ).toBe(false);
  });

  it('accepts the other locales the assistant answers in', () => {
    expect(
      turnEndsHere(
        'Выручка за месяц — 7 352 000 сум.',
        [ok('render_result')],
        DISPLAY_ONLY,
      ),
    ).toBe(true);
    expect(
      turnEndsHere(
        'Revenue fell 80% — what happened?',
        [ok('render_result')],
        DISPLAY_ONLY,
      ),
    ).toBe(true);
    expect(
      turnEndsHere('Savdo keskin tushdi!', [ok('render_result')], DISPLAY_ONLY),
    ).toBe(true);
  });

  it('continues when the render call was rejected, so the model can retry', () => {
    // `render_result` answers a malformed payload with "that did not match the
    // schema". Ending the loop here swallows that message and the owner gets
    // prose with no table or chart — observed in production as
    // `calls=1 tools=[render_result!]`.
    expect(turnEndsHere(ANSWER, [failed('render_result')], DISPLAY_ONLY)).toBe(
      false,
    );
    // One good render plus one rejected still has a failure to fix.
    expect(
      turnEndsHere(
        ANSWER,
        [ok('render_result'), failed('render_result')],
        DISPLAY_ONLY,
      ),
    ).toBe(false);
  });

  it('never ends the loop when no tool is marked display-only', () => {
    // Defensive: if RENDER_TOOL ever loses its flag, the loop must fall back to
    // the old always-one-more-round behaviour rather than truncating.
    expect(turnEndsHere(ANSWER, [ok('render_result')], new Set())).toBe(false);
  });
});

describe('displayOnlyNames', () => {
  const tool = (name: string, displayOnly?: boolean): LlmToolDef => ({
    name,
    description: '',
    parameters: {type: 'object', properties: {}},
    ...(displayOnly ? {displayOnly} : {}),
  });

  it('collects only the flagged tools', () => {
    const names = displayOnlyNames([
      tool('sales_summary'),
      tool('render_result', true),
      tool('pnl'),
    ]);
    expect([...names]).toEqual(['render_result']);
  });

  it('is empty when nothing is flagged', () => {
    expect(displayOnlyNames([tool('pnl')]).size).toBe(0);
  });
});

describe('estimateCostUsd', () => {
  // Read off the catalogue instead of naming an id: models get retired (2.5
  // Flash did, mid-development), and a pricing test should not fail for that.
  const MODEL = PROVIDER_MODELS.gemini[0];
  const PRICE = MODEL.usdPer1M!;
  const cost = (i: number, o: number, sys = false) =>
    estimateCostUsd(MODEL.id, 'gemini', i, o, sys);

  it('prices a question at the provider list rate', () => {
    // A measured question: ~10k in, ~1k out.
    expect(cost(10_000, 1_000)).toBeCloseTo(
      (10_000 * PRICE.input) / 1e6 + (1_000 * PRICE.output) / 1e6,
      9,
    );
  });

  it('adds the 25% margin only on Pimpo-supplied tokens', () => {
    const list = cost(1_000_000, 0);
    expect(list).toBeCloseTo(PRICE.input, 9);
    expect(cost(1_000_000, 0, true)).toBeCloseTo(PRICE.input * 1.25, 9);
    // BYOK is billed by the vendor directly, so we take nothing.
    expect(cost(1_000_000, 0, false)).toBe(list);
  });

  it('returns 0 rather than a guess for a model we have no price for', () => {
    expect(estimateCostUsd('some-custom-model', 'gemini', 1e6, 1e6)).toBe(0);
    // Right id, wrong provider — must not price off another vendor's table.
    expect(estimateCostUsd(MODEL.id, 'openai', 1e6, 1e6)).toBe(0);
    // The markup must not conjure a cost out of an unpriced model either.
    expect(estimateCostUsd('some-custom-model', 'gemini', 1e6, 1e6, true)).toBe(
      0,
    );
  });

  it('charges output far more heavily than input, per the price table', () => {
    expect(cost(0, 1_000_000)).toBeGreaterThan(cost(1_000_000, 0));
  });

  it('has a published price for every model we offer', () => {
    // A catalogue entry without a price silently stops the spend counter, which
    // reads as "the assistant is free" on the settings page.
    for (const [provider, models] of Object.entries(PROVIDER_MODELS)) {
      for (const m of models) {
        expect(
          `${provider}/${m.id}: ${m.usdPer1M ? 'priced' : 'MISSING'}`,
        ).toBe(`${provider}/${m.id}: priced`);
      }
    }
  });
});

describe('isValidModelId', () => {
  it('accepts real model ids from all three providers', () => {
    for (const id of [
      'claude-sonnet-5',
      'gpt-5-mini',
      'gemini-2.5-flash',
      'gemini-3.1-pro-preview',
      'ft:gpt-4o-2024-08-06:acme:custom:abc123',
    ]) {
      expect(isValidModelId(id)).toBe(true);
    }
  });

  it('rejects ids that could not come from a provider', () => {
    for (const id of [
      '',
      ' ',
      'a',
      '-leading-dash',
      'has space',
      'x'.repeat(61),
    ]) {
      expect(isValidModelId(id)).toBe(false);
    }
  });
});
