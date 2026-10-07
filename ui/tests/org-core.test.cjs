'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../org-core.js');
const snapshot = '2026-10-07T04:00:00.000Z';
const h = n => n.toString(16).padStart(64, '0');
function event(time, overrides = {}) {
  return { time, kind: 'submit', content_hash: h(1), org: 'Org A', author_id: 'DEMO-ONE', ...overrides };
}
const normalize = events => core.normalize({ asOf: snapshot, events });
const alerts = events => core.analyze(normalize(events), 'DEMO-ONE').alerts;

test('queries accept full hash, case-insensitive IDs and OpenAlex links, with explicit invalid/empty errors', () => {
  assert.deepEqual(core.parseQuery(' 0x' + 'AB'.repeat(32)), { type: 'hash', value: 'ab'.repeat(32) });
  assert.deepEqual(core.parseQuery('demo-one'), { type: 'author', value: 'DEMO-ONE' });
  assert.deepEqual(core.parseQuery('https://openalex.org/a123'), { type: 'author', value: 'A123' });
  assert.ok(core.parseQuery('').error);
  assert.ok(core.parseQuery('姓名').error);
  assert.ok(core.parseQuery('0x123').error);
});

test('open submissions remain open beyond thirty days until an authenticated matching closure', () => {
  const first = '2026-08-01T00:00:00.000Z';
  assert.equal(alerts([event(first), event('2026-08-31T00:00:00.000Z', { org: 'Org B' })]).length, 1);
  assert.equal(alerts([event(first), event('2026-09-30T00:00:00.001Z', { org: 'Org B' })]).length, 1);
});

test('closing before a later submission avoids a duplicate-submission signal', () => {
  const result = alerts([
    event('2026-06-01T00:00:00Z'),
    event('2026-07-01T00:00:00Z', { kind: 'close', close_reason: 'REJECTED' }),
    event('2026-08-01T00:00:00Z', { org: 'Org B' }),
  ]);
  assert.equal(result.length, 0);
});

test('same organization, repeated logs, non-submissions and future events cannot trigger cross-institution risk', () => {
  const rows = [
    event('2026-10-01T00:00:00Z', { content_hash: 'AB'.repeat(32) }),
    event('2026-10-01T00:00:00Z', { content_hash: 'ab'.repeat(32), org: 'org a' }),
    event('2026-10-02T00:00:00Z', { content_hash: 'ab'.repeat(32), org: 'ORG A' }),
    event('2026-10-03T00:00:00Z', { content_hash: 'ab'.repeat(32), org: 'Org B', kind: 'review' }),
    event('2026-10-08T00:00:00Z', { content_hash: 'ab'.repeat(32), org: 'Org B' })
  ];
  const data = normalize(rows);
  assert.equal(data.ignored, 2);
  assert.equal(data.events.length, 3);
  assert.equal(core.analyze(data, 'DEMO-ONE').alerts.length, 0);
});

test('seven-day threshold counts ten distinct manuscripts inclusively and excludes older/future/other-author records', () => {
  const lower = Date.parse(snapshot) - 7 * core.DAY;
  const rows = Array.from({ length: 9 }, (_, i) => event(snapshot, { content_hash: h(i + 1) }));
  rows.push(event(new Date(lower).toISOString(), { content_hash: h(10) }));
  rows.push(event(new Date(lower - 1).toISOString(), { content_hash: h(11) }));
  rows.push(event(new Date(Date.parse(snapshot) + 1).toISOString(), { content_hash: h(12) }));
  rows.push(event(snapshot, { content_hash: h(13), author_id: 'DEMO-OTHER' }));
  const result = core.analyze(normalize(rows), 'DEMO-ONE');
  assert.equal(result.alerts.find(a => a.type === 'frequency').count, 10);
  rows[9].time = new Date(lower - 1).toISOString();
  assert.equal(core.analyze(normalize(rows), 'DEMO-ONE').alerts.length, 0);
});

test('multiple submissions of one manuscript do not count as ten papers', () => {
  const rows = Array.from({ length: 12 }, (_, i) => event('2026-10-06T' + String(i).padStart(2, '0') + ':00:00Z'));
  const result = core.analyze(normalize(rows), 'DEMO-ONE');
  assert.equal(result.stats.submissions, 12);
  assert.equal(result.frequency[0].count, 1);
  assert.equal(result.alerts.length, 0);
});

test('hash queries retain query-scoped counts but label author frequency with evidence from all of that author’s submissions', () => {
  const rows = Array.from({ length: 10 }, (_, i) => event(snapshot, { content_hash: h(i + 1) }));
  rows.push(event(snapshot, { author_id: 'DEMO-OTHER', content_hash: h(100), org: 'Unrelated Org' }));
  const result = core.analyze(normalize(rows), h(1));
  assert.deepEqual(result.stats, { events: 1, submissions: 1, manuscripts: 1, orgs: 1 });
  assert.deepEqual(result.authors, ['DEMO-ONE']);
  assert.equal(result.alerts[0].type, 'frequency');
  assert.equal(result.alerts[0].evidenceIds.length, 10);
  assert.equal(result.alerts[0].author, 'DEMO-ONE');
});

test('unknown IDs and hashes return safe empty states without unrelated records or alerts', () => {
  const data = normalize([event(snapshot)]);
  for (const value of ['DEMO-UNKNOWN', h(9999), 'A5126602136']) {
    const result = core.analyze(data, value);
    assert.equal(result.events.length, 0);
    assert.equal(result.alerts.length, 0);
    assert.equal(result.stats.events, 0);
  }
});

test('bundled fictional cases exercise repeated manuscript, frequent author and quiet contributor separately', () => {
  const source = JSON.parse(fs.readFileSync(path.join(__dirname, '../org-mock.json'), 'utf8'));
  const data = core.normalize(source);
  assert.equal(data.ignored, 0);
  assert.ok(data.events.every(e => e.author_id.startsWith('DEMO-')));
  const multiple = core.analyze(data, source.examples[0].query);
  assert.equal(multiple.alerts.length, 1);
  assert.equal(multiple.alerts[0].type, 'multiple');
  assert.equal(multiple.alerts[0].orgCount, 2);
  const frequent = core.analyze(data, 'DEMO-FREQUENT');
  assert.equal(frequent.alerts.length, 1);
  assert.equal(frequent.alerts[0].count, 12);
  assert.equal(core.analyze(data, 'DEMO-COLLAB').alerts.length, 0);
  assert.equal(core.analyze(data, 'DEMO-COLLAB').events.length, 4);
  assert.equal(core.analyze(data, 'DEMO-TRANSFER').assessment.status, 'clear');
  assert.equal(core.analyze(data, 'DEMO-TRANSFER').assessment.closedCount, 1);
});

const address = n => '0x' + n.toString(16).padStart(40, '0');
const hash = n => '0x' + h(n);
const manifest = { kind: 'ready', journals: [
  { name: 'Journal A', address: address(1), org: hash(101) },
  { name: 'Journal B', address: address(2), org: hash(102) }
] };
const chainRow = (kind, sequence, overrides = {}) => ({ kind, knownKind: true, sequence,
  time: Date.parse('2026-10-06T00:00:00Z') / 1000, content: hash(1), subject: hash(201),
  recorder: address(1), org: hash(101), ...overrides });
const chainAnalysis = (records, list = manifest) => core.analyze(core.normalizeChain(records, list, { asOf: snapshot }), { type: 'hash', value: h(1) });

test('chain lifecycle changes red to green only for the same recorder, org, subject and content', () => {
  const records = [chainRow('SUBMIT', 0), chainRow('SUBMIT', 1, { recorder: address(2), org: hash(102) })];
  assert.equal(chainAnalysis(records).assessment.status, 'risk');
  for (const overrides of [{ recorder: address(9) }, { recorder: address(2) }, { org: hash(102) }, { subject: hash(999) }, { content: hash(999) }]) {
    assert.equal(chainAnalysis([...records, chainRow('CLOSE', 2, overrides)]).assessment.status, 'risk');
  }
  const result = chainAnalysis([...records, chainRow('CLOSE', 2, { closeReason: 'REJECTED' })]);
  assert.equal(result.assessment.status, 'clear');
  assert.equal(result.assessment.openCount, 1);
  assert.equal(result.assessment.closedCount, 1);
});

test('same-second order uses sequence; a close-before-submit cannot close a later submission and resubmitting reopens', () => {
  const rows = [chainRow('CLOSE', 0), chainRow('SUBMIT', 1), chainRow('SUBMIT', 2, { recorder: address(2), org: hash(102) })];
  assert.equal(chainAnalysis(rows.slice().reverse()).assessment.status, 'risk');
  rows.push(chainRow('CLOSE', 3));
  assert.equal(chainAnalysis(rows).assessment.status, 'clear');
  rows.push(chainRow('SUBMIT', 4));
  assert.equal(chainAnalysis(rows).assessment.status, 'risk');
});

test('missing, empty and failed trusted lists remain unknown instead of green', () => {
  const rows = [chainRow('SUBMIT', 0), chainRow('SUBMIT', 1, { recorder: address(2), org: hash(102) })];
  for (const list of [{ kind: 'missing', journals: [] }, { kind: 'error', journals: manifest.journals }, { kind: 'ready', journals: [] }]) {
    const result = chainAnalysis(rows, list);
    assert.equal(result.assessment.status, 'unknown');
    assert.equal(result.alerts.length, 0);
    assert.equal(result.assessment.trustedCount, 0);
  }
  assert.equal(chainAnalysis([]).assessment.status, 'unknown');
});

test('only address plus institution fingerprint grants trust, with case-insensitive matching', () => {
  const wrongPair = chainRow('SUBMIT', 0, { recorder: address(2), org: hash(101) });
  const result = chainAnalysis([wrongPair]);
  assert.equal(result.assessment.status, 'unknown');
  assert.equal(result.events[0].trusted, false);
  const correct = chainAnalysis([chainRow('SUBMIT', 0, { recorder: address(1).toUpperCase(), org: hash(101).toUpperCase() })]);
  assert.equal(correct.events[0].trusted, true);
});

test('closures cannot remove another manuscript or author and unknown kinds never close submissions', () => {
  const records = [chainRow('SUBMIT', 0), chainRow('SUBMIT', 1, { recorder: address(2), org: hash(102) }),
    chainRow('CLOSE', 2, { subject: hash(202) }), chainRow('OTHER', 3, { knownKind: false })];
  const result = chainAnalysis(records);
  assert.equal(result.assessment.status, 'risk');
  assert.equal(result.assessment.closedCount, 0);
  assert.equal(result.events[0].kind, 'unknown');
});

test('untrusted or future submissions cannot inflate the seven-day frequency signal', () => {
  const records = Array.from({ length: 12 }, (_, i) => chainRow('SUBMIT', i, { content: hash(i + 1), recorder: address(9) }));
  const normalized = core.normalizeChain(records, manifest, { asOf: snapshot });
  const result = core.analyze(normalized, { type: 'subject', value: hash(201) });
  assert.equal(result.assessment.status, 'unknown');
  assert.equal(result.alerts.length, 0);
  const future = core.normalizeChain([chainRow('SUBMIT', 0, { time: Date.parse(snapshot) / 1000 + 1 })], manifest, { asOf: snapshot });
  assert.equal(future.events.length, 0);
  assert.equal(future.ignored, 1);
});
