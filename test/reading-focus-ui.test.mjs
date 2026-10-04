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
async function browser({ mobile = false, completedB = false, storage = new Map() } = {}) {
  const { window, document } = parseHTML(html), location = { hash: '#read/A' }, polls = [], calls = [];
  const articles = Object.fromEntries(['A', 'B'].map(id => [id, {
    id, title: `Article ${id}`, text: 'A planet follows an orbit.\n\nAn orbit is a path around another object.',
    wordCount: 14, hasText: true, paragraph: 0, completed: false, quizzes: [],
    messages: [{ id: `${id}-first`, role: 'assistant', text: `A previous answer for ${id}.` }]
  }]));
  if(completedB)Object.assign(articles.B,{completed:true,paragraph:1});
  const state = { token: 'fixture', words: [], decks: [], articles: Object.values(articles), jobs: [], memory: null,
    settings: { tutorProvider: 'codex' }, connection: { authenticated: true },
    modelCatalog: { models: [] }, directions: { items: [] }, selections: [] };
  const offsets = new WeakMap();
  let visitGate=null,releaseVisit=null;
  window.scrollTo = () => {};
  window.getSelection = () => null;
  window.matchMedia = () => ({ matches: mobile, addEventListener() {} });
  Object.assign(window.HTMLElement.prototype, {
    getBoundingClientRect() { return {top:this.id==='para-1'?500:100}; },
    scrollIntoView() {}, showModal() { this.setAttribute('open', ''); }, close() { this.removeAttribute('open'); }
  });
  Object.defineProperties(window.HTMLElement.prototype, {
    open: { configurable: true, get() { return this.hasAttribute('open'); } },
    clientHeight: { configurable: true, get() { return this.closest('[hidden]') || this.closest('dialog:not([open])') ? 0 : 200; } },
    scrollHeight: { configurable: true, get() { return this.matches('.assistant-body') ? 800 + this.querySelectorAll('.message').length * 200 : 1800; } },
    scrollTop: { configurable: true, get() { return offsets.get(this) || 0; }, set(top) { offsets.set(this, Math.max(0, Math.min(Number(top) || 0, this.scrollHeight - this.clientHeight))); } }
  });
  const context = createContext({ document, window, location, URL, AbortController,
    history: { replaceState(_s, _t, hash) { location.hash = hash; } },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    IntersectionObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: callback => callback(),
    setTimeout(callback, delay) { if (delay === 1400) polls.push(callback); return 1; }, clearTimeout() {},
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, body }); let value;
      if (url === '/api/bootstrap' || url === '/api/state') value = state;
      else if (/^\/api\/articles\/[AB]\/visit$/.test(url)) { if(visitGate)await visitGate;value = { startedAt: '2026-10-04T00:00:00Z' }; }
      else if (/^\/api\/articles\/[AB]$/.test(url)) value = articles[url.split('/').at(-1)];
      else if (url === '/api/jobs') { value = { id: `job-${calls.length}`, type: body.type, status: 'running', params: body.params }; state.jobs = [value]; }
      else if (url.startsWith('/api/jobs/')) value = state.jobs[0];
      else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => clone(value) };
    }
  });
  runInContext(source, context, { filename: 'public/app.js' }); await setImmediate();
  const query = selector => { const el = document.querySelector(selector); assert.ok(el, `Missing: ${selector}`); return el; };
  const event = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  return { document, articles, calls, storage, query,
    holdVisit(){visitGate=new Promise(resolve=>{releaseVisit=resolve;});},
    async releaseVisit(){releaseVisit();await setImmediate();},
    async click(selector) { event(query(selector), 'click'); await setImmediate(); },
    async input(selector, value) { const el = query(selector); el.value = value; event(el, 'input'); await setImmediate(); },
    async submitQuestion() { await this.input('#compose', 'Please explain the main point.'); event(query('#chat-form'), 'submit'); await setImmediate(); },
    scroll(top) { const body = query('.assistant-body'); body.scrollTop = top; event(body, 'scroll'); },
    async answer() { const id = state.jobs[0].params.articleId; articles[id].messages.push({ id: `${id}-${calls.length}`, role: 'assistant', text: 'A new reply.' }); Object.assign(state.jobs[0], { status: 'completed', result: { articleId: id } }); polls.shift()(); await setImmediate(); },
    async escape() { event(query('#assistant-sheet'), 'cancel'); await setImmediate(); }
  };
}

test('new answers follow the bottom when the reader is already there', async () => {
  const app = await browser(); await app.submitQuestion(); await app.answer();
  const body = app.query('.assistant-body');
  assert.equal(body.scrollTop, body.scrollHeight - body.clientHeight);
  assert.equal(app.query('#new-chat-reply').hidden, true);
});

test('new answers preserve an older reading position and can be opened explicitly', async () => {
  const app = await browser(); await app.submitQuestion(); app.scroll(75); await app.answer();
  assert.equal(app.query('.assistant-body').scrollTop, 75);
  assert.equal(app.query('#new-chat-reply').hidden, false);
  await app.click('[data-action="latest-reply"]');
  const body = app.query('.assistant-body');
  assert.equal(body.scrollTop, body.scrollHeight - body.clientHeight);
  assert.equal(app.query('#new-chat-reply').hidden, true);
});

test('chat position belongs to its article and survives returning from the shelf', async () => {
  const app = await browser(); app.scroll(90);
  await app.click('[data-action="back-library"]'); await app.click('[data-action="open-article"][data-id="B"]');
  assert.notEqual(app.query('.assistant-body').scrollTop, 90);
  app.scroll(130); await app.click('[data-action="back-library"]'); await app.click('[data-action="open-article"][data-id="A"]');
  assert.equal(app.query('.assistant-body').scrollTop, 90);
});

test('focus mode keeps the reader position and exposes incoming replies without reopening the panel', async () => {
  const app = await browser(); await app.submitQuestion();
  app.query('.reader').scrollTop = 160; await app.click('[data-action="toggle-assistant"]'); await app.answer();
  assert.equal(app.query('#reading-assistant').hidden, true);
  assert.equal(app.query('.reader').scrollTop, 160);
  assert.equal(app.query('#reader-assistant-toggle').textContent, '有新回复 ↓');
  await app.click('#reader-assistant-toggle');
  assert.equal(app.query('#reading-assistant').hidden, false);
  assert.equal(app.query('#new-chat-reply').hidden, true);
});

test('font size and focus preferences persist without changing the article or asking a model', async () => {
  const app = await browser(); await app.click('[data-action="reader-font-larger"]'); await app.click('[data-action="toggle-assistant"]');
  const next = await browser({ storage: app.storage });
  assert.ok(next.query('.reader').classList.contains('reader-font-1'));
  assert.equal(next.query('#reading-assistant').hidden, true);
  assert.equal(app.calls.some(call => call.url === '/api/jobs'), false);
});

test('rereading a completed article starts at the beginning and retains its completion history', async () => {
  const app=await browser({completedB:true});
  await app.click('[data-action="back-library"]');await app.click('[data-action="open-article"][data-id="B"]');
  assert.equal(app.query('.reader').scrollTop,0);
  assert.equal(app.query('[data-action="finish-reading"]').textContent,'已读完 ✓');
  assert.equal(app.articles.B.completed,true);
});

test('a delayed visit refreshes reading status after returning to the shelf', async () => {
  const app=await browser();app.holdVisit();
  await app.click('[data-action="back-library"]');await app.click('[data-action="open-article"][data-id="B"]');
  await app.click('[data-action="back-library"]');
  assert.equal(app.query('[data-action="open-article"][data-id="B"]').textContent,'开始阅读');
  await app.releaseVisit();
  assert.equal(app.query('[data-action="open-article"][data-id="B"]').textContent,'继续阅读');
});

test('mobile selection opens the bottom sheet; Escape retains the selected text and draft', async () => {
  const app = await browser({ mobile: true });
  assert.equal(app.query('#assistant-sheet').open, false);
  await app.click('[data-paragraph="0"]');
  assert.equal(app.query('#assistant-sheet').open, true);
  assert.match(app.query('#selection-area').textContent, /A planet follows an orbit/);
  await app.input('#compose', 'Keep this draft.'); await app.escape();
  assert.equal(app.query('#assistant-sheet').open, false);
  assert.equal(app.document.body.classList.contains('assistant-sheet-open'), false);
  await app.click('#reader-assistant-toggle');
  assert.equal(app.query('#compose').value, 'Keep this draft.');
  assert.equal(app.calls.some(call => call.url === '/api/jobs'), false);
});
