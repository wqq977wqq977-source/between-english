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

// Actual SPA events and polling, with in-memory articles and controlled HTTP responses.
async function browser({ mobile = false } = {}) {
  const { window, document } = parseHTML(html), location = { hash: '#read/A' }, polls = [], calls = [];
  const articles = Object.fromEntries(['A', 'B'].map(id => [id, {
    id, title: `Article ${id}`, text: 'A planet follows an orbit. An orbit is a path around another object.',
    wordCount: 14, hasText: true, messages: [], paragraph: 0, completed: false, quizzes: []
  }]));
  articles.A.quizzes = [{ id: 'quiz-A', articleId: 'A', graded: false, answers: {}, results: [], questions: [
    { id: 'choice-A', question: 'What is an orbit?', type: 'choice', options: ['A path', 'A planet', 'A star', 'A comet'] },
    { id: 'short-A', question: 'Describe an orbit.', type: 'short', options: [] }
  ] }];
  const state = { token: 'fixture', words: [], decks: [], articles: Object.values(articles), jobs: [], memory: null,
    settings: { tutorProvider: 'codex' }, connection: { authenticated: true },
    modelCatalog: { models: [], fetchedAt: null }, directions: { items: [] }, selections: [] };
  let completionGate, requestFailure;
  window.scrollTo = () => {};
  window.matchMedia = () => ({ matches: mobile, addEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLElement.prototype.close = function () { this.removeAttribute('open'); };
  Object.defineProperty(window.HTMLElement.prototype, 'open', { configurable: true, get() { return this.hasAttribute('open'); } });
  const context = createContext({ document, window, location, URL, AbortController,
    history: { replaceState(_s, _t, hash) { location.hash = hash; } },
    localStorage: { getItem() { return null; }, setItem() {} },
    IntersectionObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: callback => callback(),
    setTimeout(callback, delay) { if (delay === 1400) polls.push(callback); return 1; }, clearTimeout() {},
    FormData: class {
      constructor(form) { this.entries = [...form.querySelectorAll('[name]')].filter(el => el.type !== 'radio' || el.checked).map(el => [el.name, el.value]); }
      [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
    },
    fetch: async (url, options = {}) => {
      if (requestFailure?.url === url) { const error = requestFailure.error; requestFailure = null; throw new Error(error); }
      const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, body }); let value;
      if (url === '/api/bootstrap' || url === '/api/state') value = state;
      else if (/^\/api\/articles\/[AB]\/visit$/.test(url)) value = { ok: true };
      else if (/^\/api\/articles\/[AB]$/.test(url)) {
        const article = articles[url.split('/').at(-1)];
        if (body) { Object.assign(article, body); const gate = completionGate; completionGate = null; if (gate) await gate.promise; }
        value = article;
      } else if (url === '/api/jobs') {
        value = { id: 'grading', type: body.type, params: body.params, status: 'running', progress: '批改中' }; state.jobs = [value];
      } else if (url === '/api/jobs/grading') value = state.jobs[0];
      else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => clone(value) };
    }
  });
  runInContext(source, context, { filename: 'public/app.js' }); await setImmediate();
  const query = selector => { const el = document.querySelector(selector); assert.ok(el, `Missing control: ${selector}`); return el; };
  const event = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  return { document, articles, state, calls, location, query,
    async click(selector) { event(query(selector), 'click'); await setImmediate(); },
    async input(selector, value) { const el = query(selector); el.value = value; event(el, 'input'); await setImmediate(); },
    async choose(value) { for (const el of document.querySelectorAll('[name="choice-A"]')) el.checked = el.value === value; event(query(`[name="choice-A"][value="${value}"]`), 'input'); await setImmediate(); },
    async submit(selector = '#grade-form') { event(query(selector), 'submit'); await setImmediate(); },
    failRequest(url, error) { requestFailure = { url, error }; },
    async poll() { assert.ok(polls.length); polls.shift()(); await setImmediate(); },
    async failJob(error) { Object.assign(state.jobs[0], { status: 'failed', error }); await this.poll(); },
    holdCompletion() { completionGate = deferred(); return completionGate; },
    async completeGrade() {
      const quiz = articles.A.quizzes[0]; quiz.graded = true; quiz.answers = clone(state.jobs[0].params.answers);
      quiz.results = quiz.questions.map(q => ({ questionId: q.id, score: 1, feedback: 'Correct.', referenceAnswer: quiz.answers[q.id], evidence: articles.A.text }));
      Object.assign(state.jobs[0], { status: 'completed', result: { articleId: 'A', quizId: quiz.id } });
      assert.ok(polls.length); polls.shift()(); await setImmediate();
    }
  };
}

test('mobile assistant keeps task failures accessible inside its open dialog', async t => {
  for (const task of ['explain', 'quiz', 'grade']) await t.test(task, async () => {
    const app = await browser({ mobile: true }); await app.click('#reader-assistant-toggle');
    if (task === 'explain') await app.input('#compose', 'Explain this passage.');
    else await app.click('[data-assistant-tab="quiz"]');
    await app.submit(task === 'explain' ? '#chat-form' : task === 'quiz' ? '#quiz-form' : '#grade-form');
    const message = 'Request <b>failed</b>. Please retry.';
    await app.failJob(message);
    assert.equal(app.query('#assistant-sheet').open, true);
    const alert = app.query('#assistant-sheet [role="alert"]');
    assert.ok(alert.textContent.includes(message));
    assert.equal(alert.querySelector('b'), null, 'Model errors must remain plain text');
    await app.click('#assistant-sheet [data-action="dismiss-error"]');
    assert.equal(app.document.querySelector('#assistant-sheet [role="alert"]'), null);
    assert.equal(app.query('#assistant-sheet').open, true);
  });
});

test('mobile assistant shows submission and polling connection failures', async t => {
  for (const phase of ['submit', 'poll']) await t.test(phase, async () => {
    const app = await browser({ mobile: true }); await app.click('#reader-assistant-toggle');
    await app.input('#compose', 'Keep my question if submission fails.');
    if (phase === 'submit') app.failRequest('/api/jobs', 'Connection refused.');
    await app.submit('#chat-form');
    if (phase === 'poll') { app.failRequest('/api/jobs/grading', 'Connection refused.'); await app.poll(); }
    const alert = app.query('#assistant-sheet [role="alert"]');
    assert.match(alert.textContent, phase === 'submit' ? /Connection refused/ : /连接中断/);
    if (phase === 'submit') assert.equal(app.query('#compose').value, 'Keep my question if submission fails.');
  });
});

test('a graded quiz shows the submitted answers rather than edits made while grading', async () => {
  const app = await browser(); await app.click('[data-assistant-tab="quiz"]');
  await app.choose('A path'); await app.input('[name="short-A"]', 'A path around another object.'); await app.submit();
  assert.deepEqual(app.state.jobs[0].params.answers, { 'choice-A': 'A path', 'short-A': 'A path around another object.' });
  await app.choose('A comet'); await app.input('[name="short-A"]', 'A later unsent guess.');
  await app.completeGrade();
  assert.equal(app.query('[name="choice-A"][checked]').value, 'A path');
  assert.equal(app.query('[name="short-A"]').value, 'A path around another object.');
  assert.ok(app.query('[name="short-A"]').hasAttribute('readonly'));
});

test('an ungraded quiz keeps its draft answers across assistant tabs', async () => {
  const app = await browser(); await app.click('[data-assistant-tab="quiz"]');
  await app.choose('A path'); await app.input('[name="short-A"]', 'My unsent answer.');
  await app.click('[data-assistant-tab="chat"]'); await app.click('[data-assistant-tab="quiz"]');
  assert.equal(app.query('[name="choice-A"][checked]').value, 'A path');
  assert.equal(app.query('[name="short-A"]').value, 'My unsent answer.');
});

test('a delayed read-completion response updates only its article and survives navigation', async t => {
  for (const destination of ['current', 'other', 'library']) await t.test(destination, async () => {
    const app = await browser(), gate = app.holdCompletion(); await app.click('[data-action="finish-reading"]');
    if (destination !== 'current') await app.click('[data-action="back-library"]');
    if (destination === 'other') await app.click('[data-action="open-article"][data-id="B"]');
    gate.resolve(); await setImmediate();
    assert.equal(app.articles.A.completed, true); assert.equal(app.articles.B.completed, false);
    assert.equal(Boolean(app.document.querySelector('[role="alert"]')), false, 'Navigation must not raise a completion error');
    if (destination === 'current') assert.equal(app.query('[data-action="finish-reading"]').textContent, '已读完 ✓');
    if (destination === 'other') {
      assert.equal(app.location.hash, '#read/B'); assert.equal(app.query('.reader h1').textContent, 'Article B');
      assert.equal(app.query('[data-action="finish-reading"]').textContent, '标记读完');
    }
    if (destination === 'library') assert.equal(app.location.hash, '#reading');
  });
});
