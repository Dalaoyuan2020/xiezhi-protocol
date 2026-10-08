'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '..', 'claim-experience.js');
const experience = fs.existsSync(file) ? require(file) : {};
function harness(reducedMotion = false) {
  assert.equal(typeof experience.createPlayer, 'function', '需要实现独立播放控制器');
  let time = 0, serial = 0;
  const timers = new Map();
  const changes = [];
  const player = experience.createPlayer({ reducedMotion, now: () => time,
    setTimeout(fn, delay) { const id = ++serial; timers.set(id, { at: time + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); }, onChange(state) { changes.push(state); }
  });
  return { player, changes, timers, advance(ms) {
    const end = time + ms;
    let next;
    while ((next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]) && next[1].at <= end) {
      time = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    time = end;
  } };
}

test('菜单事件与直接点击重复打开时，不重置分镜、不建立第二条播放计时器', () => {
  const { player, timers, changes, advance } = harness();
  assert.equal(player.open(), true);
  assert.equal(timers.size, 1);
  advance(experience.frames[0].duration + 100);
  const before = player.getState();
  const count = changes.length;
  assert.equal(before.index, 1);
  assert.equal(player.open(), false);
  assert.equal(player.getState().index, 1);
  assert.equal(changes.length, count);
  assert.equal(timers.size, 1);
});

test('暂停不丢失剩余时间，继续只有一个计时器，关闭后不再播放', () => {
  const { player, timers, advance } = harness();
  player.open(); advance(2000); player.pause();
  assert.equal(timers.size, 0);
  advance(20000); assert.equal(player.getState().index, 0);
  player.resume(); player.resume(); assert.equal(timers.size, 1);
  advance(experience.frames[0].duration - 2001); assert.equal(player.getState().index, 0);
  advance(1); assert.equal(player.getState().index, 1);
  player.close(); assert.equal(timers.size, 0);
  advance(30000); assert.equal(player.getState().open, false);
});

test('上一步下一步暂停自动播放，重播从第一幕开始且所有幕都能播放到结尾', () => {
  const { player, timers, advance } = harness();
  player.open(); player.next();
  assert.equal(player.getState().index, 1);
  assert.equal(player.getState().playing, false);
  player.previous(); player.previous(); assert.equal(player.getState().index, 0);
  player.replay(); advance(1000000);
  assert.equal(player.getState().index, experience.frames.length - 1);
  assert.equal(player.getState().playing, false);
  assert.equal(timers.size, 0);
  player.replay(); assert.equal(player.getState().index, 0);
  assert.equal(timers.size, 1);
});

test('reduced motion 初始静止，仍可逐幕操作，运行中开启会暂停自动播放', () => {
  const { player, timers } = harness(true);
  player.open(); assert.equal(player.getState().playing, false);
  assert.equal(timers.size, 0);
  player.next(); assert.equal(player.getState().index, 1);
  player.resume(); assert.equal(timers.size, 1);
  player.setReducedMotion(true); assert.equal(timers.size, 0);
  player.replay(); assert.equal(player.getState().playing, false);
});
