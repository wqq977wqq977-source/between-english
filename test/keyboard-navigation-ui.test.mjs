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

// Real SPA handlers with isolated HTTP/storage. Linkedom does not implement focus
// or native keyboard activation, so focus tracks connected elements and tests
// explicitly check that keydown leaves native control activation unblocked.
async function browser(hash = '#words', { hasArticles = true } = {}) {
  const { window, document } = parseHTML(html), location = { hash }, calls = [];
  const article = { id: 'article', title: 'A small habit', text: 'Small habits make learning easier.', wordCount: 6,
    hasText: true, messages: [], quizzes: [], paragraph: 0, saved: true };
  const state = {
    token: 'fixture', words: [{ id: 'word', word: 'habit', meaning: '习惯', saved: true }],
    decks: [{ id: 'deck', title: 'Daily words', wordIds: ['word'], progress: { index: 0, finished: false } }],
    articles: hasArticles ? [article] : [], jobs: [], memory: null, selections: [], directions: { items: [] },
    settings: { lastDeck: 'deck', tutorProvider: 'codex' }, connection: { authenticated: true },
    modelCatalog: { models: [], fetchedAt: null }
  };
  let focused;
  Object.defineProperty(document, 'activeElement', { get: () => focused?.isConnected ? focused : document.body });
  window.HTMLElement.prototype.focus = function () { focused = this; };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0 });
  window.scrollTo = () => {};
  window.getSelection = () => null;
  const context = createContext({
    document, window, location, URL, AbortController,
    history: { replaceState(_state, _title, next) { location.hash = next; } },
    localStorage: { getItem: () => null, setItem() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: callback => callback(),
    fetch: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET' });
      let value;
      if (url === '/api/bootstrap' || url === '/api/state') value = state;
      else if (url === '/api/articles/article') value = article;
      else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => clone(value) };
    }
  });
  runInContext(source, context, { filename: 'public/app.js' }); await setImmediate();
  const query = selector => {
    const el = document.querySelector(selector);
    assert.ok(el, `Missing element: ${selector}`);
    return el;
  };
  assert.ok(query('.shell'));
  return { document, location, calls, query,
    async input(selector, value) {
      const el = query(selector); el.value = value;
      el.dispatchEvent(new window.Event('input', { bubbles: true })); await setImmediate();
    },
    async toggle(selector, open) {
      const el = query(selector); el.open = open; el.toggleAttribute('open', open);
      el.dispatchEvent(new window.Event('toggle', { bubbles: true })); await setImmediate();
    },
    async click(selector) {
      const el = query(selector); el.focus();
      const event = new window.Event('click', { bubbles: true, cancelable: true });
      el.dispatchEvent(event); await setImmediate(); return event;
    },
    async key(selector, key, code = key) {
      const el = query(selector); el.focus();
      const event = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperties(event, { key: { value: key }, code: { value: code } });
      el.dispatchEvent(event); await setImmediate(); return event;
    }
  };
}

function assertActiveTab(app, id) {
  const tab = app.query(`#${id}`), list = tab.closest('[role="tablist"]');
  assert.equal(app.document.activeElement, tab, 'Focus follows the active tab after rendering');
  assert.equal(tab.getAttribute('aria-selected'), 'true');
  assert.equal(tab.getAttribute('tabindex'), '0');
  for (const item of list.querySelectorAll('[role="tab"]')) {
    const panel = app.query(`#${item.getAttribute('aria-controls')}`);
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), item.id);
    assert.equal(panel.hasAttribute('hidden'), item !== tab);
    assert.equal(item.getAttribute('tabindex'), item === tab ? '0' : '-1');
  }
}

test('all three tab groups support keyboard selection and preserve focus after rendering', async t => {
  for (const [hash, group, values] of [
    ['#words', 'word', ['find', 'study', 'saved']],
    ['#reading', 'read', ['find', 'saved']],
    ['#read/article', 'assistant', ['chat', 'quiz']]
  ]) await t.test(group, async () => {
    const app = await browser(hash), first = `${group}-tab-${values[0]}`, last = `${group}-tab-${values.at(-1)}`;
    await app.key(`#${first}`, 'ArrowRight'); assertActiveTab(app, `${group}-tab-${values[1]}`);
    await app.key(`#${group}-tab-${values[1]}`, 'End'); assertActiveTab(app, last);
    await app.key(`#${last}`, 'ArrowRight'); assertActiveTab(app, first);
    await app.key(`#${first}`, 'ArrowLeft'); assertActiveTab(app, last);
    await app.key(`#${last}`, 'Home'); assertActiveTab(app, first);
    await app.click(`#${last}`); assertActiveTab(app, last);
    assert.equal(app.location.hash, hash, 'Switching tabs does not replace the current page route');
    assert.ok(app.calls.every(call => call.method === 'GET'), 'Changing tabs does not record learning or call a model');
  });
});

test('navigation focuses main content and skip link preserves the current route', async () => {
  const app = await browser();
  await app.click('#nav-reading');
  assert.equal(app.location.hash, '#reading');
  assert.equal(app.document.activeElement.id, 'main');
  assert.equal(app.query('#nav-reading').getAttribute('aria-current'), 'page');
  await app.click('#nav-curate');
  assert.equal(app.document.activeElement.id, 'main', 'Focus survives the subsequent state refresh');
  const route = app.location.hash, event = await app.click('.skip-link');
  assert.equal(event.defaultPrevented, true);
  assert.equal(app.location.hash, route);
  assert.equal(app.document.activeElement.id, 'main');
});

test('study shortcuts leave interactive controls alone and still work on the study surface', async () => {
  const app = await browser(); await app.click('#word-tab-study');
  for (const selector of ['#nav-settings', '#word-tab-saved', '#deck-picker', '[data-action="reveal"]']) {
    const event = await app.key(selector, ' ', 'Space');
    assert.equal(event.defaultPrevented, false, `Native Space activation must remain available: ${selector}`);
    assert.ok(app.query('[data-action="reveal"]'), 'A focused control must not flip the card as a side effect');
  }
  const flip = await app.key('#word-panel-study', ' ', 'Space');
  assert.equal(flip.defaultPrevented, true);
  assert.equal(app.document.querySelector('[data-action="reveal"]'), null);
  assert.ok(app.query('[data-rating="known"]'));
  const rate = await app.key('#nav-settings', '1');
  assert.equal(rate.defaultPrevented, false);
  assert.ok(app.calls.every(call => call.method === 'GET'), 'Shortcuts on controls must not submit a rating');
});

test('keyboard paragraph selection retains context and exposes its instruction', async () => {
  const app = await browser('#read/article'), paragraph = app.query('#para-0');
  assert.match(app.query(`#${paragraph.getAttribute('aria-describedby')}`).textContent, /Enter/);
  const event = await app.key('#para-0', 'Enter');
  assert.equal(event.defaultPrevented, true);
  assert.match(app.query('#selection-area').textContent, /Small habits make learning easier/);
  assert.equal(app.document.activeElement, paragraph);
});

test('reading filters start compact for an existing shelf and retain an opened draft across tabs', async () => {
  const app = await browser('#reading');
  assert.equal(app.query('#article-search-details').hasAttribute('open'), false);
  await app.toggle('#article-search-details', true);
  await app.input('#article-search [name="topic"]', 'Space exploration');
  await app.input('#article-search [name="minWords"]', '450');
  await app.input('#article-search [name="extra"]', 'Use everyday language');
  await app.click('#read-tab-saved');
  assert.equal(app.document.querySelector('#article-search-details'), null);
  await app.click('#read-tab-find');
  assert.equal(app.query('#article-search-details').hasAttribute('open'), true);
  assert.equal(app.query('#article-search [name="topic"]').value, 'Space exploration');
  assert.equal(app.query('#article-search [name="minWords"]').value, '450');
  assert.equal(app.query('#article-search [name="extra"]').value, 'Use everyday language');
  assert.match(app.query('#article-search-details > summary').textContent, /Space exploration/);
  assert.ok(app.calls.every(call => call.method === 'GET'), 'Browsing filter drafts must not start a retrieval job');

  const emptyShelf = await browser('#reading', { hasArticles: false });
  assert.equal(emptyShelf.query('#article-search-details').hasAttribute('open'), true);
  assert.ok(emptyShelf.query('#article-search [type="submit"]'));
});
