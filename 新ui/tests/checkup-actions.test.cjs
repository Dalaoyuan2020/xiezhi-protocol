'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const actions = require('../checkup-actions.js');
const core = require('../checkup-core.js');
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../../aia/product/mock_cases.json'), 'utf8'));
const normalized = index => core.normalizeCase(data.cases[index], data);

test('75-point recommendation boundary leaves lower scores with concrete next actions', () => {
  const below = actions.deriveActions({ score: 74, confidence: '高' });
  const boundary = actions.deriveActions({ score: 75, confidence: '高' });
  assert.equal(below.recommendReviewer, false);
  assert.equal(below.showTasks, true);
  assert.equal(boundary.recommendReviewer, true);
  assert.equal(boundary.showTasks, false);
  assert.equal(actions.deriveActions({ score: 100, confidence: '高' }).recommendReviewer, true);
});

test('high scores with low confidence show both recommendation and verification tasks', () => {
  const result = actions.deriveActions({ score: 83, confidence: '低（论文少于 10 篇，仅供参考）' });
  assert.equal(result.recommendReviewer, true);
  assert.equal(result.showTasks, true);
  assert.equal(result.lowConfidence, true);
  assert.equal(actions.deriveActions({ score: 80, confidence: 'low' }).showTasks, true);
  assert.equal(actions.deriveActions({ score: 80, confidence: '低置信度' }).showTasks, true);
  assert.equal(actions.deriveActions({ score: 80, confidence: '中' }).showTasks, false);
});

test('repository cases use corrected public scores and do not grant contribution credit', () => {
  const models = data.cases.map((_, index) => actions.deriveActions(normalized(index)));
  assert.deepEqual(models.map(model => model.publicScore), [70, 78, 83, 9]);
  assert.deepEqual(models.map(model => model.recommendReviewer), [false, true, true, false]);
  assert.deepEqual(models.map(model => model.showTasks), [true, false, false, true]);
  assert.ok(models.every(model => model.creditedContributionPoints === 0));
  assert.equal(models[0].claimAvailable, true);
  assert.equal(models[1].claimAvailable, false);
  assert.equal(models[3].claimAvailable, false);
  assert.equal(models[3].claimStatus, 'synthetic');
});

test('local claim remains pending ORCID verification and does not increase either score', () => {
  const original = normalized(0);
  const claimed = core.recomputeAfterClaim(original);
  const after = actions.deriveActions(claimed);
  assert.equal(after.claimAvailable, false);
  assert.equal(after.claimPending, true);
  assert.equal(after.claimStatus, 'pending-orcid-verification');
  assert.equal(after.publicScore, 70);
  assert.equal(after.creditedContributionPoints, 0);
  assert.equal(claimed.localWorks, 3);
  assert.equal(claimed.works, 2);
  assert.equal(claimed.raw.score, 70);
});

test('contribution proposal is frozen, undeployed, and separate from the unchanged v0 snapshot', () => {
  const source = normalized(0);
  const before = JSON.stringify(source);
  const model = actions.deriveActions(source);
  assert.equal(JSON.stringify(source), before);
  assert.equal(model.contributionRule.version, 'contribution-demo-draft');
  assert.equal(model.contributionRule.deployed, false);
  assert.equal(model.contributionRule.separateFromPublicScore, true);
  assert.deepEqual([model.contributionRule.claim, model.contributionRule.references, model.contributionRule.reproduction], [5, 3, 8]);
  assert.equal(model.potentialContributionPoints, 16);
  assert.equal(model.publicScore, 70);
  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.contributionRule), true);
});

test('synthetic data cannot unlock identity claim even if supplied with misattribution fields', () => {
  const result = actions.deriveActions({ score: 9, confidence: '高', synthetic: true, misattributed: { paper: '演示记录' }, claimSimulation: true });
  assert.equal(result.claimAvailable, false);
  assert.equal(result.claimPending, false);
  assert.equal(result.claimStatus, 'synthetic');
  for (const bad of [null, {}, { score: NaN }, { score: -1 }, { score: 101 }, { score: '75' }]) {
    assert.throws(() => actions.deriveActions(bad), /0–100/);
  }
});
