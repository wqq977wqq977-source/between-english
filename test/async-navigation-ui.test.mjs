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
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const article = id => ({ id, title: `Article ${id}`, text: `This is article ${id}. Each article keeps its own question and answer.`, wordCount: 14, messages: [], quizzes: [], paragraph: 0, hasText: true });

// Run the shipped SPA with controlled HTTP and timers; fixtures never touch a service or model.
async function browser({ hash = '#read/A', jobs = [], emptyLibrary = false } = {}) {
  const { window, document } = parseHTML(html);
  const articles = { A: article('A'), B: article('B') }, calls = [], polls = [];
  const location = { hash }, storage = new Map(), articleGates = new Map();
  const controls = { postGate: null, postError: '' };
  const state = {
    token: 'fixture-token', words: [{ id: 'wa', word: 'alpha' }, { id: 'wb', word: 'beta' }],
    decks: ['A', 'B'].map(id => ({ id, title: `Deck ${id}`, wordIds: [id === 'A' ? 'wa' : 'wb'], filters: {}, progress: { index: 0, finished: false } })),
    articles: Object.values(articles), jobs: clone(jobs), memory: null, selections: [],
    settings: { lastDeck: 'A', tutorProvider: 'codex' }, connection: { authenticated: true },
    modelCatalog: { models: [], fetchedAt: null }, directions: { personalized: false, items: [], note: '' }
  };
  if (emptyLibrary) { state.decks = []; state.settings.lastDeck = ''; }
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.showModal = function () { this.open = true; };
  window.HTMLElement.prototype.close = function () { this.open = false; };
  const context = createContext({
    document, window, location, URL, AbortController,
    history: { replaceState(_state, _title, url) { location.hash = url; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    IntersectionObserver: class { observe() {} disconnect() {} },
    setTimeout(callback, delay) { if (delay === 1400) polls.push(callback); return 1; }, clearTimeout() {},
    requestAnimationFrame: callback => callback(),
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ url, body }); let value;
      if (url === '/api/bootstrap' || url === '/api/state') value = state;
      else if (url === '/api/jobs' && options.method === 'POST') {
        const gate = controls.postGate; controls.postGate = null;
        if (gate) await gate.promise;
        if (controls.postError) return { ok: false, json: async () => ({ error: controls.postError }) };
        value = { id: `job-${state.jobs.length + 1}`, type: body.type, status: 'running', progress: '处理中' };
        state.jobs.unshift(value);
      } else if (url.startsWith('/api/jobs/')) value = state.jobs.find(job => job.id === url.split('/').at(-1));
      else if (/^\/api\/articles\/[AB]\/visit$/.test(url)) value = { ok: true };
      else if (/^\/api\/articles\/[AB]$/.test(url)) {
        const id = url.split('/').at(-1); value = clone(articles[id]);
        const gate = articleGates.get(id); articleGates.delete(id);
        if (gate) await gate.promise;
      } else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => clone(value) };
    }
  });
  runInContext(source, context, { filename: 'public/app.js' }); await setImmediate();
  const query = selector => { const el = document.querySelector(selector); assert.ok(el, `Missing control: ${selector}`); return el; };
  const event = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  return {
    document, state, articles, calls, location, controls, query,
    async click(selector) { event(query(selector), 'click'); await setImmediate(); },
    async input(selector, value) { const el = query(selector); el.value = value; event(el, 'input'); await setImmediate(); },
    async submit(selector) { event(query(selector), 'submit'); await setImmediate(); },
    async open(id) { await this.click('[data-action="back-library"]'); await this.click(`[data-action="open-article"][data-id="${id}"]`); },
    holdArticle(id) { const gate = deferred(); articleGates.set(id, gate); return gate; },
    holdPost() { const gate = deferred(); controls.postGate = gate; return gate; },
    complete(result, id = state.jobs[0].id) { const job = state.jobs.find(job => job.id === id); Object.assign(job, { status: 'completed', result }); },
    async poll() { assert.ok(polls.length, 'Job polling is active'); polls.shift()(); await setImmediate(); },
    async chooseDeck(id) { await this.click('[data-action="open-deck-library"]'); await this.click(`[data-action="choose-deck"][data-id="${id}"]`); }
  };
}

async function submitQuestion(app, text = 'Question for A') {
  await app.input('#compose', text); await app.submit('#chat-form');
}
const answer = { id: 'answer-A', role: 'assistant', text: 'Answer for A', vocabulary: [], evidence: '' };

test('an old article response cannot overwrite another article or a later visit to the same article', async t => {
  for (const returnToA of [false, true]) await t.test(returnToA ? 'leave and return to A' : 'switch to B', async () => {
    const app = await browser(); await submitQuestion(app);
    app.articles.A.messages = [answer]; app.complete({ articleId: 'A' });
    const gate = app.holdArticle('A'); await app.poll();
    await app.open('B');
    if (returnToA) {
      app.articles.A.messages = [{ ...answer, text: 'Newer answer for A' }];
      await app.open('A');
    }
    gate.resolve(); await setImmediate();
    assert.equal(app.location.hash, returnToA ? '#read/A' : '#read/B');
    assert.equal(app.query('.reader h1').textContent, returnToA ? 'Article A' : 'Article B');
    assert.equal(app.document.querySelector('.message .text')?.textContent, returnToA ? 'Newer answer for A' : undefined);
  });
});

test('completed reading jobs still update the current article, including jobs restored on reload', async t => {
  for (const restored of [false, true]) await t.test(restored ? 'restored job' : 'submitted job', async () => {
    const app = await browser({ jobs: restored ? [{ id: 'restored', type: 'explain', status: 'running', progress: '处理中' }] : [] });
    if (!restored) await submitQuestion(app);
    app.articles.A.messages = [answer]; app.complete({ articleId: 'A' }); await app.poll();
    assert.equal(app.query('.reader h1').textContent, 'Article A');
    assert.equal(app.query('.message .text').textContent, 'Answer for A');
  });
});

test('a delayed question submission clears only its original draft and keeps another article draft', async () => {
  const app = await browser(), gate = app.holdPost(); await submitQuestion(app);
  await app.open('B'); await app.input('#compose', 'Unsent question for B');
  gate.resolve(); await setImmediate();
  assert.equal(app.query('#compose').value, 'Unsent question for B');
  await app.open('A'); assert.equal(app.query('#compose').value, '', 'The accepted question is not restored as an unsent draft');
  await app.open('B'); assert.equal(app.query('#compose').value, 'Unsent question for B');
});

test('a delayed question submission preserves later edits to the original article draft', async t => {
  for (const navigateAway of [false, true]) await t.test(navigateAway ? 'edited draft saved before navigation' : 'editing in place', async () => {
    const app = await browser(), gate = app.holdPost(); await submitQuestion(app);
    await app.input('#compose', 'Follow-up question for A');
    if (navigateAway) await app.open('B');
    gate.resolve(); await setImmediate();
    if (navigateAway) await app.open('A');
    assert.equal(app.query('#compose').value, 'Follow-up question for A');
  });
});

test('an unchanged submitted draft clears on success and survives an unsuccessful submission', async t => {
  for (const fail of [false, true]) await t.test(fail ? 'failure' : 'success', async () => {
    const app = await browser(), gate = app.holdPost();
    if (fail) app.controls.postError = 'Request failed';
    await submitQuestion(app); gate.resolve(); await setImmediate();
    assert.equal(app.query('#compose').value, fail ? 'Question for A' : '');
    await app.open('B'); await app.open('A');
    assert.equal(app.query('#compose').value, fail ? 'Question for A' : '');
  });
});

test('finishing a word task preserves a different deck or a later navigation back to its original deck', async t => {
  for (const returnToA of [false, true]) await t.test(returnToA ? 'leave and return to deck A' : 'switch to deck B', async () => {
    const app = await browser({ hash: '#words/deck/A' });
    if (returnToA) await app.submit('#word-search'); else await app.click('[data-action="replace-word"][data-id="wa"]');
    await app.chooseDeck('B');
    if (returnToA) await app.chooseDeck('A');
    app.complete({ deckId: returnToA ? 'B' : 'A', count: 1 }); await app.poll();
    assert.equal(app.location.hash, returnToA ? '#words/deck/A' : '#words/deck/B');
    assert.match(app.query('#deck-picker').getAttribute('title'), returnToA ? /Deck A/ : /Deck B/);
  });
});

test('a new word search displays its result when the learner stays on the original page', async () => {
  const app = await browser({ hash: '#words/deck/A' }); await app.submit('#word-search');
  app.complete({ deckId: 'B', count: 1 }); await app.poll();
  assert.equal(app.location.hash, '#words/deck/B'); assert.match(app.query('#deck-picker').getAttribute('title'), /Deck B/);
});

test('the first word search still opens its new deck after the library refresh', async () => {
  const app = await browser({ hash: '#words', emptyLibrary: true }); await app.submit('#word-search');
  app.state.decks = [{ id: 'first', title: 'First deck', wordIds: ['wa'], filters: {}, progress: { index: 0, finished: false } }];
  app.complete({ deckId: 'first', count: 1 }); await app.poll();
  assert.equal(app.location.hash, '#words/deck/first'); assert.match(app.query('#deck-picker').getAttribute('title'), /First deck/);
  assert.equal(app.query('#word-search-details').hasAttribute('open'), false);
});
