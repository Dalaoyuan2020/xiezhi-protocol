'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../../role-drafts-core.js');
const coreScript = fs.readFileSync(path.join(__dirname, '../../role-drafts-core.js'), 'utf8');
const uiScript = fs.readFileSync(path.join(__dirname, '../../role-drafts.js'), 'utf8');
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.value = ''; this.textContent = ''; this.dataset = {}; this.hidden = false; this.children = []; this.listeners = {}; this.attrs = {}; this.focused = false; this.files = []; this.style = { setProperty() {} }; }
  addEventListener(kind, callback) { (this.listeners[kind] ||= []).push(callback); }
  async fire(kind, event = {}) { await Promise.all((this.listeners[kind] || []).map(callback => callback(event))); }
  click() { return this.fire('click'); }
  append(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  remove() { this.removed = true; }
  focus() { this.focused = true; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  getBoundingClientRect() { return { height: 116 }; }
  scrollIntoView() { this.scrolled = true; }
}
function memoryStorage(raw, role = 'submitter') {
  const data = new Map();
  if (raw !== undefined) data.set(core.storageKey(role), raw);
  return { data, getItem: key => data.has(key) ? data.get(key) : null, setItem: (key, value) => data.set(key, value) };
}
function locks() {
  const queues = new Map();
  const calls = [];
  return { calls, request(name, options, callback) {
    calls.push({ name, options });
    const previous = queues.get(name) || Promise.resolve();
    const next = previous.catch(() => {}).then(callback);
    queues.set(name, next); return next;
  } };
}
function setup(role, options = {}) {
  const prefix = role === 'reviewer' ? 'rv' : 'sb';
  const ids = new Map();
  const controls = ['form', 'status', 'storage-status', 'check-result', 'check-list', 'check-heading', 'check-summary', 'restore-confirm', 'restore-summary', 'restore-apply', 'restore-cancel', 'save-confirm', 'save-summary', 'save-apply', 'save-cancel', 'new-confirm', 'new-apply', 'new-cancel', 'import-preview', 'import-summary', 'import-fields', 'import-apply', 'import-cancel', 'import-file', 'import', 'entry', 'entry-summary', 'entry-continue', 'entry-new', 'save', 'restore', 'restore-backup', 'check', 'export', 'export-md', 'export-saved', 'export-saved-md', 'export-original', 'export-backup', 'new', 'required-count', 'live-check-list', 'references', 'more', 'more-actions', 'draft-toolbar', 'cite-p01', 'cite-p02', 'cite-p03', 'cite-p04', ...Object.keys(core.FIELDS[role]), ...Object.keys(core.FIELDS[role]).map(key => key + '-error')];
  for (const id of controls) ids.set(prefix + '-' + id, new Element());
  for (const id of ['restore-confirm', 'save-confirm', 'import-preview', 'new-confirm', 'entry', 'check-result']) ids.get(prefix + '-' + id).hidden = true;
  for (const key of Object.keys(core.FIELDS[role])) {
    ids.get(prefix + '-' + key + '-error').hidden = true;
    const help = role === 'submitter' && ['orcid', 'attachments'].includes(key) ? prefix + '-' + key + '-help ' : '';
    ids.get(prefix + '-' + key).setAttribute('aria-describedby', help + prefix + '-' + key + '-error');
  }
  const body = new Element('body'); body.dataset.section = role;
  const local = options.storage || memoryStorage(options.raw, role);
  const windowEvents = {};
  const downloads = [], blobs = [], timers = [];
  const win = { ScholarRoleDrafts: core, localStorage: local, navigator: { locks: options.noLocks ? undefined : (options.locks || locks()) }, setTimeout: callback => timers.push(callback), addEventListener: (kind, callback) => { (windowEvents[kind] ||= []).push(callback); } };
  if (options.storageGetterThrows) Object.defineProperty(win, 'localStorage', { get() { throw new Error('denied'); } });
  const doc = { body, getElementById: id => ids.get(id), createElement(tag) {
    const element = new Element(tag);
    if (tag === 'a') element.click = () => downloads.push({ filename: element.download, href: element.href });
    return element;
  } };
  const urls = { createObjectURL(blob) { blobs.push(blob); return 'blob:local-' + blobs.length; }, revokeObjectURL() {} };
  const context = vm.createContext({ window: win, document: doc, Blob, URL: urls, TextEncoder });
  vm.runInContext(coreScript, context, { filename: 'role-drafts-core.js' });
  win.ScholarRoleDrafts = context.ScholarRoleDrafts;
  vm.runInContext(uiScript, context, { filename: 'role-drafts.js' });
  const el = id => ids.get(prefix + '-' + id);
  return { el, downloads, blobs, data: local.data, storage: local, timers, locks: win.navigator.locks,
    edit(key, value) { el(key).value = value; void el('form').fire('input'); },
    leave() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; for (const callback of windowEvents.beforeunload) callback(event); return event; },
    async storageEvent(key = core.storageKey(role)) { await Promise.all((windowEvents.storage || []).map(callback => callback({ key }))); },
    async importText(text, details = {}) { const file = { size: new TextEncoder().encode(text).length, text: async () => text, ...details }; el('import-file').files = [file]; await el('import-file').fire('change'); return file; }
  };
}
module.exports = { Element, setup, memoryStorage, locks };
