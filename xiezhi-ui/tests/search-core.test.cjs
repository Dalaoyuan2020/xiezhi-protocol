'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../search-core.js');
const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, '../search-data.json'), 'utf8'));
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, '../../aia/product/mock_cases.json'), 'utf8'));
const people = [...snapshot.candidates, ...core.caseCandidates(cases).filter(item => !snapshot.candidates.some(candidate => candidate.id === item.id))];

test('name variants return the same five distinct public candidates, never auto-selecting an identity', () => {
  const expected = ['A5126602136', 'A5111337086', 'A5008144497', 'A5113431368', 'A5104300844'];
  for (const query of ['Zhiyuan Lyu', '  Zhiyuan   Lyu ', '吕志远', 'Lyu', 'lü']) {
    const found = core.search(query, people);
    assert.equal(found.direct, null);
    assert.deepEqual(found.items.map(item => item.id), expected);
  }
});

test('ORCID exact match routes only to the matching author; other valid identifiers cannot fall back to本人', () => {
  for (const query of ['0009-0008-5473-5367', 'https://orcid.org/0009-0008-5473-5367', '0009000854735367']) {
    assert.equal(core.search(query, people).direct, 'checkup.html?case=A5126602136');
  }
  assert.equal(core.search('0009-0005-5014-6889', people).direct, 'checkup.html?case=A5111337086&candidate=1');
  assert.deepEqual(core.search('0000-0000-0000-0000', people), { items: [], direct: null });
});

test('unscored candidates get candidate-only links, even if a mistaken hasScore flag is present', () => {
  assert.equal(core.candidateUrl({ id: 'A5111337086', hasScore: true }), 'checkup.html?case=A5111337086&candidate=1');
  assert.equal(core.candidateUrl({ id: 'SYNTHETIC' }), 'checkup.html?case=SYNTHETIC');
  assert.equal(core.candidateUrl({ id: 'javascript:alert(1)' }), null);
  assert.equal(core.candidateUrl({ id: '../A5126602136' }), null);
});

test('searches existing cases and explains misses without silently selecting a scored case', () => {
  assert.equal(core.search('何恺明', people).items[0].id, 'A5100700361');
  assert.equal(core.search('Karpathy', people).items[0].id, 'A5009290031');
  assert.equal(core.search('虚构', people).items[0].id, 'SYNTHETIC');
  assert.deepEqual(core.search('no-such-researcher', people), { items: [], direct: null });
  assert.deepEqual(core.search('', people), { items: [], direct: null });
});

test('the conflict is preserved in public source data; self-reported attribution is separated', () => {
  const conflicting = snapshot.candidates.find(item => item.id === 'A5111337086');
  assert.ok(conflicting.institutions.includes('Hohai University'));
  assert.ok(conflicting.affiliations.some(item => item.name === 'Shanghai Jiao Tong University'));
  assert.match(conflicting.note, /本人报告/);
  assert.match(conflicting.note, /仍需核对/);
  assert.equal(conflicting.hasScore, false);
  for (const candidate of snapshot.candidates) {
    assert.equal(candidate.sourceUrl, 'https://api.openalex.org/authors/' + candidate.id);
    assert.ok(Number.isFinite(Date.parse(candidate.fetchedAt)));
    assert.equal(candidate.snapshotDate, '2026-10-07');
  }
});
