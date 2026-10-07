'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../checkup-core.js');
const evidence = require('../evidence-core.js');
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, '../../aia/product/mock_cases.json'), 'utf8'));
const options = { rules: core.RULES };
const normalized = index => core.normalizeCase(cases.cases[index], cases);

test('input model distinguishes literal fields, saved summary values and unavailable per-work inputs', () => {
  const record = normalized(0); const model = evidence.createModel(record, options);
  assert.equal(model.dimensions.length, 5); assert.equal(model.missingInputs, true);
  assert.deepEqual(model.dimensions.map(dim => dim.inputRows.find(row => row.status === 'summary').value), ['Engineering · 100%', '0 篇', '50%', '0.0', '2 篇 · 2025 年']);
  assert.ok(model.dimensions.every(dim => dim.summaryParsed && dim.inputRows.some(row => row.status === 'missing')));
  assert.equal(model.dimensions[0].inputRows[0].status, 'raw'); assert.equal(model.dimensions[0].inputRows[0].value, record.raw.orcid);
  assert.equal(model.identity.find(row => row.field === 'works').value, '2');
  assert.ok(model.dimensions[2].missing[0].includes('开放获取作品数'));
  assert.equal(model.dimensions[2].missing.some(value => value.includes('已取得作品总数')), false);
  const sample = model.dimensions[2].inputRows.find(row => row.field === 'works');
  assert.equal(sample.status, 'raw'); assert.equal(sample.value, '2'); assert.match(sample.label, /已取得样本数/);
  assert.equal(model.dimensions[2].rawText, record.raw.dims['开放程度']);
  assert.match(model.scopeLimit, /works 是 checkup.py v0 输出的已取得作品数/);
  assert.match(model.worksScope, /至少 400 条/); assert.equal(model.ruleVersion, 'v0');
  assert.ok(Object.isFrozen(model.dimensions[2].inputRows));
});

test('scored works follows the script sample count while candidate works retains its author-library meaning', () => {
  const record = normalized(0); const scored = evidence.createModel(record, options);
  const candidate = evidence.createModel({ id: record.id, name: record.name, works: record.works, orcid: record.orcid }, options);
  assert.equal(scored.worksCountKind, 'script-sample');
  assert.equal(candidate.worksCountKind, 'author-record');
  const scoredCount = scored.identity.find(row => row.field === 'works');
  const candidateCount = candidate.identity.find(row => row.field === 'works');
  assert.equal(scoredCount.value, candidateCount.value); // Same value does not imply the same denominator.
  assert.match(scoredCount.label, /已取得样本数.*脚本输出 works/);
  assert.match(candidateCount.label, /作者库收录作品数/);
  assert.match(candidate.scopeLimit, /没有五维评分/);
  assert.ok(scored.dimensions.every(dim => dim.inputRows.some(row => row.field === 'works' && row.status === 'raw')));
  assert.equal(scored.dimensions[2].inputRows.some(row => row.field === '开放获取作品数' && row.status !== 'missing'), false);
  const unconfirmed = evidence.createModel(core.normalizeCase(cases.cases[0]), options);
  assert.equal(unconfirmed.worksCountKind, 'unconfirmed');
  assert.match(unconfirmed.identity.find(row => row.field === 'works').label, /采样口径待核实/);
  assert.match(unconfirmed.scopeLimit, /已保存 works 字段/);
  assert.equal(unconfirmed.scopeLimit.includes('实际取得的作品数未保存'), false);
  assert.match(unconfirmed.dimensions[2].missing.join(' '), /评分分母的采样口径/);
  const synthetic = evidence.createModel(normalized(3), options);
  assert.equal(synthetic.worksCountKind, 'synthetic-sample');
  assert.match(synthetic.identity.find(row => row.field === 'works').label, /虚构 works 字段/);
});

test('unparseable or invalid summaries remain literal and do not obtain values from the recorded score', () => {
  for (const [index, text] of [[0, 'ORCID 有；主领域 Unknown 占 101%'], [1, '未核验撤稿情况'], [2, '开放获取 -50%'], [2, '开放获取 101%'], [3, 'FWCI 中位数 NaN'], [4, '单年作品很多']]) {
    const record = normalized(0); record.dims[index] = { ...record.dims[index], evidence: text };
    const model = evidence.createModel(record, options); const dim = model.dimensions[index];
    assert.equal(dim.summaryParsed, false, text); assert.equal(dim.inputRows.some(row => row.status === 'summary'), false, text);
    assert.equal(dim.score, record.dims[index].value); assert.equal(dim.evidence, text);
    assert.ok(dim.inputRows.some(row => row.value.includes('未解析')));
  }
  const record = normalized(2); const model = evidence.createModel(record, options);
  assert.equal(model.dimensions[2].inputRows.find(row => row.status === 'summary').value, '54%');
  assert.equal(model.dimensions[2].inputRows.some(row => row.value === '85' || row.value === '86'), false, 'do not invent an integer from 158 × 54%');
});

test('candidate has identity and provenance only; synthetic scope has no external source URL', () => {
  const candidate = { id: 'A123', name: 'Candidate', works: 0, orcid: null, sourceUrl: 'javascript:bad', institutions: ['University'] };
  const model = evidence.createModel(candidate, options);
  assert.equal(model.kind, 'candidate'); assert.deepEqual(model.dimensions, []); assert.equal(model.ruleVersion, null);
  assert.equal(model.authorUrl, null); assert.equal(model.snapshotHref, 'search-data.json');
  assert.equal(model.identity.find(row => row.field === 'orcid').status, 'raw');
  const synthetic = evidence.createModel(normalized(3), options);
  assert.equal(synthetic.synthetic, true); assert.equal(synthetic.authorUrl, null);
  assert.ok(synthetic.dimensions.every(dim => dim.currentUrl === null));
});

test('building evidence preserves both JSON snapshots, scores, rule payload and deterministic receipt hashes', async () => {
  const files = ['../../aia/product/mock_cases.json', '../search-data.json'];
  const beforeFiles = files.map(file => fs.readFileSync(path.join(__dirname, file), 'utf8'));
  const beforeRules = core.canonicalJSON(core.RULES);
  for (let index = 0; index < cases.cases.length; index += 1) {
    const record = normalized(index); const beforeRecord = JSON.stringify(record);
    const receiptBefore = await core.createReceipt(record, { now: '2026-10-07T03:00:00.000Z' });
    const model = evidence.createModel(record, options);
    assert.deepEqual(model.dimensions.map(dim => dim.score), record.dims.map(dim => dim.value));
    assert.equal(JSON.stringify(record), beforeRecord);
    assert.equal(core.canonicalJSON(core.RULES), beforeRules);
    const receiptAfter = await core.createReceipt(record, { now: '2026-10-07T03:00:00.000Z' });
    assert.deepEqual(receiptAfter, receiptBefore);
  }
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')), beforeFiles);
  assert.deepEqual(cases.cases.map((_, index) => normalized(index).score), [70, 78, 83, 9]);
});
