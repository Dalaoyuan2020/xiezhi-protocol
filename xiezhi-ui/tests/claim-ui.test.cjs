'use strict';
// Small DOM boundary double: no browser, layout engine, network or dependencies.
// The production render/event handlers run unchanged; geometry is supplied only
// to exercise the scene-fitting calculation, not to claim visual verification.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const experience = require('../claim-experience.js');
function environment() {
  const deferredClose = [], raf = [];
  let doc;
  const attrKey = name => name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.dataset = {}; this.events = {};
      this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; this._text = ''; this.className = ''; this.clientHeight = 210; this.scrollHeight = 260;
      this.style = { setProperty: (key, value) => { this.style[key] = value; }, getPropertyValue: key => this.style[key] };
      this.classList = { add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' ').trim(); }, remove: name => { this.className = this.className.split(' ').filter(x => x !== name).join(' '); }, contains: name => this.className.split(' ').includes(name) };
    }
    get isConnected() { return this === doc.documentElement || Boolean(this.parentNode && this.parentNode.isConnected); }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    append(...nodes) { for (const n of nodes) { n.parentNode = this; this.children.push(n); } }
    replaceChildren(...nodes) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = ''; this.append(...nodes); }
    setAttribute(key, value) { this.attrs[key] = String(value); if (key === 'id') this.id = value; if (key === 'class') this.className = value; if (key.startsWith('data-')) this.dataset[attrKey(key)] = String(value); }
    getAttribute(key) { return key.startsWith('data-') ? this.dataset[attrKey(key)] : this.attrs[key]; }
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
    fire(type, detail) { const event = { type, target: this, preventDefault() {}, ...detail }; for (const fn of this.events[type] || []) fn(event); }
    click() { if (!this.disabled) this.fire('click'); }
    focus() { doc.activeElement = this; }
    matches(selector) {
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
      if (attr) return this.getAttribute(attr[1]) !== undefined && (attr[2] === undefined || this.getAttribute(attr[1]) === attr[2]);
      return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) { const result = []; const walk = n => { for (const c of n.children) { if (c.matches(selector)) result.push(c); walk(c); } }; walk(this); return result; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentNode && this.parentNode.closest(selector); }
    showModal() { this.open = true; (this.querySelectorAll('button').find(b => b.autofocus) || this).focus(); }
    close() { this.open = false; deferredClose.push(() => this.fire('close')); }
    remove() { this.parentNode.children = this.parentNode.children.filter(n => n !== this); this.parentNode = null; }
  }
  doc = new Element('document');
  doc.documentElement = new Element('html'); doc.body = new Element('body'); doc.documentElement.append(doc.body);
  doc.createElement = tag => new Element(tag);
  doc.getElementById = id => doc.documentElement.querySelector('#' + id);
  doc.querySelectorAll = selector => doc.documentElement.querySelectorAll(selector);
  doc.activeElement = doc.body; doc.readyState = 'complete';
  const win = { location: { search: '?demo=1', href: 'https://app.test/reputation/claim.html?demo=1' }, matchMedia: () => ({ matches: true, addEventListener() {} }),
    addEventListener() {}, setInterval() { return 1; }, clearInterval() {}, setTimeout, clearTimeout,
    requestAnimationFrame(fn) { raf.push(fn); return raf.length; }, cancelAnimationFrame() {} };

  return { doc, win, flushClose() { while (deferredClose.length) deferredClose.shift()(); }, flushFit() { while (raf.length) raf.shift()(); } };
}

test('教程安装入口实际打开原生 dialog；重复事件保持场景，Esc 关闭并恢复触发器焦点', () => {
  const env = environment(); const { doc, win } = env;
  const trigger = doc.createElement('button'); trigger.setAttribute('data-claim-demo', ''); doc.body.append(trigger); trigger.focus();
  const api = experience.install(doc, win);
  doc.fire('click', { target: trigger });
  const dialog = doc.getElementById('claim-demo');
  assert.equal(dialog.open, true);
  dialog.querySelector('[data-demo-next]').click();
  const current = dialog.querySelector('#claim-demo-scene-title').textContent;
  doc.fire('claim-demo:open', { detail: { trigger } });
  assert.equal(dialog.querySelector('#claim-demo-scene-title').textContent, current);
  assert.equal(doc.querySelectorAll('dialog').length, 1);
  env.flushFit();
  assert.ok(Number(dialog.querySelector('.claim-demo-fit').style['--claim-scene-scale']) < 1);
  dialog.fire('cancel'); env.flushClose();
  assert.equal(dialog.open, false);
  assert.equal(doc.activeElement, trigger);
  assert.equal(doc.documentElement.classList.contains('claim-demo-open'), false);
  api.closeDemo();
});

test('暂停把动画状态传给 CSS，手动下一幕仍能执行入场动画', () => {
  const { doc, win, flushClose } = environment();
  const api = experience.install(doc, win); const dialog = api.openDemo();
  const play = dialog.querySelector('[data-demo-play]');
  play.click();
  assert.equal(dialog.dataset.motionPaused, 'true');
  dialog.querySelector('[data-demo-next]').click();
  assert.equal(dialog.dataset.motionPaused, 'false');
  assert.equal(dialog.dataset.playing, 'false');
  api.closeDemo(); flushClose();
});

test('关闭后立即重新打开不会被旧 close 事件清除页面锁和播放状态', () => {
  const { doc, win, flushClose } = environment();
  const api = experience.install(doc, win);
  api.openDemo(); api.closeDemo(); const dialog = api.openDemo(); flushClose();
  assert.equal(dialog.open, true);
  assert.equal(doc.documentElement.classList.contains('claim-demo-open'), true);
  dialog.querySelector('[data-demo-next]').click();
  assert.match(dialog.querySelector('#claim-demo-scene-title').textContent, /机构档案/);
  api.closeDemo(); flushClose();
});

test('十一幕均渲染有材料说明、正文和可访问文字印章，不需要远程数据', () => {
  const { doc, win, flushClose } = environment();
  const api = experience.install(doc, win); const dialog = api.openDemo();
  for (let i = 0; i < experience.frames.length; i++) {
    const expectedStep = i <= 4 ? '1' : i <= 8 ? '2' : '3';
    const activeStep = dialog.querySelectorAll('[data-demo-step]').find(n => n.getAttribute('aria-current') === 'step');
    assert.equal(activeStep.dataset.demoStep, expectedStep, '逐篇核对应仍属第一步，邮箱校验为第二步');
    assert.ok(dialog.querySelector('.claim-demo-material').textContent.length > 5);
    assert.ok(dialog.querySelector('.claim-demo-art').textContent.length > 10);
    if (i === experience.frames.length - 1) {
      assert.equal(dialog.querySelector('.claim-seal').textContent, '灋廌覈鑒');
      assert.match(dialog.querySelector('.claim-demo-art').textContent, /非真实认证/);
    } else dialog.querySelector('[data-demo-next]').click();
  }
  api.closeDemo(); flushClose();
});

test('跨页面引导的亲手操作和无 dialog 回退使用 main 认领入口且保留 network', () => {
  for (const pathname of ['/workspace/', '/animations/demo.html']) {
    const { doc, win, flushClose } = environment();
    win.location.href = 'https://app.test' + pathname + '?network=testnet';
    win.location.search = '?network=testnet';
    doc.currentScript = { src: 'https://app.test/reputation/claim-experience.js?v=1' };
    const api = experience.install(doc, win);
    const dialog = api.openDemo();
    assert.equal(dialog.querySelector('[data-demo-try]').href, '/live/?demo=claim-xu&network=testnet');
    api.closeDemo(); flushClose();
    dialog.showModal = undefined;
    api.openDemo();
    assert.equal(win.location.href, '/live/?demo=claim-xu&network=testnet');
  }
});

test('首次访问自动打开一次教程；已看过、?guide=0 或存储不可用时不自动打开', async () => {
  const store = new Map();
  const storage = { getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)) };
  const wait = () => new Promise(resolve => setTimeout(resolve, 450));
  const visit = (search, localStorage) => {
    const env = environment();
    env.win.location.search = search; env.win.location.href = 'https://app.test/reputation/index.html' + search;
    if (localStorage !== undefined) env.win.localStorage = localStorage;
    const api = experience.install(env.doc, env.win);
    return { ...env, api, opened: () => Boolean(env.doc.getElementById('claim-demo') && env.doc.getElementById('claim-demo').open) };
  };
  const first = visit('', storage); await wait();
  assert.equal(first.opened(), true);
  first.api.closeDemo(); first.flushClose();
  const again = visit('', storage); await wait();
  assert.equal(again.opened(), false);
  const forced = visit('?guide=1', storage); await wait();
  assert.equal(forced.opened(), true);
  forced.api.closeDemo(); forced.flushClose();
  const skipped = visit('?guide=0', { getItem: () => null, setItem() {} }); await wait();
  assert.equal(skipped.opened(), false);
  const blocked = visit('', { getItem() { throw new Error('blocked'); }, setItem() {} }); await wait();
  assert.equal(blocked.opened(), false);
});

test('实时认领页即使 guide=1 也不自动打断；没有存储时仍可手动打开并恢复焦点', async () => {
  for (const pathname of ['/live/', '/live/index.html', '/workbench/live/']) {
    const { doc, win } = environment();
    let scheduled = 0;
    win.location.href = 'https://app.test' + pathname + '?guide=1';
    win.location.search = '?guide=1';
    win.setTimeout = () => { scheduled++; };
    win.localStorage = { getItem: () => null, setItem() {} };
    experience.install(doc, win);
    assert.equal(scheduled, 0);
  }
  const { doc, win, flushClose } = environment();
  let scheduled = 0;
  win.location.href = 'https://app.test/ui/?guide=1'; win.location.search = '?guide=1';
  win.setTimeout = () => { scheduled++; };
  win.localStorage = { getItem() { throw new Error('blocked'); } };
  const api = experience.install(doc, win);
  assert.equal(scheduled, 0);
  const trigger = doc.createElement('button'); doc.body.append(trigger); trigger.focus();
  const dialog = api.openDemo(trigger);
  assert.equal(dialog.open, true);
  assert.equal(dialog.dataset.playing, 'true', 'OS reduced-motion setting does not suppress the requested product animation');
  assert.equal(dialog.querySelector('.claim-demo-brand').href, '/ui/');
  assert.deepEqual(dialog.querySelector('.claim-demo-nav').children.map(node => node.href), ['/ui/', '/ui/papers.html']);
  api.closeDemo(); flushClose(); assert.equal(doc.activeElement, trigger);
});

test('首次自动打开等待期间手动打开并关闭，不会在稍后再次弹出', () => {
  const { doc, win, flushClose } = environment();
  const pending = new Map();
  win.location.href = 'https://app.test/ui/'; win.location.search = '';
  win.localStorage = { getItem: () => null, setItem() {} };
  win.setTimeout = fn => { pending.set(1, fn); return 1; };
  win.clearTimeout = id => pending.delete(id);
  const api = experience.install(doc, win);
  assert.equal(pending.size, 1);
  api.openDemo(); api.closeDemo(); flushClose();
  assert.equal(pending.size, 0);
  assert.equal(doc.getElementById('claim-demo').open, false);
});
