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

async function browser({ onlyOneWord = false } = {}) {
  const { window, document } = parseHTML(html), calls = [], location = { hash: '#words' };
  const words = [
    { id: 'word:habit', word: 'habit', meaning: '习惯', phonetic: '/ˈhæbɪt/', partOfSpeech: 'n.', level: 'B2', saved: false,
      definition: 'Something that you do often.', example: 'Reading is a daily habit.', exampleTranslation: '阅读是每天的习惯。',
      sourceUrl: 'https://example.com/habit', sourceTitle: 'Practice dictionary', exampleKind: 'generated' },
    { id: 'word:curious', word: 'curious', meaning: '好奇的', level: 'B2', saved: true,
      definition: '<b>Wanting to learn more.</b>', example: 'A curious reader asks <questions>.',
      exampleTranslation: '好奇的读者会提问。', exampleKind: 'original', articleTitle: 'A small habit', sourceUrl: '', sourceTitle: '' }
  ].slice(0, onlyOneWord ? 1 : 2);
  const state = {
    token: 'fixture', words,
    decks: [{ id: 'deck', title: 'Daily words', wordIds: words.map(word => word.id), filters: { level: 'B2' }, progress: { index: 0, finished: false } }],
    articles: [], jobs: [], memory: null, selections: [], directions: { items: [] },
    settings: { lastDeck: 'deck', tutorProvider: 'codex' }, connection: { authenticated: true }, modelCatalog: { models: [], fetchedAt: null }
  };
  let focused;
  Object.defineProperty(document, 'activeElement', { get: () => focused?.isConnected ? focused : document.body });
  window.HTMLElement.prototype.focus = function () { focused = this; };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 100, bottom: 140, right: 420, left: 380 });
  window.scrollTo = () => {};
  window.getSelection = () => null;
  const context = createContext({
    document, window, location, URL, AbortController,
    history: { replaceState(_state, _title, next) { location.hash = next; } },
    localStorage: { getItem: () => null, setItem() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: callback => callback(),
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ url, body, method: options.method || 'GET' });
      let value;
      if (url === '/api/bootstrap' || url === '/api/state') value = state;
      else if (url.startsWith('/api/words/') && options.method === 'POST') {
        value = state.words.find(word => word.id === decodeURIComponent(url.split('/').at(-1)));
        assert.ok(value); Object.assign(value, body);
      } else if (url === '/api/decks/deck' && options.method === 'POST') {
        value = state.decks[0]; Object.assign(value, body);
      } else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => clone(value) };
    }
  });
  runInContext(source, context, { filename: 'public/app.js' }); await setImmediate();
  const query = selector => {
    const el = document.querySelector(selector); assert.ok(el, `Missing element: ${selector}`); return el;
  };
  assert.ok(document.querySelector('.shell'), document.querySelector('#app').textContent);
  return { document, calls, state, query,
    async click(selector) { const el = query(selector); el.focus(); el.dispatchEvent(new window.Event('click', { bubbles: true })); await setImmediate(); },
    async key(selector, key) {
      const el = query(selector); el.focus(); const event = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperties(event, { key: { value: key }, code: { value: key } });
      el.dispatchEvent(event); await setImmediate(); return event;
    }
  };
}

const detail = word => `[data-word-detail="word:${word}"]`;
const more = word => `[data-word-menu="word-more-word%3A${word}"]`;
const menu = word => `[id="word-more-word%3A${word}"]`;

test('word rows stay compact and reveal escaped examples, translation and source in place', async () => {
  const app = await browser();
  assert.equal(app.document.querySelectorAll('.word-table tbody tr').length, 2);
  assert.equal(app.document.querySelector('.word-inline-details'), null);
  assert.equal(app.document.querySelector('.word-table .source'), null);
  assert.equal(app.query(detail('habit')).getAttribute('aria-expanded'), 'false');
  await app.click(detail('habit'));
  assert.equal(app.query(detail('habit')).getAttribute('aria-expanded'), 'true');
  const details = app.document.getElementById(app.query(detail('habit')).getAttribute('aria-controls'));
  assert.match(details.textContent, /Reading is a daily habit\./);
  assert.match(details.textContent, /阅读是每天的习惯/);
  assert.equal(details.querySelector('a').href, 'https://example.com/habit');
  assert.equal(app.document.activeElement, app.query(detail('habit')));
  await app.click(detail('curious'));
  assert.equal(app.query(detail('habit')).getAttribute('aria-expanded'), 'false');
  assert.equal(app.document.querySelectorAll('.word-inline-details').length, 1);
  assert.match(app.query('.word-inline-details').textContent, /<b>Wanting to learn more\.<\/b>/);
  assert.match(app.query('.word-inline-details').textContent, /原文例句.*A curious reader asks <questions>.*好奇的读者/s);
  assert.equal(app.document.querySelector('.word-inline-details b, .word-inline-details questions'), null);
  await app.click(detail('curious'));
  assert.equal(app.document.querySelector('.word-inline-details'), null);
  assert.ok(app.calls.every(call => call.method === 'GET'), 'Expanding stored words must not call a model or record learning');
});

test('save remains directly available and preserves the open word through the state refresh', async () => {
  const app = await browser(); await app.click(detail('habit'));
  const save = '[data-action="save-word"][data-id="word:habit"]';
  assert.equal(app.query(save).closest('[hidden]'), null);
  await app.click(save);
  assert.equal(app.query(save).getAttribute('aria-pressed'), 'true');
  assert.equal(app.query(detail('habit')).getAttribute('aria-expanded'), 'true');
  assert.match(app.query('.word-inline-details').textContent, /Reading is a daily habit/);
  assert.deepEqual(app.calls.filter(call => call.method === 'POST'), [{ url: '/api/words/word%3Ahabit', body: { saved: true }, method: 'POST' }]);
});

test('word action menu supports keyboard movement, Escape and outside dismissal', async () => {
  const app = await browser(), replace = `${menu('habit')} [data-action="replace-word"]`, remove = `${menu('habit')} [data-action="remove-word"]`;
  assert.equal(app.query(menu('habit')).hidden, true);
  await app.key(more('habit'), 'ArrowDown');
  assert.equal(app.query(menu('habit')).hidden, false);
  assert.equal(app.query(more('habit')).getAttribute('aria-expanded'), 'true');
  assert.equal(app.document.activeElement, app.query(replace));
  await app.key(replace, 'ArrowDown'); assert.equal(app.document.activeElement, app.query(remove));
  await app.key(remove, 'ArrowDown'); assert.equal(app.document.activeElement, app.query(replace));
  await app.key(replace, 'End'); assert.equal(app.document.activeElement, app.query(remove));
  await app.key(remove, 'Escape');
  assert.equal(app.query(menu('habit')).hidden, true);
  assert.equal(app.document.activeElement, app.query(more('habit')));
  await app.click(more('habit')); await app.click(more('curious'));
  assert.equal(app.query(menu('habit')).hidden, true);
  assert.equal(app.query(menu('curious')).hidden, false);
  await app.click('#word-list-query');
  assert.equal(app.query(menu('curious')).hidden, true);
  assert.equal(app.document.activeElement.id, 'word-list-query');
  await app.click(more('habit'));
  const tab = await app.key(replace, 'Tab');
  assert.equal(tab.defaultPrevented, false, 'Tab keeps native navigation out of the menu');
  assert.equal(app.query(menu('habit')).hidden, true);
  assert.equal(app.document.activeElement, app.query(more('habit')));
  assert.ok(app.calls.every(call => call.method === 'GET'));
});

test('removal through the menu preserves the word record and cannot remove the last deck word', async () => {
  const app = await browser(); await app.click(more('habit'));
  await app.click(`${menu('habit')} [data-action="remove-word"]`);
  assert.equal(app.state.words.length, 2);
  assert.deepEqual(app.state.decks[0].wordIds, ['word:curious']);
  assert.equal(app.document.querySelector(detail('habit')), null);
  await app.key(more('curious'), 'ArrowUp');
  assert.equal(app.query(`${menu('curious')} [data-action="remove-word"]`).disabled, true);
  assert.equal(app.document.activeElement, app.query(`${menu('curious')} [data-action="replace-word"]`));
  await app.click(`${menu('curious')} [data-action="remove-word"]`);
  assert.deepEqual(app.state.decks[0].wordIds, ['word:curious']);
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 1);
});
