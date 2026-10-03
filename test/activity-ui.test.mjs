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
const day = (date, counts = {}) => {
  const row = { date, reviews: 0, questions: 0, quizzes: 0, articlesCompleted: 0, ...counts };
  row.wordsStudied = counts.wordsStudied ?? counts.wordKeys?.length ?? row.reviews;
  row.wordKeys = counts.wordKeys ?? Array.from({ length: row.wordsStudied }, (_, index) => `${date}-word-${index}`);
  row.total = row.reviews + row.questions + row.quizzes + row.articlesCompleted;
  return row;
};
const activity = overrides => ({
  today: '2026-10-03', timeZone: 'Asia/Singapore', since: '2025-01-01T00:00:00.000Z',
  recording: true, days: [], ...overrides
});

// Exercise the real SPA with the server's public activity response, not raw event records.
async function browser({ records = activity(), hash = '#learning', stored = [] } = {}) {
  const { window, document } = parseHTML(html);
  const state = {
    token: 'fixture-token', words: [], decks: [], articles: [], jobs: [], memory: null, selections: [],
    activity: records, directions: { personalized: false, items: [], note: '' },
    connection: { authenticated: true, version: 'fixture' },
    settings: { model: 'fixture', tutorProvider: 'codex' },
    modelCatalog: { models: [], fetchedAt: null }
  };
  const calls = [], unexpected = [], storage = new Map(stored), location = { hash };
  let focused;
  window.scrollTo = () => {};
  window.innerWidth = 1280;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.focus = function () { focused = this; };
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 300, top: 300, bottom: 400, width: 100, height: 100 });
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
      const call = { url, method: options.method || 'GET' };
      calls.push(call);
      if (call.method !== 'GET' || !['/api/bootstrap', '/api/state'].includes(url)) {
        unexpected.push(call);
        throw new Error(`Unexpected activity request: ${call.method} ${url}`);
      }
      return { ok: true, json: async () => clone(state) };
    }
  });
  runInContext(source, context, { filename: 'public/app.js' });
  await setImmediate();
  const query = selector => {
    const el = document.querySelector(selector);
    assert.ok(el, `Missing visible control: ${selector}`);
    return el;
  };
  assert.ok(document.querySelector('.shell'), document.querySelector('#app').textContent);
  return {
    state, document, location, calls, query,
    calendar: filter => clone(runInContext(`activityCalendar(S.activity, ${JSON.stringify(filter || 'all')})`, context)),
    weeks: filter => clone(runInContext(`activityWeeks(activityCalendar(S.activity, ${JSON.stringify(filter || 'all')}))`, context)),
    stored: () => [...storage],
    summary: () => [...query('.activity-summary').querySelectorAll('strong')].map(el => Number(el.textContent)),
    focused: () => focused,
    async click(selector) {
      query(selector).dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
      await setImmediate();
    },
    async hover(selector) {
      const event = new window.Event('pointerover', { bubbles: true });
      Object.defineProperty(event, 'pointerType', { value: 'mouse' });
      query(selector).dispatchEvent(event);
      await setImmediate();
    },
    async leave(selector) {
      query(selector).dispatchEvent(new window.Event('pointerout', { bubbles: true }));
      await setImmediate();
    },
    async focus(selector) {
      query(selector).dispatchEvent(new window.Event('focusin', { bubbles: true }));
      await setImmediate();
    },
    async blur(selector) {
      query(selector).dispatchEvent(new window.Event('focusout', { bubbles: true }));
      await setImmediate();
    },
    async key(selector, key) {
      const event = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'key', { value: key });
      query(selector).dispatchEvent(event);
      await setImmediate();
      return event;
    },
    assertReadOnly() {
      assert.deepEqual(unexpected, [], 'Viewing activity must not call models or save learning events');
      assert.ok(calls.every(call => call.method === 'GET'));
    }
  };
}

test('annual activity includes exactly 365 actual dates across year and leap-day boundaries', async () => {
  for (const [today, start, hasLeapDay] of [
    ['2024-03-01', '2023-03-03', true],
    ['2025-03-01', '2024-03-02', false],
    ['2026-10-03', '2025-10-04', false]
  ]) {
    const app = await browser({ records: activity({ today, since: '2020-01-01T00:00:00.000Z' }) });
    const dates = [...app.document.querySelectorAll('[data-activity-date]')].map(el => el.dataset.activityDate);
    assert.equal(dates.length, 365);
    assert.equal(new Set(dates).size, 365);
    assert.equal(dates[0], start);
    assert.equal(dates.at(-1), today);
    assert.equal(dates.includes('2024-02-29'), hasLeapDay);
    const previousYear = Number(today.slice(0, 4)) - 1;
    assert.ok(dates.includes(`${previousYear}-12-31`));
    assert.ok(dates.includes(`${previousYear + 1}-01-01`));
    if (hasLeapDay) assert.deepEqual(dates.slice(-3), ['2024-02-28', '2024-02-29', '2024-03-01']);
    app.assertReadOnly();
  }
});

test('week columns start on Monday and pad incomplete weeks without interactive out-of-range dates', async () => {
  const app = await browser();
  const cells = [...app.query('.activity-days').children];
  assert.equal(cells.length, 53 * 7);
  assert.ok(cells.slice(0, 5).every(el => el.classList.contains('activity-blank')));
  assert.equal(cells[5].dataset.activityDate, '2025-10-04'); // Saturday in the first week.
  assert.equal(cells[7].dataset.activityDate, '2025-10-06'); // Monday begins the next column.
  assert.equal(cells.at(-2).dataset.activityDate, '2026-10-03');
  assert.ok(cells.at(-1).classList.contains('activity-blank'));
  assert.ok(cells.filter(el => el.classList.contains('activity-blank')).every(el => el.getAttribute('aria-hidden') === 'true' && el.tagName !== 'BUTTON'));
  assert.equal(app.calendar().weeks, 53);
  assert.equal(app.query('[data-activity-date][aria-pressed="true"]').dataset.activityDate, '2026-10-03');
  app.assertReadOnly();
});

test('all, word, and reading filters change day intensity, details, active-day count, and streak', async () => {
  const app = await browser({ records: activity({ days: [
    day('2026-09-29', { reviews: 1 }),
    day('2026-09-30', { quizzes: 1 }),
    day('2026-10-01', { reviews: 4, questions: 1 }),
    day('2026-10-02', { questions: 1, quizzes: 1, articlesCompleted: 1 }),
    day('2026-10-03', { reviews: 20, questions: 2, quizzes: 1, articlesCompleted: 1 })
  ] }) });
  assert.deepEqual(app.summary(), [5, 5]);
  assert.equal(app.query('#activity-2026-10-03').dataset.level, '4');
  assert.match(app.query('#activity-detail').textContent, /学习 20 个词 · 读完 1 篇 · 提问 2 次 · 测验 1 组/);
  await app.click('#activity-filter-words');
  assert.deepEqual(app.summary(), [3, 1]);
  assert.equal(app.query('#activity-2026-10-02').dataset.level, '0');
  assert.equal(app.query('#activity-2026-10-01').dataset.level, '2');
  assert.equal(app.query('#activity-detail span').textContent, '学习 20 个词');
  await app.click('#activity-filter-reading');
  assert.deepEqual(app.summary(), [4, 4]);
  assert.equal(app.query('#activity-2026-09-29').dataset.level, '0');
  assert.equal(app.query('#activity-2026-10-03').dataset.level, '2');
  assert.equal(app.query('#activity-detail span').textContent, '读完 1 篇 · 提问 2 次 · 测验 1 组');
  assert.equal(app.query('#activity-filter-reading').getAttribute('aria-pressed'), 'true');
  assert.equal(app.query('#activity-filter-words').getAttribute('aria-pressed'), 'false');
  await app.click('#activity-2026-10-01');
  await app.click('#activity-filter-all');
  assert.equal(app.query('[data-activity-date][aria-pressed="true"]').dataset.activityDate, '2026-10-01');
  assert.equal(app.query('#activity-detail span').textContent, '学习 4 个词 · 提问 1 次');
  app.assertReadOnly();
});

test('word intensity uses distinct studied words, so repeated reviews do not darken the calendar', async () => {
  const app = await browser({ records: activity({ days: [
    day('2026-10-01', { reviews: 20, wordsStudied: 1, wordKeys: ['same-word'] }),
    day('2026-10-02', { reviews: 20, wordsStudied: 4 }),
    day('2026-10-03', { reviews: 20, wordsStudied: 10, questions: 1 })
  ] }) });
  await app.click('#activity-filter-words');
  assert.equal(app.calendar('words').filter, 'words');
  assert.equal(app.query('#activity-2026-10-01').dataset.level, '1');
  assert.equal(app.query('#activity-2026-10-02').dataset.level, '2');
  assert.equal(app.query('#activity-2026-10-03').dataset.level, '3');
  await app.click('#activity-2026-10-01');
  assert.equal(app.query('#activity-detail span').textContent, '学习 1 个词');
  const repeated = app.calendar('words').visible.find(row => row.date === '2026-10-01');
  assert.equal(repeated.reviews, 20, 'Raw review counts are retained for other progress features');
  assert.equal(repeated.total, 20);
  assert.equal(repeated.count, 1);
  await app.click('#activity-filter-all');
  assert.equal(app.query('#activity-2026-10-01').dataset.level, '1');
  assert.equal(app.calendar('all').visible.at(-1).count, 11);
  app.assertReadOnly();
});

test('daily tooltips show word counts and reading details on hover or focus and dismiss on leave or Escape', async () => {
  const app = await browser({ records: activity({ days: [
    day('2026-10-02', { reviews: 20, wordsStudied: 1, wordKeys: ['same-word'], questions: 2, articlesCompleted: 1 })
  ] }) });
  await app.click('#activity-filter-words');
  const cell = app.query('#activity-2026-10-02');
  assert.equal(cell.hasAttribute('title'), false, 'Use one custom tooltip instead of a second delayed native tooltip');
  assert.ok(cell.hasAttribute('data-activity-tooltip'));
  await app.hover('#activity-2026-10-02');
  assert.equal(app.query('#activity-tooltip').hidden, false);
  assert.equal(app.query('#activity-tooltip strong').textContent, '2026.10.02');
  assert.equal(app.query('#activity-tooltip span').textContent, '学习 1 个词');
  await app.leave('#activity-2026-10-02');
  assert.equal(app.query('#activity-tooltip').hidden, true);
  await app.focus('#activity-2026-10-02');
  assert.equal(app.query('#activity-tooltip').hidden, false);
  await app.key('#activity-2026-10-02', 'Escape');
  assert.equal(app.query('#activity-tooltip').hidden, true);
  await app.focus('#activity-2026-10-02');
  await app.blur('#activity-2026-10-02');
  assert.equal(app.query('#activity-tooltip').hidden, true);
  await app.click('#activity-filter-reading');
  await app.hover('#activity-2026-10-02');
  assert.equal(app.query('#activity-tooltip span').textContent, '读完 1 篇 · 提问 2 次');
  app.assertReadOnly();
});

test('current streak can end today or yesterday, and an empty yesterday breaks an old run', async () => {
  for (const [dates, expected] of [
    [['2026-10-01', '2026-10-02', '2026-10-03'], 3],
    [['2026-09-30', '2026-10-01', '2026-10-02'], 3],
    [['2026-09-29', '2026-09-30', '2026-10-01'], 0],
    [['2026-09-30', '2026-10-01', '2026-10-03'], 1],
    [[], 0]
  ]) {
    const app = await browser({ records: activity({ days: dates.map(date => day(date, { reviews: 1 })) }) });
    assert.equal(app.summary()[1], expected, `Streak for ${dates.join(', ')}`);
    app.assertReadOnly();
  }
});

test('date selection and keyboard navigation keep one accessible selected cell and update details', async () => {
  const app = await browser({ records: activity({ days: [day('2026-09-23', { reviews: 8 })] }) });
  const selected = date => {
    const cells = [...app.document.querySelectorAll('[data-activity-date]')];
    assert.equal(cells.filter(el => el.getAttribute('aria-pressed') === 'true').length, 1);
    assert.equal(cells.filter(el => el.getAttribute('tabindex') === '0').length, 1);
    assert.equal(app.query('[data-activity-date][aria-pressed="true"]').dataset.activityDate, date);
    assert.ok(app.query('#activity-detail strong').textContent.startsWith(date.replaceAll('-', '.')));
  };
  await app.click('#activity-2026-09-23');
  selected('2026-09-23');
  assert.equal(app.query('#activity-detail span').textContent, '学习 8 个词');
  assert.equal(app.query('#activity-2026-09-23').getAttribute('aria-label'), '2026-09-23 · 学习 8 个词');
  for (const [from, key, to] of [
    ['2026-09-23', 'ArrowLeft', '2026-09-16'],
    ['2026-09-16', 'ArrowRight', '2026-09-23'],
    ['2026-09-23', 'ArrowUp', '2026-09-22'],
    ['2026-09-22', 'ArrowDown', '2026-09-23'],
    ['2026-09-23', 'Home', '2025-10-04'],
    ['2025-10-04', 'ArrowLeft', '2025-10-04'],
    ['2025-10-04', 'End', '2026-10-03'],
    ['2026-10-03', 'ArrowDown', '2026-10-03']
  ]) {
    const event = await app.key(`#activity-${from}`, key);
    assert.equal(event.defaultPrevented, true);
    selected(to);
    assert.equal(app.focused().dataset.activityDate, to);
  }
  assert.equal(app.query('#activity-detail').getAttribute('aria-live'), 'polite');
  assert.match(app.query('#activity-detail strong').textContent, /今天/);
  app.assertReadOnly();
});

test('empty history distinguishes unrecorded dates using the learning timezone', async () => {
  const app = await browser({ records: activity({ since: '2026-09-30T18:00:00.000Z' }) });
  assert.deepEqual(app.summary(), [0, 0]);
  assert.match(app.query('.activity-notice').textContent, /从下一次练习开始/);
  await app.click('#activity-2026-09-30');
  assert.equal(app.query('#activity-detail span').textContent, '尚未开始记录');
  assert.ok(app.query('#activity-2026-09-30').classList.contains('is-untracked'));
  await app.click('#activity-2026-10-01');
  assert.equal(app.query('#activity-detail span').textContent, '暂无学习记录');
  assert.equal(app.query('#activity-2026-10-01').classList.contains('is-untracked'), false);
  app.assertReadOnly();
});

test('paused recording preserves existing activity and provides a settings link', async () => {
  const app = await browser({ records: activity({ recording: false, days: [day('2026-10-03', { reviews: 2 })] }) });
  assert.deepEqual(app.summary(), [1, 1]);
  assert.equal(app.query('#activity-2026-10-03').dataset.level, '1');
  assert.match(app.query('.activity-notice').textContent, /学习记录已暂停/);
  await app.click('.activity-notice [data-nav="settings"]');
  assert.equal(app.location.hash, '#settings');
  assert.ok(app.document.querySelector('#settings-form'));
  app.assertReadOnly();
});

test('entering My Learning reloads activity added since another tab was opened', async () => {
  const app = await browser({ hash: '#words' });
  assert.equal(app.document.querySelector('.activity-panel'), null);
  app.state.activity.days.push(day('2026-10-03', { reviews: 6 }));
  await app.click('nav [data-nav="learning"]');
  assert.equal(app.location.hash, '#learning');
  assert.deepEqual(app.summary(), [1, 1]);
  assert.equal(app.query('#activity-detail span').textContent, '学习 6 个词');
  await app.click('nav [data-nav="reading"]');
  app.state.activity.days[0] = day('2026-10-03', { reviews: 6, articlesCompleted: 1 });
  await app.click('nav [data-nav="learning"]');
  assert.equal(app.query('#activity-detail span').textContent, '学习 6 个词 · 读完 1 篇');
  assert.deepEqual(app.calls.map(call => call.url), ['/api/bootstrap', '/api/state', '/api/state']);
  app.assertReadOnly();
});

test('weekly activity starts on Monday across years and excludes dates outside the annual window', async () => {
  const app = await browser({ records: activity({ today: '2026-01-02', since: '2020-01-01T00:00:00.000Z', days: [
    day('2025-01-02', { reviews: 999 }), // Same first week, but before the visible annual window.
    day('2025-01-03', { reviews: 2 }),
    day('2025-01-05', { questions: 1 }),
    day('2025-12-28', { quizzes: 2 }), // Sunday belongs to the preceding week.
    day('2025-12-29', { reviews: 3 }),
    day('2025-12-31', { articlesCompleted: 1 }),
    day('2026-01-01', { questions: 2 }),
    day('2026-01-02', { quizzes: 1 }),
    day('2026-01-03', { reviews: 888 }) // Future dates in the current week must be excluded.
  ] }) });
  await app.click('#activity-mode-weekly');
  const weeks = app.weeks();
  assert.equal(weeks.length, 53);
  assert.ok(weeks.every(week => new Date(`${week.date}T00:00:00Z`).getUTCDay() === 1));
  assert.deepEqual(
    { date: weeks[0].date, start: weeks[0].rangeStart, end: weeks[0].rangeEnd, count: weeks[0].count },
    { date: '2024-12-30', start: '2025-01-03', end: '2025-01-05', count: 3 }
  );
  const last = weeks.at(-1);
  assert.deepEqual(
    { date: last.date, start: last.rangeStart, end: last.rangeEnd, reviews: last.reviews, questions: last.questions, quizzes: last.quizzes, articles: last.articlesCompleted, total: last.total, count: last.count },
    { date: '2025-12-29', start: '2025-12-29', end: '2026-01-02', reviews: 3, questions: 2, quizzes: 1, articles: 1, total: 7, count: 7 }
  );
  assert.equal(weeks.at(-2).count, 2);
  assert.equal(weeks.reduce((sum, week) => sum + week.count, 0), 12);
  const buttons = [...app.document.querySelectorAll('[data-activity-week]')];
  assert.equal(buttons.length, 53);
  assert.ok(buttons.every(button => button.classList.contains('activity-week') && button.querySelectorAll('.activity-week-cell').length === 7));
  assert.equal(app.document.querySelectorAll('[data-activity-date]').length, 0);
  assert.equal(app.query('#activity-week-2025-12-29').dataset.count, '7');
  assert.equal(app.query('#activity-week-2025-12-29').getAttribute('aria-label'), '2025-12-29 — 2026-01-02 · 学习 3 个词 · 读完 1 篇 · 提问 2 次 · 测验 1 组');
  await app.hover('#activity-week-2025-12-29');
  assert.equal(app.query('#activity-tooltip').hidden, false);
  assert.equal(app.query('#activity-tooltip strong').textContent, '2025.12.29 — 2026.01.02');
  assert.equal(app.query('#activity-tooltip span').textContent, '7 次学习 · 学习 3 个词 · 读完 1 篇 · 提问 2 次 · 测验 1 组');
  assert.match(app.query('#activity-detail strong').textContent, /2025\.12\.29/);
  assert.match(app.query('#activity-detail strong').textContent, /2026\.01\.02/);
  assert.equal(app.query('#activity-detail span').textContent, '7 次学习 · 学习 3 个词 · 读完 1 篇 · 提问 2 次 · 测验 1 组');
  app.assertReadOnly();
});

test('weekly totals and detail follow the same word and reading filters as daily activity', async () => {
  const app = await browser({ records: activity({ days: [
    day('2026-09-27', { reviews: 3, questions: 1 }),
    day('2026-09-28', { reviews: 4 }),
    day('2026-09-29', { quizzes: 1 }),
    day('2026-10-01', { reviews: 6, questions: 2 }),
    day('2026-10-02', { questions: 1, articlesCompleted: 1 }),
    day('2026-10-03', { reviews: 5, quizzes: 1 })
  ] }) });
  await app.click('#activity-mode-weekly');
  assert.equal(app.query('#activity-week-2026-09-28').dataset.count, '21');
  assert.equal(app.query('#activity-detail span').textContent, '21 次学习 · 学习 15 个词 · 读完 1 篇 · 提问 3 次 · 测验 2 组');
  await app.click('#activity-filter-words');
  assert.equal(app.query('#activity-mode-weekly').getAttribute('aria-pressed'), 'true');
  assert.equal(app.query('#activity-week-2026-09-28').dataset.count, '15');
  assert.equal(app.query('#activity-detail span').textContent, '学习 15 个词');
  assert.equal(app.weeks('words').at(-1).count, 15);
  assert.deepEqual(app.summary(), [4, 1]);
  await app.click('#activity-filter-reading');
  assert.equal(app.query('#activity-week-2026-09-28').dataset.count, '6');
  assert.equal(app.query('#activity-detail span').textContent, '6 次学习 · 读完 1 篇 · 提问 3 次 · 测验 2 组');
  assert.equal(app.weeks('reading').at(-1).count, 6);
  assert.deepEqual(app.summary(), [5, 3]);
  await app.click('#activity-mode-daily');
  assert.equal(app.query('#activity-filter-reading').getAttribute('aria-pressed'), 'true');
  assert.equal(app.query('#activity-detail span').textContent, '测验 1 组');
  app.assertReadOnly();
});

test('weekly word counts union daily identities within each week while retaining raw review totals', async () => {
  const app = await browser({ records: activity({ days: [
    day('2026-09-27', { reviews: 20, wordKeys: ['shared-word'] }),
    day('2026-09-28', { reviews: 20, wordKeys: ['shared-word', 'second-word'] }),
    day('2026-09-29', { reviews: 20, wordKeys: ['shared-word', 'third-word'], questions: 2 }),
    day('2026-10-03', { reviews: 20, wordKeys: ['shared-word'], articlesCompleted: 1 })
  ] }) });
  const words = app.weeks('words'), latest = words.at(-1), previous = words.at(-2);
  assert.equal(latest.wordsStudied, 3);
  assert.deepEqual([...latest.wordKeys].sort(), ['second-word', 'shared-word', 'third-word']);
  assert.equal(latest.count, 3);
  assert.equal(latest.reviews, 60);
  assert.equal(latest.total, 63);
  assert.equal(previous.wordsStudied, 1, 'A Sunday review belongs to the preceding week');
  assert.equal(previous.count, 1, 'Words studied in another week still count in that week');
  assert.equal(app.weeks('all').at(-1).count, 6);
  assert.equal(app.weeks('reading').at(-1).count, 3);
  await app.click('#activity-filter-words');
  await app.click('#activity-mode-weekly');
  assert.equal(app.query('#activity-week-2026-09-28').dataset.count, '3');
  assert.equal(app.query('#activity-detail span').textContent, '学习 3 个词');
  await app.hover('#activity-week-2026-09-28');
  assert.equal(app.query('#activity-tooltip strong').textContent, '2026.09.28 — 2026.10.03');
  assert.equal(app.query('#activity-tooltip span').textContent, '学习 3 个词');
  await app.key('#activity-week-2026-09-28', 'Escape');
  assert.equal(app.query('#activity-tooltip').hidden, true);
  await app.hover('#activity-week-2026-09-28');
  await app.leave('#activity-week-2026-09-28');
  assert.equal(app.query('#activity-tooltip').hidden, true);
  app.assertReadOnly();
});

test('weekly distinct words only include identities inside the visible annual window', async () => {
  const app = await browser({ records: activity({ today: '2026-01-02', since: '2020-01-01T00:00:00.000Z', days: [
    day('2025-01-02', { reviews: 50, wordKeys: ['old-word', 'visible-word'] }),
    day('2025-01-03', { reviews: 20, wordKeys: ['visible-word'] }),
    day('2025-01-05', { reviews: 20, wordKeys: ['visible-word', 'another-visible-word'] }),
    day('2026-01-02', { reviews: 20, wordKeys: ['today-word'] }),
    day('2026-01-03', { reviews: 50, wordKeys: ['today-word', 'future-word'] })
  ] }) });
  const weeks = app.weeks('words');
  assert.equal(weeks[0].count, 2);
  assert.deepEqual([...weeks[0].wordKeys].sort(), ['another-visible-word', 'visible-word']);
  assert.equal(weeks.at(-1).count, 1);
  assert.deepEqual(weeks.at(-1).wordKeys, ['today-word']);
  assert.equal(weeks.reduce((sum, week) => sum + week.count, 0), 3);
  app.assertReadOnly();
});

test('weekly columns fill bottom-up relative to the busiest week and leave empty weeks blank', async () => {
  const app = await browser({ records: activity({ days: [
    day('2026-09-14', { reviews: 1 }),
    day('2026-09-21', { reviews: 7 }),
    day('2026-09-28', { reviews: 14 })
  ] }) });
  await app.click('#activity-mode-weekly');
  for (const [date, height] of [['2026-09-07', 0], ['2026-09-14', 1], ['2026-09-21', 4], ['2026-09-28', 7]]) {
    const cells = [...app.query(`#activity-week-${date}`).querySelectorAll('.activity-week-cell')];
    assert.equal(cells.length, 7);
    assert.deepEqual(cells.map(cell => cell.dataset.filled === 'true'), Array.from({ length: 7 }, (_, index) => index >= 7 - height));
  }
  await app.click('#activity-filter-reading');
  assert.equal(app.document.querySelectorAll('.activity-week-cell[data-filled="true"]').length, 0);
  assert.ok(app.weeks('reading').every(week => week.count === 0));
  assert.equal(app.query('#activity-detail span').textContent, '暂无学习记录');
  app.assertReadOnly();
});

test('switching daily and weekly keeps the selected date or chooses the selected week end', async () => {
  const app = await browser();
  await app.click('#activity-2026-10-01');
  await app.click('#activity-mode-weekly');
  assert.equal(app.query('[data-activity-week][aria-pressed="true"]').dataset.activityWeek, '2026-09-28');
  await app.click('#activity-mode-daily');
  assert.equal(app.query('[data-activity-date][aria-pressed="true"]').dataset.activityDate, '2026-10-01');
  await app.click('#activity-mode-weekly');
  await app.click('#activity-week-2026-09-21');
  await app.click('#activity-mode-daily');
  assert.equal(app.query('[data-activity-date][aria-pressed="true"]').dataset.activityDate, '2026-09-27');
  await app.click('#activity-mode-weekly');
  await app.click('#activity-week-2025-09-29');
  await app.click('#activity-filter-reading');
  assert.equal(app.query('[data-activity-week][aria-pressed="true"]').dataset.activityWeek, '2025-09-29');
  await app.click('#activity-mode-daily');
  assert.equal(app.query('[data-activity-date][aria-pressed="true"]').dataset.activityDate, '2025-10-05');
  app.assertReadOnly();
});

test('weekly keyboard navigation moves one week with a single accessible selection', async () => {
  const app = await browser();
  await app.click('#activity-mode-weekly');
  for (const [from, key, to] of [
    ['2026-09-28', 'ArrowLeft', '2026-09-21'],
    ['2026-09-21', 'ArrowRight', '2026-09-28'],
    ['2026-09-28', 'ArrowRight', '2026-09-28'],
    ['2026-09-28', 'Home', '2025-09-29'],
    ['2025-09-29', 'ArrowLeft', '2025-09-29'],
    ['2025-09-29', 'End', '2026-09-28']
  ]) {
    const event = await app.key(`#activity-week-${from}`, key);
    assert.equal(event.defaultPrevented, true);
    const weeks = [...app.document.querySelectorAll('[data-activity-week]')];
    assert.equal(weeks.filter(week => week.getAttribute('aria-pressed') === 'true').length, 1);
    assert.equal(weeks.filter(week => week.getAttribute('tabindex') === '0').length, 1);
    assert.equal(app.query('[data-activity-week][aria-pressed="true"]').dataset.activityWeek, to);
    assert.equal(app.focused().dataset.activityWeek, to);
  }
  assert.equal(app.query('#activity-detail').getAttribute('aria-live'), 'polite');
  app.assertReadOnly();
});

test('activity mode is remembered locally without calling models or writing learning records', async () => {
  const first = await browser();
  assert.equal(first.query('#activity-mode-daily').getAttribute('aria-pressed'), 'true');
  await first.click('#activity-mode-weekly');
  const saved = new Map(first.stored()).get('between.activityView');
  assert.equal(JSON.parse(saved).mode, 'weekly');
  const reopened = await browser({ stored: first.stored() });
  assert.equal(reopened.query('#activity-mode-weekly').getAttribute('aria-pressed'), 'true');
  assert.equal(reopened.document.querySelectorAll('[data-activity-week]').length, 53);
  await reopened.click('#activity-mode-daily');
  const reset = await browser({ stored: reopened.stored() });
  assert.equal(reset.query('#activity-mode-daily').getAttribute('aria-pressed'), 'true');
  assert.equal(reset.document.querySelectorAll('[data-activity-date]').length, 365);
  for (const app of [first, reopened, reset]) app.assertReadOnly();
});

test('weekly history distinguishes a wholly unrecorded week from a partly recorded week', async () => {
  const app = await browser({ records: activity({ since: '2026-09-30T18:00:00.000Z' }) });
  await app.click('#activity-mode-weekly');
  await app.click('#activity-week-2026-09-21');
  assert.equal(app.query('#activity-detail span').textContent, '尚未开始记录');
  assert.equal(app.weeks().at(-2).untracked, true);
  await app.click('#activity-week-2026-09-28');
  assert.equal(app.query('#activity-detail span').textContent, '暂无学习记录');
  assert.equal(app.weeks().at(-1).untracked, false);
  app.assertReadOnly();
});
