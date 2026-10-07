'use strict';
// A narrow DOM double executes the actual component's event and lifecycle code; it does not reimplement navigation.
function documentDouble() {
  const ids = new Map();
  const document = { referrer: '', activeElement: null, listeners: {} };
  class Node {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.dataset = {}; this.attributes = new Map();
      this.style = { values: new Map(), setProperty(key, value) { this.values.set(key, value); }, getPropertyValue(key) { return this.values.get(key) || ''; } };
      this.listeners = {}; this.className = ''; this._text = ''; this.hidden = false; this.value = ''; this.open = false;
      this.classList = { add: value => { this.className = [this.className, value].filter(Boolean).join(' '); }, toggle: (value, force) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        const add = force === undefined ? !classes.has(value) : force;
        if (add) classes.add(value); else classes.delete(value);
        this.className = [...classes].join(' ');
      } };
    }
    set textContent(value) { this._text = String(value); this.children.forEach(node => { node.parentNode = null; }); this.children = []; }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    set id(value) { this._id = value; ids.set(value, this); }
    get id() { return this._id || ''; }
    get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
    append(...nodes) { nodes.forEach(node => { if (node.parentNode) node.remove(); this.children.push(node); node.parentNode = this; }); }
    replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
    remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; } }
    setAttribute(key, value) {
      this.attributes.set(key, String(value));
      if (key === 'id') this.id = value;
      if (key === 'class') this.className = value;
      if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    }
    getAttribute(key) { return this.attributes.get(key) || null; }
    hasAttribute(key) { return this.attributes.has(key); }
    removeAttribute(key) { this.attributes.delete(key); }
    addEventListener(type, listener) { (this.listeners[type] ||= new Set()).add(listener); }
    removeEventListener(type, listener) { this.listeners[type]?.delete(listener); }
    dispatch(type, extra = {}) {
      const event = { target: this, currentTarget: this, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
      [...(this.listeners[type] || [])].forEach(listener => listener(event));
      return event;
    }
    focus(options) { document.activeElement = this; this.lastFocusOptions = options; }
    scrollIntoView(options) { this.lastScrollOptions = options; }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatch('close'); }
    getBoundingClientRect() { return { left: 10, top: 10, right: 500, bottom: 500 }; }
    matches(selector) {
      if (selector === 'article') return this.tagName === 'ARTICLE';
      if (selector === 'button') return this.tagName === 'BUTTON';
      if (selector === 'dialog[open]') return this.tagName === 'DIALOG' && this.open;
      if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
      const match = /^(?:([a-z]+))?\[data-([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
      if (!match || (match[1] && this.tagName !== match[1].toUpperCase())) return false;
      const key = match[2].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      return Object.prototype.hasOwnProperty.call(this.dataset, key) && (match[3] === undefined || this.dataset[key] === match[3]);
    }
    closest(selector) { let node = this; while (node) { if (node.matches(selector)) return node; node = node.parentNode; } return null; }
    querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  document.body = new Node('body');
  document.documentElement = new Node('html');
  document.documentElement.append(document.body);
  document.createElement = tag => new Node(tag);
  document.createElementNS = (_, tag) => new Node(tag);
  document.createTextNode = value => { const node = new Node('#text'); node.textContent = value; return node; };
  document.getElementById = id => ids.get(id) || null;
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  document.querySelector = selector => document.body.querySelector(selector);
  document.addEventListener = (type, callback) => { (document.listeners[type] ||= []).push(callback); };
  return { document, node(id, tag = 'div') { const node = document.createElement(tag); if (id) node.id = id; document.body.append(node); return node; } };
}
module.exports = { documentDouble };
