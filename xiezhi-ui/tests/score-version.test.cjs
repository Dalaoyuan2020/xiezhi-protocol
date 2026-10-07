'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { scorePresentation } = require('../checkup-chain.js');

test('v2 chain raw values use the declared 350–950 scale without changing v0 evidence snapshots', () => {
  for (const [raw, display] of [[0, 350], [51, 656], [59, 704], [73, 788], [100, 950]]) {
    assert.equal(scorePresentation({ kind: 'SCORE', value: raw, ruleName: 'checkup-v2' }).value, display);
  }
  assert.equal(scorePresentation({ kind: 'SCORE', value: 70, ruleName: 'checkup-v0' }).value, 70);
  assert.equal(scorePresentation({ kind: 'SCORE', value: 70, ruleName: 'checkup-v0' }).suffix, '/100');
  assert.equal(scorePresentation({ kind: 'SCORE', value: 51, ruleName: 'unknown' }).suffix, '原值');
  for (const row of [null, { kind: 'CLAIM', value: 0 }, { kind: 'SCORE', value: 101 }, { kind: 'SCORE', value: NaN }]) assert.equal(scorePresentation(row), null);
});

test('old card links retain author, receipt view, candidate flag and explicit network selection', () => {
  const html = fs.readFileSync(path.join(__dirname, '../card.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  for (const network of ['mainnet', 'testnet']) {
    let destination;
    vm.runInNewContext(script, { URL, URLSearchParams, location: {
      href: 'https://checkup.example/ui/card.html',
      search: '?id=A5126602136&view=receipt&candidate=1&network=' + network,
      replace: value => { destination = new URL(value); }
    } });
    assert.equal(destination.pathname, '/ui/checkup.html');
    assert.equal(destination.searchParams.get('case'), 'A5126602136');
    assert.equal(destination.searchParams.get('network'), network);
    assert.equal(destination.searchParams.get('view'), 'receipt');
    assert.equal(destination.searchParams.get('candidate'), '1');
  }
});
