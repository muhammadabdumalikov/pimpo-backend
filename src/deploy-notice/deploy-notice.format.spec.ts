import {
  buildNotice,
  MESSAGE_LIMIT,
  NoticeItem,
  renderBlock,
  splitMessage,
} from './deploy-notice.format';

const item = (n: number, body = ''): NoticeItem => ({
  sha: `${n}`.padStart(40, 'a'),
  url: `https://github.com/o/r/commit/${n}`,
  title: `Sarlavha ${n}`,
  body,
});

describe('deploy notice format', () => {
  it('splits subject and body and drops trailers', () => {
    expect(
      splitMessage(
        'Shift approval\n\nPOST /shifts/:id/approve\n\nCo-Authored-By: Claude <x@y>\n',
      ),
    ).toEqual({title: 'Shift approval', body: 'POST /shifts/:id/approve'});
    expect(splitMessage('One line')).toEqual({title: 'One line', body: ''});
  });

  it('escapes HTML and links the short sha', () => {
    const out = renderBlock(item(1, 'P&L <b>'), 4000);
    expect(out).toContain('P&amp;L &lt;b&gt;');
    expect(out).toContain('>aaaaaaa</a>');
  });

  it('cuts a huge body to the budget without splitting an entity', () => {
    const out = renderBlock(item(1, '&'.repeat(5000)), 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out).toMatch(/(&amp;)+…/);
  });

  it('packs many commits into messages under the Telegram limit', () => {
    const items = Array.from({length: 40}, (_, i) => item(i, 'x'.repeat(700)));
    const msgs = buildNotice({
      label: 'Backend',
      items,
      total: 50,
      compareUrl: 'https://github.com/o/r/compare/a...b',
    });
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(MESSAGE_LIMIT);
    expect(msgs[0]).toMatch(/^🚀 <b>Backend<\/b> · 50 ta o'zgarish/);
    expect(msgs.at(-1)).toContain('Yana 10 ta');
  });

  it('flags an untranslated notice', () => {
    const [m] = buildNotice({
      label: 'B',
      items: [item(1)],
      total: 1,
      untranslated: true,
    });
    expect(m).toContain('Tarjima ishlamadi');
  });
});
