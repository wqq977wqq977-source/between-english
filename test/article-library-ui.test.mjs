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
function fixture(count) {
  const articles = Array.from({ length: count }, (_, index) => ({
    id: `a${index + 1}`, title: index === count - 1 ? 'Hidden garden' : `Reading ${String(index + 1).padStart(2, '0')}`,
    summary: index === count - 2 ? '跨页文章摘要' : 'A short reading about everyday discoveries.',
    source: 'Example library', url: '', hasText: true, wordCount: 300, level: 'B2', paragraph: 0,
    saved: index < 13, ...(index % 3 === 1 ? { startedAt: '2026-10-01T10:00:00.000Z' } : {}), completed: index % 3 === 2
  }));
  return {
    token: 'fixture-token', words: [], decks: [], articles, jobs: [], memory: null,
    selections: [
      { id: 'first', prompt: 'First set', createdAt: '2026-10-01', articles: { requested: true, status: 'ready', count: 8, articleIds: articles.slice(0, 8).map(a => a.id) } },
      { id: 'second', prompt: 'Second set', createdAt: '2026-10-02', articles: { requested: true, status: 'ready', count: 9, articleIds: articles.slice(8, 17).map(a => a.id) } }
    ],
    directions: { personalized: false, items: [], note: '' }, connection: { authenticated: true },
    settings: { model: 'fixture', tutorProvider: 'codex' }, modelCatalog: { models: [], fetchedAt: null }
  };
}
async function browser({ count = 25, hash = '#reading' } = {}) {
  const { window, document } = parseHTML(html), state = fixture(count), calls = [], unexpected = [];
  const location = { hash }, storage = new Map();
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const context = createContext({
    document, window, location, URL, AbortController,
    history: { replaceState(_state, _title, hash) { location.hash = hash; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    setTimeout: () => 1, clearTimeout: () => {}, requestAnimationFrame: callback => callback(),
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ url, body, method: options.method || 'GET' });
      let value;
      if (url === '/api/bootstrap' || url === '/api/state') value = state;
      else if (/^\/api\/articles\/a\d+$/.test(url) && options.method === 'POST') {
        value = state.articles.find(article => article.id === url.split('/').at(-1));
        Object.assign(value, body);
      } else { unexpected.push(url); throw new Error(`Unexpected request: ${url}`); }
      return { ok: true, json: async () => clone(value) };
    }
  });
  runInContext(source, context, { filename: 'public/app.js' });
  await setImmediate();
  const query = selector => { const el = document.querySelector(selector); assert.ok(el, `Missing ${selector}: ${document.body.textContent}`); return el; };
  const emit = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  query('.shell');
  return {
    state, calls, document, query,
    ids: () => [...document.querySelectorAll('.article-card [data-action="open-article"]')].map(el => el.dataset.id),
    async click(selector) { emit(query(selector), 'click'); await setImmediate(); },
    async input(value) { const el = query('#article-library-query'); el.value = value; emit(el, 'input'); await setImmediate(); },
    async status(value) {
      const el = query('#article-library-status');
      for (const option of el.options) option.toggleAttribute('selected', option.value === value);
      emit(el, 'change'); await setImmediate();
    },
    assertReadOnly() { assert.deepEqual(unexpected, []); assert.equal(calls.filter(call => call.method !== 'GET').length, 0); },
    assertExpectedRequests() { assert.deepEqual(unexpected, []); }
  };
}

test('article shelf pages six at a time and searches every title, summary, and source locally', async () => {
  const app = await browser();
  assert.deepEqual(app.ids(), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  await app.click('[data-action="article-page-next"]');
  assert.equal(app.ids()[0], 'a7');
  await app.input('  HIDDEN GARDEN  ');
  assert.deepEqual(app.ids(), ['a25']);
  await app.input('跨页文章');
  assert.deepEqual(app.ids(), ['a24']);
  await app.input('EXAMPLE LIBRARY');
  assert.equal(app.ids().length, 6);
  await app.input('no match');
  assert.deepEqual(app.ids(), []);
  await app.click('[data-library-action="clear"]');
  assert.equal(app.query('#article-library-query').value, '');
  assert.equal(app.ids()[0], 'a1');
  app.assertReadOnly();
});

test('read state distinguishes downloaded text from an explicit visit and completion', async () => {
  const app = await browser();
  assert.equal(app.query('[data-action="open-article"][data-id="a1"]').textContent, '开始阅读');
  assert.equal(app.query('[data-action="open-article"][data-id="a2"]').textContent, '继续阅读');
  assert.equal(app.query('[data-action="open-article"][data-id="a3"]').textContent, '重新阅读');
  for (const [status, remainder] of [['unread', 1], ['reading', 2], ['completed', 0]]) {
    await app.status(status);
    assert.equal(app.ids().length, 6);
    assert.ok(app.ids().every(id => Number(id.slice(1)) % 3 === remainder));
    await app.click('[data-action="article-page-next"]');
    assert.ok(app.ids().every(id => Number(id.slice(1)) % 3 === remainder));
  }
  app.assertReadOnly();
});

test('saved shelf keeps independent browsing state and clamps pages after removing its last item', async () => {
  const app = await browser();
  await app.input('Reading');
  await app.click('[data-action="article-page-next"]');
  const findIds = app.ids();
  await app.click('[data-read-tab="saved"]');
  assert.equal(app.query('#article-library-query').value, '');
  await app.click('[data-action="article-page-next"]');
  await app.click('[data-action="article-page-next"]');
  assert.deepEqual(app.ids(), ['a13']);
  await app.click('[data-action="save-article"][data-id="a13"]');
  assert.deepEqual(app.ids(), ['a7', 'a8', 'a9', 'a10', 'a11', 'a12']);
  assert.equal(app.query('[data-action="article-page-next"]').disabled, true);
  await app.click('[data-read-tab="find"]');
  assert.equal(app.query('#article-library-query').value, 'Reading');
  assert.deepEqual(app.ids(), findIds);
  await app.click('[data-read-tab="saved"]');
  assert.equal(app.ids()[0], 'a7');
  assert.deepEqual(app.calls.filter(call => call.method === 'POST'), [{ url: '/api/articles/a13', method: 'POST', body: { saved: false } }]);
  app.assertExpectedRequests();
});

test('curation results stay scoped and a new selection resets prior local filters and pagination', async () => {
  const app = await browser({ hash: '#reading/selection/first' });
  assert.match(app.query('.section-head').textContent, /本次选材/);
  await app.click('[data-action="article-page-next"]');
  assert.deepEqual(app.ids(), ['a7', 'a8']);
  await app.input('Reading 01');
  assert.deepEqual(app.ids(), ['a1']);
  await app.click('[data-nav="curate"]');
  await app.click('[data-action="selection-articles"][data-id="second"]');
  assert.deepEqual(app.ids(), ['a9', 'a10', 'a11', 'a12', 'a13', 'a14']);
  assert.equal(app.query('#article-library-query').value, '');
  await app.click('[data-library-action="all"]');
  assert.match(app.query('.section-head').textContent, /阅读书架/);
  assert.deepEqual(app.ids(), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  app.assertReadOnly();
});

test('legacy paragraph progress remains readable as in progress without requiring memory history', async () => {
  const app = await browser({ count: 3 });
  app.state.articles[0].paragraph = 2;
  await app.click('[data-nav="curate"]');
  await app.click('[data-nav="reading"]');
  await app.status('reading');
  assert.deepEqual(app.ids(), ['a1', 'a2']);
  app.assertReadOnly();
});
