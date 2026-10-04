import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { parseHTML } from 'linkedom';

const [html, source] = await Promise.all([
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/app.js', import.meta.url), 'utf8')
]);
const clone = value => JSON.parse(JSON.stringify(value));

async function browser() {
  const { window, document } = parseHTML(html), location = { hash: '#read/A' }, callbacks = [], calls = [];
  const article = { id: 'A', title: 'Fixture article', text: 'A planet follows an orbit.\n\nThe orbit surrounds a star.',
    wordCount: 12, hasText: true, messages: [], quizzes: [], paragraph: 0 };
  const state = { token: 'fixture', words: [], decks: [], articles: [article], jobs: [], memory: null,
    settings: {}, connection: {}, modelCatalog: { models: [] }, selections: [], directions: { items: [] } };
  let selection = null;
  window.getSelection = () => selection;
  window.scrollTo = () => {};
  window.matchMedia = () => ({ matches: true, addEventListener() {} });
  Object.assign(window.HTMLElement.prototype, {
    showModal() { this.setAttribute('open', ''); }, close() { this.removeAttribute('open'); }, scrollIntoView() {}
  });
  Object.defineProperty(window.HTMLElement.prototype, 'open', { configurable: true, get() { return this.hasAttribute('open'); } });
  const context = createContext({ document, window, location, URL, AbortController,
    history: { replaceState(_s, _t, hash) { location.hash = hash; } },
    localStorage: { getItem() { return null; }, setItem() {} },
    requestAnimationFrame: callback => callback(), IntersectionObserver: class { observe() {} disconnect() {} },
    setTimeout(callback, delay) { if (delay === 0) callbacks.push(callback); return 1; }, clearTimeout() {},
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET' }); let value;
      if (url === '/api/bootstrap' || url === '/api/state') value = state;
      else if (url === '/api/articles/A') value = article;
      else if (url === '/api/articles/A/visit') value = { startedAt: '2026-10-04T00:00:00Z' };
      else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => clone(value) };
    }
  });
  runInContext(source, context, { filename: 'public/app.js' }); await setImmediate();
  const query = selector => { const el = document.querySelector(selector); assert.ok(el, `Missing: ${selector}`); return el; };
  return { query, calls,
    select(text) { const paragraph = query('[data-paragraph="0"]'); selection = { rangeCount: 1, isCollapsed: false,
      anchorNode: paragraph.firstChild, focusNode: paragraph.firstChild, toString: () => text }; },
    async event(selector, type, key) {
      const event = new window.Event(type, { bubbles: true, cancelable: true }); if (key) event.key = key;
      query(selector).dispatchEvent(event); while (callbacks.length) callbacks.shift()(); await setImmediate();
    }
  };
}

test('a retained native selection does not reopen the mobile assistant after Escape', async () => {
  const app = await browser(); app.select('A planet follows an orbit.');
  await app.event('[data-paragraph="0"]', 'pointerup');
  assert.equal(app.query('#assistant-sheet').open, true);
  await app.event('#assistant-sheet', 'cancel');
  await app.event('#reader-assistant-toggle', 'keyup', 'Escape');
  assert.equal(app.query('#assistant-sheet').open, false);
  await app.event('[data-paragraph="0"]', 'keyup', 'Escape');
  assert.equal(app.query('#assistant-sheet').open, false, 'Escape must not turn into a fresh text selection');
  await app.event('#reader-assistant-toggle', 'click');
  assert.match(app.query('#selection-area').textContent, /A planet follows an orbit/);
});

test('close-button pointerup cannot recapture the retained selection, while a new article selection still opens it', async () => {
  const app = await browser(); app.select('A planet');
  await app.event('[data-paragraph="0"]', 'keyup', 'ArrowRight');
  assert.equal(app.query('#assistant-sheet').open, true);
  await app.event('#close-reading-assistant', 'pointerup');
  await app.event('#close-reading-assistant', 'click');
  assert.equal(app.query('#assistant-sheet').open, false);
  await app.event('#reader-assistant-toggle', 'pointerup');
  assert.equal(app.query('#assistant-sheet').open, false);
  app.select('follows an orbit.');
  await app.event('[data-paragraph="0"]', 'pointerup');
  assert.equal(app.query('#assistant-sheet').open, true);
  assert.match(app.query('#selection-area').textContent, /follows an orbit/);
  assert.equal(app.calls.some(call => call.url === '/api/jobs'), false);
});
