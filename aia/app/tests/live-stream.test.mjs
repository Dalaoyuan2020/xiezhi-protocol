import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../live/live.js', import.meta.url), 'utf8');
const start = source.indexOf('function run(q, pick) {');
const end = source.indexOf('\nlet allCands = [];', start);
assert.ok(start >= 0 && end > start, 'test executes the shipped stream handler');
const flush = () => new Promise(resolve => setImmediate(resolve));

function reader({ failRendering = false, canLeave = true } = {}) {
  const streams = [], logs = [], cards = [], progress = [], historyChanges = [], visible = new Map();
  const button = { disabled: false };
  const nodes = new Map(['net', 'cfilter', 'log', 'f'].map(id => [id, { value: '', innerHTML: '', textContent: '', querySelector: () => button }]));
  let resets = 0, rainCancellations = 0;
  const context = {
    ready: true, activeStream: null, apiBase: '/scholar-api', current: null,
    lastQuery: '', allCands: [], candidateNameVariants: [],
    window: { ClaimFlow: { reset() { resets++; }, canLeave: () => canLeave, progress: (step, message) => progress.push({ step, message }) } },
    location: { href: 'https://example.test/live/' }, history: { replaceState(...args) { historyChanges.push(args); } },
    URL, encodeURIComponent, setTimeout, matchMedia: () => ({ matches: true }),
    $: id => nodes.get(id), cancelCandidateFilter() {},
    cancelScholarRain() { rainCancellations++; },
    show: (id, on = true) => visible.set(id, on),
    esc: value => String(value ?? '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char])),
    li: (message, type) => logs.push({ message, type }),
    renderCands() {},
    renderCard(card) {
      cards.push(structuredClone(card));
      visible.set('result', true);
      visible.set('claimbox', true);
      if (failRendering) throw new Error('card renderer failed after showing its panel');
    },
    EventSource: class {
      constructor(url) { this.url = url; this.closed = false; streams.push(this); }
      close() { this.closed = true; }
      emit(event) { this.onmessage({ data: JSON.stringify(event) }); }
      invalid() { this.onmessage({ data: '{"match":[redacted]}' }); }
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context, { filename: 'live.js:run' });
  return { context, streams, logs, cards, progress, historyChanges, visible, button, nodes, resets: () => resets,
    rainCancellations: () => rainCancellations,
    setCanLeave(value) { canLeave = value; },
    run(query = 'A5126602136') { context.run(query); return streams.at(-1); } };
}

test('an open wallet operation blocks new searches without resetting the existing claim or starting another stream', () => {
  const view = reader();
  const original = view.run('A123');
  const existing = { id: 'A123', name: 'Existing scholar' };
  view.context.current = existing;
  view.context.allCands = [{ id: 'A123' }];
  view.nodes.get('cfilter').value = 'Existing institution';
  view.nodes.get('log').innerHTML = 'Previously verified results';
  view.visible.set('result', true); view.visible.set('claimbox', true);
  view.button.disabled = false;
  const resets = view.resets(), steps = view.progress.length, navigation = view.historyChanges.length;
  const rainCancellations = view.rainCancellations();
  assert.equal(rainCancellations, 1, 'the first search clears an earlier celebration');

  view.setCanLeave(false); // ClaimFlow returns false while its wallet request remains open.
  view.run('A999');
  assert.equal(view.streams.length, 1);
  assert.equal(view.context.activeStream, original);
  assert.equal(original.closed, false);
  assert.equal(view.resets(), resets);
  assert.equal(view.rainCancellations(), rainCancellations, 'a blocked search preserves the current celebration');
  assert.equal(view.progress.length, steps);
  assert.equal(view.historyChanges.length, navigation);
  assert.equal(view.context.current, existing);
  assert.equal(view.context.lastQuery, 'A123');
  assert.deepEqual(view.context.allCands, [{ id: 'A123' }]);
  assert.equal(view.nodes.get('cfilter').value, 'Existing institution');
  assert.equal(view.nodes.get('log').innerHTML, 'Previously verified results');
  assert.equal(view.visible.get('result'), true);
  assert.equal(view.visible.get('claimbox'), true);
  assert.equal(view.button.disabled, false);
  assert.match(view.nodes.get('net').textContent, /钱包操作尚未结束/);

  view.setCanLeave(true);
  const replacement = view.run('A999');
  assert.equal(view.streams.length, 2);
  assert.notEqual(replacement, original);
  assert.equal(original.closed, true);
  assert.equal(view.resets(), resets + 1);
  assert.equal(view.rainCancellations(), rainCancellations + 1, 'switching scholars cancels the previous celebration');
  assert.equal(view.context.lastQuery, 'A999');
  assert.match(replacement.url, /q=A999/);
});

test('malformed data cancels queued cards, hides conclusions and allows a clean retry', async () => {
  const view = reader();
  const stream = view.run();
  stream.emit({ step: 6, card: { score: 700 } });
  stream.invalid();
  await flush();
  assert.equal(stream.closed, true);
  assert.equal(view.context.activeStream, null);
  assert.deepEqual(view.cards, []);
  assert.equal(view.visible.get('result'), false);
  assert.equal(view.visible.get('claimbox'), false);
  assert.equal(view.button.disabled, false);
  assert.equal(view.resets(), 2);
  assert.equal(view.rainCancellations(), 2, 'a malformed stream clears any pending celebration');
  assert.equal(view.logs.filter(log => log.type === 'warn').length, 1);

  const retry = view.run();
  stream.invalid(); // A stale transport must not cancel the new request.
  retry.emit({ step: 6, card: { score: 710 } });
  retry.emit({ step: 7, title: '体检完成 · 本人认领后才盖章上链' });
  retry.emit({ done: true });
  await flush();
  assert.deepEqual(view.cards, [{ score: 710 }]);
  assert.equal(view.visible.get('result'), true);
  assert.equal(view.button.disabled, false);
  assert.equal(view.rainCancellations(), 3, 'the retry cancels old animation; stale errors do not cancel the retry');
});

test('render errors discard later queued messages and clear a partly rendered conclusion', async () => {
  const view = reader({ failRendering: true });
  const stream = view.run();
  stream.emit({ card: { score: 700 } });
  stream.emit({ step: 7, title: 'must not appear after the render error' });
  stream.emit({ card: { score: 900 } });
  stream.emit({ done: true });
  await flush();
  assert.equal(view.cards.length, 1);
  assert.equal(view.visible.get('result'), false);
  assert.equal(view.visible.get('claimbox'), false);
  assert.equal(view.logs.some(log => log.message.includes('must not appear')), false);
  assert.equal(view.button.disabled, false);
  assert.equal(view.rainCancellations(), 2, 'a failed render cancels its pending celebration');
});

test('transport and upstream errors cannot leave an incomplete card or claim available', async () => {
  for (const kind of ['disconnect', 'upstream']) {
    const view = reader();
    const stream = view.run();
    stream.emit({ card: { score: 700 } });
    await flush();
    if (kind === 'disconnect') stream.onerror();
    else stream.emit({ error: 'Public verification failed <details>' });
    await flush();
    assert.equal(view.visible.get('result'), false, kind);
    assert.equal(view.visible.get('claimbox'), false, kind);
    assert.equal(view.context.activeStream, null, kind);
    assert.equal(view.button.disabled, false, kind);
    assert.equal(view.logs.filter(log => log.type === 'warn').length, 1, kind);
    assert.equal(view.rainCancellations(), 2, `${kind} cancels the incomplete report celebration`);
    if (kind === 'upstream') assert.match(view.logs.at(-1).message, /&lt;details&gt;/);
  }
});

test('a normal done event preserves its queued final card without a false disconnection', async () => {
  const view = reader();
  const stream = view.run();
  stream.emit({ step: 1, title: '识别为学者编号' });
  stream.emit({ step: 2, title: '直接定位学者' });
  stream.emit({ step: 6, card: { score: 700 } });
  stream.emit({ done: true });
  stream.onerror();
  await flush();
  assert.deepEqual(view.cards, [{ score: 700 }]);
  assert.equal(view.visible.get('result'), true);
  assert.equal(view.logs.filter(log => log.type === 'warn').length, 0);
  assert.equal(view.button.disabled, false);
  assert.equal(view.rainCancellations(), 1, 'a normal completion does not clear the new report celebration');
});
