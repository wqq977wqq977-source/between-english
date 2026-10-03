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
const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const clone = value => JSON.parse(JSON.stringify(value));
const stored = (storage, key) => JSON.parse(storage.get(key));

// Exercise the real app and its event handlers; only browser APIs and HTTP are fixtures.
async function browser({ storage = new Map(), legacyLevel, hash = '#curate' } = {}) {
  const { window, document } = parseHTML(html);
  const calls = [], unexpected = [];
  const location = { hash };
  const state = {
    token: 'fixture-token', words: [], decks: [], articles: [], jobs: [], memory: null,
    selections: [], directions: { personalized: false, items: [], note: '' },
    connection: { authenticated: true, version: 'fixture' },
    settings: { model: 'first-model', tutorModel: '', tutorProvider: 'codex', defaultLevel: legacyLevel },
    modelCatalog: { models: [
      { id: 'first-model', name: 'First', isDefault: true, reasoningEfforts: ['low', 'high'], supportsFast: true },
      { id: 'second-model', name: 'Second', reasoningEfforts: ['low'], supportsFast: false }
    ], fetchedAt: null }
  };
  window.scrollTo = () => {};
  const context = createContext({
    document, window, location, URL, AbortController,
    history: { replaceState(_state, _title, url) { location.hash = url; } },
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    setTimeout: () => 1, clearTimeout: () => {},
    requestAnimationFrame: callback => callback(),
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ url, body });
      let value;
      if (url === '/api/bootstrap' || url === '/api/state') value = state;
      else if (url === '/api/settings' && options.method === 'POST') {
        state.settings = { ...state.settings, ...body };
        value = state.settings;
      } else {
        unexpected.push(url);
        throw new Error(`Unexpected request: ${url}`);
      }
      return { ok: true, json: async () => clone(value) };
    }
  });
  runInContext(source, context, { filename: 'public/app.js' });
  await setImmediate();
  assert.ok(document.querySelector('.shell'), document.querySelector('#app').textContent);

  const query = selector => {
    const el = document.querySelector(selector);
    assert.ok(el, `Missing visible control: ${selector}`);
    return el;
  };
  const event = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  return {
    document, calls, state, storage,
    query,
    async navigate(nav) { event(query(`button[data-nav="${nav}"]`), 'click'); await setImmediate(); },
    async choose(selector, value) {
      const el = query(selector);
      assert.ok([...el.options].some(option => option.value === value), `Missing option: ${value}`);
      // linkedom lacks the browser's writable select.value and form-owner property.
      for (const option of el.options) option.removeAttribute('selected');
      [...el.options].find(option => option.value === value).setAttribute('selected', '');
      Object.defineProperty(el, 'form', { value: el.closest('form'), configurable: true });
      event(el, 'input');
      event(el, 'change');
      await setImmediate();
    },
    async saveSettings() {
      event(query('#settings-form'), 'submit');
      await setImmediate();
      assert.equal(query('#toast').textContent, '学习偏好已保存');
      assert.deepEqual(unexpected, [], 'This regression must not call a model or another endpoint');
    }
  };
}

async function assertDifficultyControls(app, expected) {
  for (const [nav, selector, value] of [
    ['words', 'select[data-filter="word"][name="level"]', expected.word],
    ['reading', 'select[data-filter="article"][name="level"]', expected.article],
    ['curate', '#curation-level', expected.curation]
  ]) {
    await app.navigate(nav);
    const select = app.query(selector);
    assert.equal(select.value, value, `${nav} keeps its own difficulty`);
    assert.deepEqual([...select.options].map(option => option.value), levels);
  }
}

test('saving a model never changes independent material difficulties or their saved drafts', async () => {
  const storage = new Map([
    ['between.wordFilters', JSON.stringify({ level: 'B1', topic: 'Travel', extra: 'Common verbs' })],
    ['between.articleFilters', JSON.stringify({ level: 'C1', topic: 'Science', minWords: 600 })],
    ['between.curationDraft', JSON.stringify({ defaultLevel: 'A2', prompt: 'Quant for beginners', target: 'both' })]
  ]);
  const previousStorage = new Map(storage);
  const app = await browser({ storage, legacyLevel: 'C2', hash: '#settings' });
  assert.equal(app.document.querySelector('#default-level'), null);
  assert.equal(app.document.querySelector('#settings-form [name="defaultLevel"]'), null);
  await app.choose('#search-model', 'second-model');
  await app.saveSettings();
  const writes = app.calls.filter(call => call.url === '/api/settings');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.model, 'second-model');
  assert.ok(!Object.hasOwn(writes[0].body, 'defaultLevel'));
  assert.deepEqual(storage, previousStorage, 'Saving a model must not rewrite learning filters');
  await assertDifficultyControls(app, { word: 'B1', article: 'C1', curation: 'A2' });

  const reloaded = await browser({ storage, legacyLevel: 'A1' });
  await assertDifficultyControls(reloaded, { word: 'B1', article: 'C1', curation: 'A2' });
});

test('all three material difficulty controls remain usable and remember independent choices after reload', async () => {
  const storage = new Map();
  const app = await browser({ storage });
  await app.choose('#curation-level', 'A2');
  await app.navigate('words');
  await app.choose('select[data-filter="word"][name="level"]', 'B1');
  await app.navigate('reading');
  await app.choose('select[data-filter="article"][name="level"]', 'C1');
  assert.equal(stored(storage, 'between.curationDraft').defaultLevel, 'A2');
  assert.equal(stored(storage, 'between.wordFilters').level, 'B1');
  assert.equal(stored(storage, 'between.articleFilters').level, 'C1');
  await assertDifficultyControls(await browser({ storage, legacyLevel: 'C2' }), { word: 'B1', article: 'C1', curation: 'A2' });
});

test('legacy difficulty is migrated into an unset curation draft once without losing the prompt', async t => {
  for (const [name, initial, legacyLevel, expected] of [
    ['blank draft', '', 'C1', 'C1'],
    ['missing draft field', undefined, 'A2', 'A2'],
    ['invalid draft', 'unknown', 'B1', 'B1'],
    ['invalid legacy setting', '', 'unknown', 'B2'],
    ['no legacy setting', '', undefined, 'B2']
  ]) {
    await t.test(name, async () => {
      const storage = new Map([
        ['between.curationDraft', JSON.stringify({ prompt: 'Keep this request', defaultLevel: initial, target: 'articles' })],
        ['between.wordFilters', JSON.stringify({ level: 'A1' })],
        ['between.articleFilters', JSON.stringify({ level: 'C2' })]
      ]);
      const app = await browser({ storage, legacyLevel });
      assert.equal(app.query('#curation-level').value, expected);
      const migrated = stored(storage, 'between.curationDraft');
      assert.equal(migrated.defaultLevel, expected);
      assert.equal(migrated.prompt, 'Keep this request');
      assert.equal(migrated.target, 'articles');
      const reloaded = await browser({ storage, legacyLevel: expected === 'C1' ? 'A2' : 'C1' });
      await assertDifficultyControls(reloaded, { word: 'A1', article: 'C2', curation: expected });
      assert.equal(stored(storage, 'between.curationDraft').defaultLevel, expected);
    });
  }
});
