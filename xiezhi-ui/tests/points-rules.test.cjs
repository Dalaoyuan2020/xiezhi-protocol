'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RULES, TIERS, tierOf, VERSION } = require('../points-rules.js');

test('one points-v0 policy is shared by the issuer CLI and browser without duplicate amounts', async () => {
  const issuer = await import('../../aia/chain/points.mjs');
  assert.equal(issuer.RULES, RULES);
  assert.equal(issuer.TIERS, TIERS);
  assert.equal(issuer.RULES_VERSION, VERSION);
  assert.equal(VERSION, 'points-v0');
  assert.deepEqual(Object.values(RULES).map(rule => (rule.kind === 'award' ? 1 : -1) * rule.amount), [20, 5, 3, 5, 8, 2, -10]);
  assert(Object.values(RULES).every(Object.isFrozen));
});

test('tiers respect both thresholds and do not treat missing or invalid scores as a funded service entitlement', () => {
  for (const [score, tier, cost] of [[0,'LOW',10],[59.9,'LOW',10],[60,'MID',0],[79.9,'MID',0],[80,'HIGH',0],[100,'HIGH',0]]) {
    assert.equal(tierOf(score).id, tier); assert.equal(tierOf(score).submitCost, cost);
    assert.equal(tierOf(score).canReview, score >= 80);
  }
  for (const score of [null,undefined,NaN,Infinity,-1,101,'80']) assert.equal(tierOf(score), null);
});
