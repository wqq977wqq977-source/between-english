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
const wordName = index => `word${String(index).padStart(3, '0')}`;

function fixture({ count = 123, savedCount = 21, deckCount = 18 } = {}) {
  const words = Array.from({ length: count }, (_, index) => ({
    id: `w${index + 1}`, word: wordName(index + 1), meaning: index === count - 1 ? '跨页中文释义' : `词义 ${index + 1}`,
    phonetic: '', partOfSpeech: 'n.', definition: `Definition ${index + 1}`, level: 'B2',
    saved: index < savedCount,
    ...(index % 4 ? { review: { rating: ['new', 'known', 'fuzzy', 'unknown'][index % 4], dueAt: '2099-01-01T00:00:00.000Z' } } : {})
  }));
  const decks = Array.from({ length: deckCount }, (_, index) => ({
    id: `deck${index + 1}`, title: index === deckCount - 1 ? 'Weekend science' : `Learning set ${index + 1}`,
    wordIds: index === 0 ? words.map(word => word.id) : words.slice(index, index + 3).map(word => word.id),
    filters: { topic: `topic ${index}`, level: 'B2' },
    progress: { index: 0, finished: false }, createdAt: '2026-10-03T01:00:00.000Z'
  }));
  if (decks.length > 1) {
    words.push({ id: 'unique', word: 'nebula', meaning: '星云', saved: false, level: 'B2' });
    decks.at(-1).wordIds = ['unique'];
  }
  return {
    token: 'fixture-token', words, decks, articles: [], jobs: [], memory: null, selections: [],
    directions: { personalized: false, items: [], note: '' },
    connection: { authenticated: true, version: 'fixture' },
    settings: { model: 'fixture', tutorProvider: 'codex', lastDeck: decks[0]?.id },
    modelCatalog: { models: [], fetchedAt: null }
  };
}

// Run the actual SPA. The fixture stands in only for HTTP, storage, and browser APIs.
async function browser(options = {}) {
  const { window, document } = parseHTML(html);
  const state = fixture(options), calls = [], unexpected = [], storage = new Map();
  const location = { hash: '#words' };
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.showModal = function () { this.open = true; this.setAttribute('open', ''); };
  window.HTMLElement.prototype.close = function () { this.open = false; this.removeAttribute('open'); };
  const context = createContext({
    document, window, location, URL, AbortController,
    history: { replaceState(_state, _title, url) { location.hash = url; } },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    setTimeout: () => 1, clearTimeout: () => {}, requestAnimationFrame: callback => callback(),
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ url, body, method: options.method || 'GET' });
      let value;
      if (url === '/api/bootstrap' || url === '/api/state') value = state;
      else if (url === '/api/decks/review' && options.method === 'POST') {
        value = {
          id: 'saved-review', title: '收藏词复习', wordIds: state.words.filter(word => word.saved).map(word => word.id),
          progress: { index: 0, finished: false }, createdAt: '2026-10-03T02:00:00.000Z'
        };
        state.decks.unshift(value);
      } else if (/^\/api\/decks\/[^/]+$/.test(url) && options.method === 'POST') {
        value = state.decks.find(deck => deck.id === decodeURIComponent(url.split('/').at(-1)));
        assert.ok(value, `Unknown deck mutation: ${url}`);
        Object.assign(value, body);
      } else if (/^\/api\/words\/[^/]+$/.test(url) && options.method === 'POST') {
        value = state.words.find(word => word.id === decodeURIComponent(url.split('/').at(-1)));
        assert.ok(value, `Unknown word mutation: ${url}`);
        Object.assign(value, body);
      } else {
        unexpected.push(url);
        throw new Error(`Unexpected request: ${url}`);
      }
      return { ok: true, json: async () => clone(value) };
    }
  });
  runInContext(source, context, { filename: 'public/app.js' });
  await setImmediate();
  const query = selector => {
    const el = document.querySelector(selector);
    assert.ok(el, `Missing visible control: ${selector}`);
    return el;
  };
  const event = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  assert.ok(document.querySelector('.shell'), document.querySelector('#app').textContent);
  return {
    document, state, calls, location, query,
    rows: () => [...document.querySelectorAll('.word-table tbody tr')],
    names: () => [...document.querySelectorAll('.word-table tbody .english')].map(el => el.textContent),
    decks: () => [...document.querySelectorAll('#deck-results [data-action="choose-deck"]')],
    async click(selector) { event(query(selector), 'click'); await setImmediate(); },
    async input(selector, value) { const el = query(selector); el.value = value; event(el, 'input'); await setImmediate(); },
    async choose(selector, value) {
      const el = query(selector), option = [...el.options].find(option => option.value === value);
      assert.ok(option, `Missing selectable value: ${value}`);
      for (const item of el.options) item.removeAttribute('selected');
      option.setAttribute('selected', '');
      Object.defineProperty(el, 'form', { value: el.closest('form'), configurable: true });
      event(el, 'input'); event(el, 'change'); await setImmediate();
    },
    assertNoUnexpectedRequests() { assert.deepEqual(unexpected, [], 'Browsing must not invoke a model or learning-event endpoint'); }
  };
}

test('large word collections render one page and search English or Chinese across the entire collection', async () => {
  const app = await browser();
  assert.equal(app.rows().length, 10);
  assert.deepEqual(app.names(), Array.from({ length: 10 }, (_, index) => wordName(index + 1)));
  assert.equal(app.query('[data-action="word-page-prev"]').disabled, true);
  await app.click('[data-action="word-page-next"]');
  assert.equal(app.names()[0], 'word011');
  await app.choose('#word-list-page-size', '50');
  assert.equal(app.rows().length, 50);
  await app.choose('#word-list-page-size', '20');
  assert.equal(app.rows().length, 20);
  await app.input('#word-list-query', '  WORD123  ');
  assert.deepEqual(app.names(), ['word123']);
  await app.input('#word-list-query', '跨页中文');
  assert.deepEqual(app.names(), ['word123']);
  await app.input('#word-list-query', 'no-matching-word');
  assert.equal(app.rows().length, 0);
  await app.click('[data-action="clear-word-query"]');
  assert.equal(app.query('#word-list-query').value, '');
  assert.equal(app.rows().length, 20);
  app.assertNoUnexpectedRequests();
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 0);
});

test('status filters cover all words, and filtered browsing does not shrink the study deck', async () => {
  const app = await browser();
  for (const [status, offset] of [['new', 0], ['known', 1], ['fuzzy', 2], ['unknown', 3]]) {
    await app.choose('#word-list-status', status);
    assert.equal(app.rows().length, 10);
    assert.ok(app.names().every(name => (Number(name.slice(4)) - 1) % 4 === offset));
    await app.click('[data-action="word-page-next"]');
    assert.ok(app.names().every(name => (Number(name.slice(4)) - 1) % 4 === offset));
  }
  await app.choose('#word-list-status', 'all');
  await app.input('#word-list-query', 'word123');
  assert.deepEqual(app.names(), ['word123']);
  await app.click('[data-action="start-study"]');
  assert.equal(app.query('.progress-track progress').getAttribute('max'), '123');
  assert.equal(app.query('.flashcard h2').textContent, 'word001');
  assert.equal(app.state.decks[0].wordIds.length, 123);
  assert.deepEqual(app.state.decks[0].progress, { index: 0, finished: false });
  app.assertNoUnexpectedRequests();
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 0);
});

test('current-list and saved-word browsing keep independent query, status, page, and page size', async () => {
  const app = await browser();
  await app.choose('#word-list-page-size', '20');
  await app.choose('#word-list-status', 'fuzzy');
  await app.click('[data-action="word-page-next"]');
  const findNames = app.names();
  await app.click('[data-word-tab="saved"]');
  assert.equal(app.query('#word-list-page-size').value, '10');
  assert.equal(app.query('#word-list-status').value, 'all');
  assert.equal(app.rows().length, 10);
  await app.input('#word-list-query', 'word021');
  assert.deepEqual(app.names(), ['word021']);
  await app.click('[data-word-tab="find"]');
  assert.deepEqual(app.names(), findNames);
  assert.equal(app.query('#word-list-page-size').value, '20');
  assert.equal(app.query('#word-list-status').value, 'fuzzy');
  assert.equal(app.query('#word-list-query').value, '');
  await app.click('[data-word-tab="saved"]');
  assert.equal(app.query('#word-list-query').value, 'word021');
  assert.deepEqual(app.names(), ['word021']);
  app.assertNoUnexpectedRequests();
});

test('removing the only row on a last page clamps to the previous valid page', async () => {
  const app = await browser({ count: 11, savedCount: 0, deckCount: 1 });
  await app.click('[data-action="word-page-next"]');
  assert.deepEqual(app.names(), ['word011']);
  await app.click('[data-action="remove-word"][data-id="w11"]');
  assert.equal(app.rows().length, 10);
  assert.deepEqual(app.names(), Array.from({ length: 10 }, (_, index) => wordName(index + 1)));
  for (const action of ['word-page-prev', 'word-page-next']) {
    const button = app.document.querySelector(`[data-action="${action}"]`);
    assert.ok(!button || button.disabled, 'A one-page collection has no enabled pagination controls');
  }
  assert.equal(app.state.words.length, 11, 'Removing from a deck preserves the word record');
  assert.equal(app.state.decks[0].wordIds.length, 10);
  assert.deepEqual(app.calls.filter(call => call.method === 'POST').map(call => call.url), ['/api/decks/deck1']);
  app.assertNoUnexpectedRequests();
});

test('un-saving the only last-page word keeps the saved collection on a valid page', async () => {
  const app = await browser();
  await app.click('[data-word-tab="saved"]');
  await app.click('[data-action="word-page-next"]');
  await app.click('[data-action="word-page-next"]');
  assert.deepEqual(app.names(), ['word021']);
  await app.click('[data-action="save-word"][data-id="w21"]');
  assert.equal(app.rows().length, 10);
  assert.equal(app.names()[0], 'word011');
  assert.equal(app.query('[data-action="word-page-next"]').disabled, true);
  assert.equal(app.query('[data-action="word-page-prev"]').disabled, false);
  assert.equal(app.state.words.filter(word => word.saved).length, 20);
  assert.deepEqual(app.calls.filter(call => call.method === 'POST').map(call => call.url), ['/api/words/w21']);
  app.assertNoUnexpectedRequests();
});

test('starting saved-word review after searching includes the entire saved collection', async () => {
  const app = await browser();
  await app.click('[data-word-tab="saved"]');
  await app.input('#word-list-query', 'word021');
  assert.deepEqual(app.names(), ['word021']);
  await app.click('[data-action="study-saved"]');
  assert.equal(app.query('.progress-track progress').getAttribute('max'), '21');
  assert.equal(app.query('.flashcard h2').textContent, 'word001');
  assert.deepEqual(app.calls.filter(call => call.method === 'POST'), [{ url: '/api/decks/review', method: 'POST', body: { allSaved: true } }]);
  app.assertNoUnexpectedRequests();
});

test('deck library pages eight at a time, searches every deck, and selection resets the current-list browser only', async () => {
  const app = await browser();
  await app.click('[data-word-tab="saved"]');
  await app.input('#word-list-query', 'word021');
  await app.click('[data-word-tab="find"]');
  await app.input('#word-list-query', 'word');
  await app.click('[data-action="word-page-next"]');
  assert.equal(app.names()[0], 'word011');
  await app.click('[data-action="open-deck-library"]');
  assert.equal(app.query('#deck-dialog').open, true);
  await app.click('[data-action="close-deck-library"]');
  assert.equal(app.query('#deck-dialog').open, false);
  await app.click('[data-action="open-deck-library"]');
  assert.equal(app.decks().length, 8);
  await app.click('[data-action="deck-page-next"]');
  assert.equal(app.decks().length, 8);
  await app.click('[data-action="deck-page-next"]');
  assert.equal(app.decks().length, 2);
  assert.equal(app.query('[data-action="deck-page-next"]').disabled, true);
  await app.input('#deck-query', 'weekend SCIENCE');
  assert.deepEqual(app.decks().map(el => el.dataset.id), ['deck18']);
  await app.input('#deck-query', '  NEBULA  ');
  assert.deepEqual(app.decks().map(el => el.dataset.id), ['deck18']);
  await app.click('[data-action="choose-deck"][data-id="deck18"]');
  assert.equal(app.query('#deck-dialog').open, false);
  assert.equal(app.query('#word-list-query').value, '');
  assert.deepEqual(app.names(), ['nebula']);
  assert.equal(app.location.hash, '#words/deck/deck18');
  await app.click('[data-word-tab="saved"]');
  assert.equal(app.query('#word-list-query').value, 'word021');
  assert.deepEqual(app.names(), ['word021']);
  app.assertNoUnexpectedRequests();
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 0, 'Choosing a deck must not modify learning history');
});

test('word-search form starts compact for an existing library and stays discoverable for an empty library', async () => {
  const existing = await browser();
  assert.equal(existing.query('#word-search-details').hasAttribute('open'), false);
  const empty = await browser({ count: 0, savedCount: 0, deckCount: 0 });
  assert.equal(empty.query('#word-search-details').hasAttribute('open'), true);
  assert.ok(empty.query('#word-search'));
  empty.assertNoUnexpectedRequests();
});
