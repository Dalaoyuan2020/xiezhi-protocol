'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { documentDouble } = require('./helpers/reader-dom.cjs');
const core = require('../checkup-core.js');
const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, '../search-data.json'), 'utf8'));
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, '../../aia/product/mock_cases.json'), 'utf8'));

function component(options = {}) {
  const dom = documentDouble();
  let frames = 0;
  const frameCallbacks = new Map();
  const tokens = ['#a53528', '#8a6c42', '#44634a', '#75606c', '#805c21'];
  const events = new Map();
  const media = { matches: (options.width || 390) >= 1280, listeners: new Set(),
    addEventListener(_, callback) { this.listeners.add(callback); }, removeEventListener(_, callback) { this.listeners.delete(callback); } };
  const window = { innerWidth: options.width || 390, ScholarCheckupCore: core,
    requestAnimationFrame(callback) { const id = ++frames; frameCallbacks.set(id, callback); return id; },
    cancelAnimationFrame(id) { frameCallbacks.delete(id); },
    getComputedStyle: () => ({ getPropertyValue: key => tokens[Number(key.slice(-1)) - 1] || '' }),
    addEventListener(type, callback) { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(callback); },
    removeEventListener(type, callback) { events.get(type)?.delete(callback); },
    dispatchEvent(event) { events.get(event.type)?.forEach(callback => callback(event)); } };
  if (!options.noMatchMedia) window.matchMedia = query => query.includes('min-width') ? media : { matches: options.reducedMotion !== false };
  const context = vm.createContext({ window, document: dom.document, URL, Intl });
  for (const file of ['evidence-core.js', 'checkup-card.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../' + file), 'utf8'), context);
  return { ...dom, window, context, api: window.ScholarCheckupCard, frames: () => frames, tokens, media,
    advanceFrame(time) { const callbacks = Array.from(frameCallbacks.values()); frameCallbacks.clear(); callbacks.forEach(callback => callback(time)); },
    setWidth(width) { window.innerWidth = width; media.matches = width >= 1280; media.listeners.forEach(callback => callback({ matches: media.matches })); events.get('resize')?.forEach(callback => callback()); } };
}
function panel(root) { return root.querySelector('[data-reader-evidence]'); }
function selector(root) { return root.querySelector('[data-reader-evidence-dimension]'); }
function scored(view, index = 0) {
  const root = view.node('card'); const record = core.normalizeCase(cases.cases[index], cases);
  return { root, record, instance: view.api.mount(root, record) };
}

test('animated graphs show the actual total in text and ARIA from mount through intermediate frames and replay', () => {
  const view = component({ reducedMotion: false }); const { root, record, instance } = scored(view);
  const before = JSON.stringify(record);
  const value = root.querySelector('.sc-card__score-value');
  const line = root.querySelector('.sc-card__score-line');
  const gauge = root.querySelector('.sc-card__gauge-progress');
  function finalScore() {
    assert.equal(value.textContent, String(record.score));
    assert.equal(line.getAttribute('aria-label'), '公开记录可核查度 ' + record.score + ' 分，满分 100');
  }
  assert.ok(view.frames() > 0); finalScore();
  const initialArc = gauge.getAttribute('stroke-dasharray');
  view.advanceFrame(0); view.advanceFrame(400); finalScore();
  assert.notEqual(gauge.getAttribute('stroke-dasharray'), initialArc, 'only the graph progresses through the animation');
  view.advanceFrame(1300); finalScore();
  const replay = root.querySelectorAll('button').find(button => button.textContent === '↻ 重播图形');
  assert.ok(replay); assert.match(replay.title, /不改变得分或状态/); assert.equal(replay.title.includes('数字'), false);
  replay.dispatch('click'); finalScore();
  view.advanceFrame(2000); view.advanceFrame(2350); finalScore();
  instance.replay(); finalScore();
  assert.equal(JSON.stringify(record), before);
});

test('unscored candidate shares the panel and preserves provenance and affiliations without a score', () => {
  const view = component(); const root = view.node('candidate');
  const candidate = snapshot.candidates.find(item => item.id === 'A5111337086');
  const before = JSON.stringify(candidate);
  view.api.mountCandidateEvidence(root, candidate, { generated: snapshot.generated });
  const trigger = root.querySelector('[data-reader-evidence-open="candidate"]');
  trigger.focus(); trigger.dispatch('click');
  const dialog = panel(root);
  assert.equal(dialog.tagName, 'DIALOG'); assert.equal(dialog.open, true);
  assert.equal(dialog.dataset.presentation, 'modal');
  for (const text of ['A5111337086', '2026-10-07', 'Shanghai Jiao Tong University', 'Hohai University', '本人报告', '没有这位候选的完整五维评分']) assert.ok(dialog.textContent.includes(text), text);
  assert.equal(root.querySelectorAll('.sc-card__dialog-score').length, 0);
  assert.equal(root.querySelectorAll('.sc-card__gauge').length, 0);
  assert.equal(selector(dialog), null);
  const source = dialog.querySelector('[data-evidence-source="current"]');
  assert.equal(source.href, candidate.sourceUrl); assert.equal(source.target, '_blank'); assert.equal(source.rel, 'noopener noreferrer');
  assert.equal(dialog.querySelector('[data-evidence-source="snapshot"]').href, 'search-data.json');
  assert.equal(dialog.style.getPropertyValue('--dimension-color'), view.tokens[0]);
  dialog.querySelector('[data-reader-evidence-close]').dispatch('click');
  assert.equal(panel(root), null); assert.equal(view.document.activeElement, trigger);
  assert.equal(trigger.lastFocusOptions.preventScroll, true); assert.equal(JSON.stringify(candidate), before);
});

test('candidate rejects a mismatched current-source URL; Escape and modal backdrop restore valid focus', () => {
  const view = component(); const root = view.node('candidate');
  view.api.mountCandidateEvidence(root, { id: 'A123', name: 'Name', sourceUrl: 'https://api.openalex.org/authors/A999' });
  const trigger = root.querySelector('[data-reader-evidence-open="candidate"]'); trigger.dispatch('click');
  let dialog = panel(root);
  assert.equal(dialog.querySelector('[data-evidence-source="current"]'), null);
  assert.equal(dialog.dispatch('cancel').defaultPrevented, true); assert.equal(view.document.activeElement, trigger);
  trigger.dispatch('click'); dialog = panel(root); dialog.dispatch('click', { clientX: 0, clientY: 0 });
  assert.equal(panel(root), null); assert.equal(view.document.activeElement, trigger);
});

test('desktop uses a real non-modal aside, reserves its own column, and leaves the profile interactive', () => {
  const view = component({ width: 1280 }); const { root, record, instance } = scored(view);
  assert.equal(view.frames(), 0); assert.equal(root.querySelector('.sc-card__score-value').textContent, String(record.score));
  const triggers = root.querySelectorAll('.sc-card__dimension'); triggers[2].dispatch('click');
  const aside = panel(root);
  assert.equal(aside.tagName, 'ASIDE'); assert.equal(aside.dataset.presentation, 'side'); assert.equal(aside.getAttribute('role'), 'complementary');
  assert.equal(aside.getAttribute('aria-modal'), null); assert.equal(root.querySelector('dialog[open]'), null);
  assert.equal(root.dataset.readerEvidenceLayout, 'side'); assert.ok(root.querySelector('.sc-evidence-primary'));
  assert.equal(root.hasAttribute('inert'), false); assert.equal(view.document.body.hasAttribute('inert'), false);
  triggers[4].dispatch('click'); // A background dimension remains actionable while the aside is open.
  assert.equal(panel(root), aside); assert.equal(selector(aside).value, '4'); assert.match(aside.textContent, /单年峰值/);
  assert.equal(aside.style.getPropertyValue('--dimension-color'), view.tokens[4]);
  instance.replay(); assert.equal(root.querySelector('.sc-card__score-value').textContent, String(record.score));
  triggers[4].focus();
  view.window.dispatchEvent({ type: 'keydown', key: 'Escape', target: triggers[4], preventDefault() {} });
  assert.equal(panel(root), null); assert.equal(root.querySelector('.sc-evidence-primary'), null);
  assert.equal(view.document.activeElement, triggers[4]); assert.equal(root.dataset.readerEvidenceLayout, undefined);
});

test('select and keyboard navigation synchronize dimension highlights and preserve per-dimension reading anchors', () => {
  const view = component(); const { root, record } = scored(view); const before = JSON.stringify(record);
  const dimensions = root.querySelectorAll('.sc-card__dimension'); dimensions[2].dispatch('click');
  let dialog = panel(root); let select = selector(dialog);
  dialog.querySelector('.sc-card__dialog-content').scrollTop = 521;
  select.value = '3'; select.dispatch('change');
  assert.ok(dimensions[3].className.includes('is-active')); assert.ok(!dimensions[2].className.includes('is-active'));
  assert.equal(dialog.style.getPropertyValue('--dimension-color'), view.tokens[3]);
  dialog.querySelector('.sc-card__dialog-content').scrollTop = 241;
  select.value = '2'; select.dispatch('change');
  assert.equal(dialog.querySelector('.sc-card__dialog-content').scrollTop, 521);
  dialog.dispatch('keydown', { key: 'ArrowRight' }); assert.equal(select.value, '3');
  assert.equal(dialog.querySelector('.sc-card__dialog-content').scrollTop, 241);
  assert.equal(dialog.dispatch('keydown', { key: 'ArrowRight', target: select }).defaultPrevented, false, 'native select arrow keys are not intercepted');
  dialog.querySelector('[data-reader-evidence-close]').dispatch('click');
  assert.equal(view.document.activeElement, dimensions[2]);
  root.querySelector('[data-reader-evidence-open="score"]').dispatch('click');
  dialog = panel(root); select = selector(dialog);
  assert.equal(select.value, '3'); assert.equal(dialog.querySelector('.sc-card__dialog-content').scrollTop, 241);
  assert.equal(JSON.stringify(record), before);
});

test('crossing 1280px changes semantic containers while keeping the selected dimension, scroll and meaningful focus', () => {
  const view = component({ width: 1440 }); const { root } = scored(view);
  root.querySelectorAll('.sc-card__dimension')[1].dispatch('click');
  const aside = panel(root); const select = selector(aside); select.focus();
  aside.querySelector('.sc-card__dialog-content').scrollTop = 320;
  view.setWidth(1279);
  const modal = panel(root);
  assert.equal(aside.isConnected, false); assert.equal(modal.tagName, 'DIALOG'); assert.equal(modal.open, true);
  assert.equal(modal.dataset.presentation, 'modal'); assert.equal(modal.getAttribute('aria-modal'), 'true');
  assert.equal(selector(modal), select); assert.equal(select.value, '1'); assert.equal(view.document.activeElement, select);
  assert.equal(modal.querySelector('.sc-card__dialog-content').scrollTop, 320);
  view.setWidth(1280);
  assert.equal(panel(root).tagName, 'ASIDE'); assert.equal(modal.isConnected, false); assert.equal(modal.open, false);
  assert.equal(view.document.activeElement, select); assert.equal(selector(panel(root)).value, '1');
  panel(root).dispatch('keydown', { key: 'Escape' });
  assert.equal(panel(root), null); assert.equal(view.media.listeners.size, 0);
});

test('modal transition moves focus inside when the user was working in the desktop profile, and hidden triggers never receive restored focus', () => {
  const view = component({ width: 1440 }); const { root, instance } = scored(view);
  const trigger = root.querySelector('[data-reader-evidence-open="score"]'); trigger.dispatch('click'); trigger.focus();
  view.setWidth(800);
  assert.equal(view.document.activeElement, panel(root).querySelector('[data-reader-evidence-close]'));
  root.hidden = true; const close = view.document.activeElement; close.dispatch('click');
  assert.notEqual(view.document.activeElement, trigger);
  root.hidden = false; trigger.dispatch('click'); instance.dismissEvidence(false); root.hidden = true;
  assert.equal(panel(root), null);
});

test('absence of matchMedia is supported and resizing still changes panel presentation', () => {
  const view = component({ width: 1600, noMatchMedia: true }); const { root } = scored(view);
  root.querySelector('[data-reader-evidence-open="score"]').dispatch('click'); assert.equal(panel(root).tagName, 'ASIDE');
  view.setWidth(390); assert.equal(panel(root).tagName, 'DIALOG');
  panel(root).querySelector('[data-reader-evidence-close]').dispatch('click'); assert.equal(panel(root), null);
});

test('candidate aside can bind the whole profile; destroy removes the panel and listeners without stealing focus', () => {
  const view = component({ width: 1440 }); const host = view.node('candidate-profile');
  const heading = view.document.createElement('h2'); heading.textContent = 'Candidate';
  const root = view.document.createElement('div'); host.append(heading, root);
  const instance = view.api.mountCandidateEvidence(root, { id: 'A123', name: 'Name' }, { layoutHost: host });
  const trigger = root.querySelector('[data-reader-evidence-open="candidate"]'); trigger.dispatch('click');
  assert.equal(panel(host).tagName, 'ASIDE'); assert.equal(host.dataset.readerEvidenceLayout, 'side');
  assert.ok(host.querySelector('.sc-evidence-primary').children.includes(heading));
  instance.destroy(); assert.equal(panel(host), null); assert.equal(host.querySelector('.sc-evidence-primary'), null);
  assert.equal(trigger.isConnected, false); assert.equal(view.media.listeners.size, 0);
  trigger.dispatch('click'); assert.equal(root.children.length, 0);
});

for (const width of [1440, 390]) test('real detail controller exposes exactly one visible profile after switching at ' + width + 'px and keeps its cached session', () => {
  const view = component({ width }); const ids = [
    'sc-cases','sc-load-state','sc-file-fallback','sc-route-notice','sc-retry-data','sc-present','sc-card-panel','sc-receipt-panel',
    'sc-tab-card','sc-tab-receipt','sc-announcer','reader-back','sc-chain-mode','sc-candidate','sc-local-receipt','sc-card-root',
    'sc-receipt-root','sc-actions-root','sc-chain-root','sc-record-label','sc-subject-org','sc-workspace','sc-snapshot-date','sc-data-file'
  ];
  ids.forEach(id => view.node(id, id.startsWith('sc-tab') ? 'button' : 'div'));
  const byId = id => view.document.getElementById(id);
  const visible = node => {
    for (let current = node; current; current = current.parentNode) if (current.hidden) return false;
    return node.isConnected;
  };
  // Recreate the live page's nesting, including the tabpanel and profile-specific card roots.
  // These are actual Node relations, rather than flat mocks of lifecycle callbacks.
  const main = view.node('checkup-main', 'main');
  main.append(byId('sc-cases'), byId('sc-candidate'), byId('sc-workspace'));
  byId('sc-workspace').append(byId('sc-tab-card'), byId('sc-tab-receipt'), byId('sc-card-panel'), byId('sc-receipt-panel'));
  byId('sc-card-panel').append(byId('sc-card-root'), byId('sc-actions-root'));
  byId('sc-receipt-panel').append(byId('sc-chain-root'), byId('sc-local-receipt'));
  byId('sc-local-receipt').append(byId('sc-receipt-root'));
  const status = view.document.createElement('span'); byId('sc-chain-mode').append(status);
  byId('sc-chain-mode').querySelector = () => status;
  const stub = { mount() { return { update() {}, destroy() {}, openClaim() {} }; } };
  view.window.ScholarCheckupReceipt = stub; view.window.ScholarCheckupActions = stub; view.window.ScholarCheckupChain = stub;
  const location = { protocol: 'file:', href: 'file:///ui/checkup.html', search: '' };
  Object.assign(view.context, { location, history: { state: null, replaceState() {} }, URLSearchParams, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../checkup.js'), 'utf8'), view.context);
  view.window.ScholarCheckup.loadDataset(cases);
  const cardRoot = byId('sc-card-root');
  const oldCase = cardRoot.children[0]; const oldCard = oldCase.querySelector('.sc-card');
  const oldTrigger = cardRoot.querySelector('[data-reader-evidence-open="score"]');
  oldTrigger.dispatch('click'); const oldPanel = panel(cardRoot);
  assert.equal(oldPanel.dataset.profileId, 'A5126602136');
  selector(oldPanel).value = '2'; selector(oldPanel).dispatch('change');
  oldPanel.querySelector('.sc-card__dialog-content').scrollTop = 382;
  byId('sc-cases').querySelector('[data-case-id="A5009290031"]').dispatch('click');
  assert.equal(oldPanel.isConnected, false); assert.equal(panel(cardRoot), null);
  assert.equal(oldCase.parentNode, cardRoot); assert.equal(oldCase.isConnected, true);
  assert.equal(oldCase.hidden, true); assert.equal(visible(oldCase), false);
  assert.equal(oldCard.parentNode, oldCase, 'releasing the aside wrapper retains ownership by the old case');
  assert.equal(oldCard.isConnected, true); assert.equal(visible(oldCard), false);
  assert.equal(cardRoot.children.length, 2, 'both component roots remain cached');
  const visibleCards = cardRoot.querySelectorAll('.sc-card').filter(visible);
  assert.equal(visibleCards.length, 1); assert.equal(visibleCards[0].textContent.includes('Zhiyuan Lv'), false);
  assert.equal(view.document.querySelectorAll('[data-reader-evidence-open="score"]').filter(visible).length, 1);
  const newCase = cardRoot.children.find(node => node.dataset.caseId === 'A5009290031'); assert.equal(visible(newCase), true);
  newCase.querySelector('[data-reader-evidence-open="score"]').dispatch('click'); const nextPanel = panel(newCase);
  assert.equal(nextPanel.dataset.profileId, 'A5009290031');
  byId('sc-cases').querySelector('[data-case-id="A5126602136"]').dispatch('click');
  assert.equal(nextPanel.isConnected, false); assert.equal(newCase.isConnected, true); assert.equal(visible(newCase), false);
  assert.equal(cardRoot.children.length, 2); assert.equal(cardRoot.children[0], oldCase); assert.equal(visible(oldCase), true);
  assert.equal(oldCase.querySelector('.sc-card'), oldCard, 'the cached card instance is revealed without resetting it');
  assert.equal(view.document.querySelectorAll('[data-reader-evidence-open="score"]').filter(visible).length, 1);
  oldTrigger.dispatch('click');
  assert.equal(panel(oldCase).dataset.profileId, 'A5126602136');
  assert.equal(selector(panel(oldCase)).value, '2');
  assert.equal(panel(oldCase).querySelector('.sc-card__dialog-content').scrollTop, 382);
  view.window.ScholarCheckup.showView('receipt'); assert.equal(panel(cardRoot), null);
  assert.equal(cardRoot.querySelectorAll('.sc-card').filter(visible).length, 0);
  assert.equal(view.window.ScholarCheckup.getSelected().id, 'A5126602136');
});
