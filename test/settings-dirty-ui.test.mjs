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

// The actual settings form and input handlers with an in-memory provider.
async function browser({ hash = '#settings' } = {}) {
  const { window, document } = parseHTML(html), location = { hash }, calls = [], storage = new Map();
  const state = {
    token: 'fixture', words: [], decks: [], articles: [], jobs: [], memory: null, selections: [],
    directions: { items: [] }, connection: { authenticated: true },
    settings: { model: 'first', tutorModel: '', tutorProvider: 'api', reasoningEffort: 'high', fastMode: true,
      api: { baseUrl: 'https://fixture.example/v1', model: 'fixture-model', hasKey: true, reasoningEffort: 'low', fastMode: true } },
    modelCatalog: { models: [
      { id: 'first', name: 'First', isDefault: true, reasoningEfforts: ['low', 'high'], supportsFast: true },
      { id: 'second', name: 'Second', reasoningEfforts: ['low'], supportsFast: false }
    ], fetchedAt: null }
  };
  const controls = { saveError: '' };
  window.scrollTo = () => {};
  const context = createContext({ document, window, location, URL, AbortController,
    history: { replaceState(_s, _t, hash) { location.hash = hash; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: callback => callback(),
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, body }); let value;
      if (url === '/api/bootstrap' || url === '/api/state') value = state;
      else if (url === '/api/settings') {
        if (controls.saveError) return { ok: false, json: async () => ({ error: controls.saveError }) };
        const previous = state.settings.api;
        state.settings = { ...state.settings, ...body, api: body.api ? {
          baseUrl: body.api.baseUrl.trim().replace(/\/+$/, ''), model: body.api.model.trim(),
          hasKey: body.api.clearKey ? false : Boolean(body.api.apiKey || previous.hasKey),
          reasoningEffort: body.api.reasoningEffort, fastMode: body.api.fastMode
        } : previous };
        value = state.settings;
      } else if (url === '/api/provider/test') value = { ok: true, message: '连接正常。' };
      else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => clone(value) };
    }
  });
  runInContext(source, context, { filename: 'public/app.js' }); await setImmediate();
  const query = selector => { const el = document.querySelector(selector); assert.ok(el, `Missing control: ${selector}`); return el; };
  const event = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  return { document, query, calls, storage, state, controls,
    async click(selector) { event(query(selector), 'click'); await setImmediate(); },
    async input(selector, value, change = false) {
      const el = query(selector);
      if (el.tagName === 'SELECT') {
        for (const option of el.options) option.removeAttribute('selected');
        const option = [...el.options].find(option => option.value === value); assert.ok(option); option.setAttribute('selected', '');
      } else if (el.type === 'checkbox') el.checked = value;
      else el.value = value;
      Object.defineProperty(el, 'form', { value: el.closest('form'), configurable: true });
      event(el, 'input'); if (change || el.tagName === 'SELECT' || el.type === 'checkbox') event(el, 'change'); await setImmediate();
    },
    async save() { event(query('#settings-form'), 'submit'); await setImmediate(); },
    leaving() { const e = new window.Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }
  };
}
const saveButton = '#settings-save-bar [type="submit"]';
const resetButton = '[data-action="reset-settings-draft"]';

test('model changes show a dirty state, normalize unsupported options, and can be reset without saving', async () => {
  const app = await browser();
  assert.equal(app.query('.settings-save-status').textContent, '已保存');
  assert.equal(app.query(saveButton).disabled, true);
  assert.equal(app.leaving(), false);
  await app.input('#search-model', 'second');
  assert.equal(app.query('#search-effort').value, '');
  assert.equal(app.query('#search-fast').hasAttribute('checked'), false);
  assert.equal(app.query('.settings-save-status').textContent, '有未保存的修改');
  assert.equal(app.query(saveButton).disabled, false);
  assert.equal(app.leaving(), true);
  await app.click(resetButton);
  assert.equal(app.query('#search-model').value, 'first');
  assert.equal(app.query('#search-effort').value, 'high');
  assert.equal(app.query('#search-fast').hasAttribute('checked'), true);
  assert.equal(app.leaving(), false);
  assert.equal(app.calls.filter(call => call.body).length, 0);
});

test('API whitespace and trailing slashes do not count as edits or discard saved generation options', async () => {
  const app = await browser();
  await app.input('#api-base-url', ' https://fixture.example/v1/// ', true);
  await app.input('#api-model', ' fixture-model ', true);
  assert.equal(app.query('#api-effort').value, 'low');
  assert.equal(app.query('#api-fast').hasAttribute('checked'), true);
  assert.equal(app.query(saveButton).disabled, true);
  assert.equal(app.leaving(), false);
  await app.click('[data-action="test-api"]');
  assert.match(app.query('.api-feedback').textContent, /连接测试通过 · 已保存配置/);
  assert.equal(app.calls.some(call => call.url === '/api/settings'), false);
});

test('testing a new API key does not save it and resetting clears the transient secret', async () => {
  const app = await browser();
  await app.input('#api-key', 'fixture-secret');
  assert.equal(app.query(saveButton).disabled, false);
  await app.click('[data-action="test-api"]');
  assert.match(app.query('.api-feedback').textContent, /更改尚未保存/);
  assert.equal(app.leaving(), true);
  assert.equal(app.calls.some(call => call.url === '/api/settings'), false);
  assert.equal([...app.storage.values()].some(value => value.includes('fixture-secret')), false);
  await app.click(resetButton);
  assert.equal(app.query('#api-key').value, '');
  assert.equal(app.document.querySelector('.api-feedback'), null);
  assert.equal(app.leaving(), false);
});

test('successful save clears transient credentials and warnings while a failed save preserves the draft', async () => {
  const app = await browser();
  await app.input('#api-key', 'fixture-new-key');
  app.controls.saveError = 'Fixture save failure';
  await app.save();
  assert.equal(app.query('#api-key').value, 'fixture-new-key');
  assert.equal(app.query('.settings-save-status').textContent, '有未保存的修改');
  assert.equal(app.leaving(), true);
  app.controls.saveError = '';
  await app.save();
  assert.equal(app.query('#api-key').value, '');
  assert.equal(app.query('.settings-save-status').textContent, '已保存');
  assert.equal(app.query(saveButton).disabled, true);
  assert.equal(app.leaving(), false);
  assert.equal([...app.storage.values()].some(value => value.includes('fixture-new-key')), false);
  await app.input('#api-clear-key', true);
  assert.equal(app.query(saveButton).disabled, false);
  await app.save();
  assert.equal(app.state.settings.api.hasKey, false);
  assert.equal(app.document.querySelector('#api-clear-key'), null);
  assert.equal(app.leaving(), false);
});

test('curation summary follows level, counts and target without requiring a request', async () => {
  const app = await browser({ hash: '#curate' });
  const summary = () => app.query('#curation-defaults-summary').textContent;
  assert.equal(summary(), 'B2 · 10 个词 · 2 篇文章');
  await app.input('#curation-word-count', '25');
  await app.input('#curation-article-count', '4');
  await app.input('#curation-level', 'C1');
  assert.equal(summary(), 'C1 · 25 个词 · 4 篇文章');
  await app.input('#curation-target', 'articles');
  assert.equal(summary(), 'C1 · 4 篇文章');
  await app.input('#curation-target', 'words');
  assert.equal(summary(), 'C1 · 25 个词');
  assert.equal(app.calls.filter(call => call.body).length, 0);
});
