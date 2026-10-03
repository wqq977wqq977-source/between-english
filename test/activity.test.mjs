import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../server/db.mjs';
import { createLearningMemory } from '../server/memory.mjs';
import { createLearningActivity, summarizeActivity } from '../server/activity.mjs';

const options = { since: '2024-02-01T00:00:00Z', recording: true, now: '2024-03-02T12:00:00Z' };
const event = (type, at, data = {}) => ({ type, at, data });
const sum = activity => activity.days.reduce((total, day) => total + day.total, 0);
const wordKey = word => createHash('sha256').update(word).digest('hex');

test('activity groups UTC timestamps in Singapore, handles leap day, and sorts dates', () => {
  const activity = summarizeActivity([
    event('question_asked', '2024-02-29T16:00:00Z'),
    event('word_review', '2024-02-28T15:59:59Z'),
    event('quiz_graded', '2024-02-28T16:00:00Z', { total: 8, score: 5 }),
    event('word_review', '2024-02-29T15:59:59Z'),
  ], options);
  assert.equal(activity.timeZone, 'Asia/Singapore');
  assert.equal(activity.today, '2024-03-02');
  assert.deepEqual(activity.days, [
    { date: '2024-02-28', reviews: 1, questions: 0, quizzes: 0, articlesCompleted: 0, total: 1, wordsStudied: 0, wordKeys: [] },
    { date: '2024-02-29', reviews: 1, questions: 0, quizzes: 1, articlesCompleted: 0, total: 2, wordsStudied: 0, wordKeys: [] },
    { date: '2024-03-01', reviews: 0, questions: 1, quizzes: 0, articlesCompleted: 0, total: 1, wordsStudied: 0, wordKeys: [] },
  ]);
});

test('only actual practice counts; searches, opening, importing, saving and making a quiz do not', () => {
  const at = '2024-02-29T12:00:00Z';
  const activity = summarizeActivity([
    ...['search_requested', 'search_completed', 'word_saved', 'article_opened', 'article_imported', 'article_saved', 'quiz_created'].map(type => event(type, at)),
    event('article_completed', at, { articleId: 'a', completed: false }),
    event('word_review', at, { word: 'orbit', rating: 'unknown' }),
    event('word_review', at, { word: 'orbit', rating: 'known' }),
    event('question_asked', at, { question: 'A request still counts when the answer fails.' }),
    event('quiz_graded', at, { total: 10, score: 0 }),
  ], options);
  assert.deepEqual(activity.days, [{ date: '2024-02-29', reviews: 2, questions: 1, quizzes: 1, articlesCompleted: 0, total: 4, wordsStudied: 1, wordKeys: [wordKey('orbit')] }]);
  assert.doesNotMatch(JSON.stringify(activity), /orbit|request still counts/);
});

test('studied words ignore repeated ratings and normalize case, fullwidth letters and whitespace', () => {
  const at = '2024-02-29T12:00:00Z';
  const activity = summarizeActivity([
    ...['ＯＲＢＩＴ', ' orbit ', 'Orbit'].map(word => event('word_review', at, { word })),
    ...['Space\t station', ' ｓｐａｃｅ　ＳＴＡＴＩＯＮ ', 'space\n\nstation'].map(word => event('word_review', at, { word })),
    event('word_review', at, { word: 'planet' }),
    event('word_saved', at, { word: 'another' }),
  ], options);
  const [day] = activity.days;
  assert.equal(day.reviews, 7, 'Raw review counts remain compatible with activity totals');
  assert.equal(day.total, 7);
  assert.equal(day.wordsStudied, 3);
  assert.deepEqual(day.wordKeys, [wordKey('orbit'), wordKey('space station'), wordKey('planet')]);
  assert.doesNotMatch(JSON.stringify(activity), /orbit|space|station|planet|another/i);
});

test('word keys stay stable across days and weeks so each week can count its own distinct words', () => {
  const activity = summarizeActivity([
    event('word_review', '2024-02-19T08:00:00Z', { word: 'orbit' }),
    event('word_review', '2024-02-20T08:00:00Z', { word: 'ORBIT' }),
    event('word_review', '2024-02-20T08:01:00Z', { word: 'planet' }),
    event('word_review', '2024-02-26T08:00:00Z', { word: 'orbit' }),
    event('word_review', '2024-02-27T08:00:00Z', { word: 'galaxy' }),
  ], options);
  assert.deepEqual(activity.days.map(day => day.wordsStudied), [1, 2, 1, 1]);
  const firstWeek = new Set(activity.days.filter(day => day.date < '2024-02-26').flatMap(day => day.wordKeys));
  const secondWeek = new Set(activity.days.filter(day => day.date >= '2024-02-26').flatMap(day => day.wordKeys));
  assert.equal(firstWeek.size, 2, 'A repeat on another day in the same week remains one word');
  assert.equal(secondWeek.size, 2, 'A repeat in a later week counts in that week as well');
  assert.ok(firstWeek.has(wordKey('orbit')) && secondWeek.has(wordKey('orbit')));
  assert.equal(new Set(activity.days.flatMap(day => day.wordKeys)).size, 3);
});

test('missing or invalid vocabulary does not invent studied words and reading rows include empty word fields', () => {
  const at = '2024-02-29T12:00:00Z';
  const activity = summarizeActivity([
    ...[undefined, null, '', '　 \n\t', 42, {}, ['orbit']].map(word => event('word_review', at, { word })),
    event('question_asked', '2024-03-01T12:00:00Z', { word: 'orbit' }),
  ], options);
  assert.deepEqual(activity.days.map(day => [day.reviews, day.wordsStudied, day.wordKeys]), [[7, 0, []], [0, 0, []]]);
  assert.equal(sum(activity), 8);
});

test('article completion is counted once per article and local day, even after undo and redo', () => {
  const activity = summarizeActivity([
    event('article_completed', '2024-02-29T09:00:00Z', { articleId: 'a', completed: true }),
    event('article_completed', '2024-02-29T09:01:00Z', { articleId: 'a', completed: false }),
    event('article_completed', '2024-02-29T09:02:00Z', { articleId: 'a', completed: true }),
    event('article_completed', '2024-02-29T09:03:00Z', { articleId: 'b', completed: true }),
    event('article_completed', '2024-02-29T09:04:00Z', { articleId: '', completed: true }),
    event('article_completed', '2024-02-29T16:00:00Z', { articleId: 'a', completed: true }),
  ], options);
  assert.deepEqual(activity.days.map(day => [day.date, day.articlesCompleted, day.total]), [['2024-02-29', 2, 2], ['2024-03-01', 1, 1]]);
});

test('enabledAt is inclusive, earlier and future events are excluded, and empty history stays empty', () => {
  const range = { since: '2024-02-29T08:00:00Z', now: '2024-02-29T16:00:00Z', recording: false };
  const activity = summarizeActivity([
    event('word_review', '2024-02-29T07:59:59Z', { word: 'earlier' }),
    event('word_review', range.since, { word: 'orbit' }),
    event('word_review', range.now, { word: 'planet' }),
    event('word_review', '2024-02-29T16:00:01Z', { word: 'future' }),
    event('word_review', 'invalid', { word: 'invalid' }),
  ], range);
  assert.equal(activity.since, range.since);
  assert.equal(activity.recording, false);
  assert.equal(activity.today, '2024-03-01');
  assert.equal(sum(activity), 2);
  assert.deepEqual(activity.days.map(day => [day.date, day.wordsStudied, day.wordKeys]), [
    ['2024-02-29', 1, [wordKey('orbit')]], ['2024-03-01', 1, [wordKey('planet')]],
  ]);
  assert.deepEqual(summarizeActivity([], range).days, []);
});

test('database activity respects paused recording and does not send calendar data into model memory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'between-activity-memory-'));
  const store = openStore(directory);
  let at = '2024-02-29T08:00:00Z';
  const memory = createLearningMemory(store, { filePath: join(directory, 'memroy.md'), clock: () => at });
  const activity = createLearningActivity(store, { clock: () => at });
  const view = () => activity.view({ since: memory.enabledAt(), recording: memory.view().recording });
  const update = patch => { const { notes, recording, personalize, revision } = memory.view(); memory.update({ notes, recording, personalize, revision, ...patch }); };
  try {
    store.put('word', { id: 'legacy', review: { rating: 'known' } });
    memory.record('word_review', { word: 'orbit', rating: 'known' }, 'review-1');
    memory.record('word_review', { word: 'orbit', rating: 'known' }, 'review-1');
    assert.equal(sum(view()), 1, 'An idempotent event key is still counted only once');
    update({ recording: false });
    at = '2024-03-01T08:00:00Z';
    memory.record('word_review', { word: 'paused', rating: 'unknown' });
    assert.equal(view().recording, false);
    assert.equal(view().today, '2024-03-01', 'The calendar advances even without new events');
    assert.equal(sum(view()), 1);
    update({ recording: true, personalize: false });
    memory.record('word_review', { word: 'new', rating: 'fuzzy' });
    assert.equal(sum(view()), 2, 'Resuming does not reconstruct actions made while paused');
    assert.equal(memory.context(), null);
    update({ personalize: true });
    assert.equal(memory.context().observed.activity, undefined);
    assert.equal(memory.context().observed.days, undefined);
  } finally {
    await new Promise(resolve => setImmediate(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('real bootstrap and state routes expose persisted activity and follow recording controls', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'between-activity-http-'));
  const data = join(directory, 'data'), filePath = join(directory, 'memroy.md'), binary = join(directory, 'fake-codex');
  writeFileSync(binary, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('codex fixture');process.exit(0);}\nif(process.argv.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}\nprocess.exit(71);\n`, { mode: 0o700 });
  const store = openStore(data);
  let at = '2024-02-28T16:00:00Z';
  const memory = createLearningMemory(store, { filePath, clock: () => at });
  store.put('word', { id: 'word:orbit', word: 'orbit', review: null });
  store.put('article', { id: 'article-1', title: 'A fixture', text: 'Fixture text', completed: false });
  at = '2024-02-28T15:59:59Z';
  memory.record('word_review', { word: 'legacy', rating: 'known' });
  at = '2024-02-29T08:00:00Z';
  memory.record('question_asked', { articleId: 'article-1', title: 'A fixture', question: 'Why?' });
  await new Promise(resolve => setImmediate(resolve));
  store.close();
  const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}/api`;
  let output = '', token;
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: resolve('.'), env: { ...process.env, PORT: String(port), STUDY_DATA_DIR: data, STUDY_MEMORY_FILE: filePath, CODEX_BINARY: binary, STUDY_OPEN: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const request = async (path, body) => {
    const response = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Study-Token': token }, body: JSON.stringify(body) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const recording = async enabled => { const { notes, personalize, revision } = await request('/memory'); return request('/memory', { notes, personalize, revision, recording: enabled }); };
  try {
    const deadline = Date.now() + 6000;
    while (!output.includes('Between ·') && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(output, /Between ·/);
    const initial = await request('/bootstrap'); token = initial.token;
    assert.equal(initial.activity.timeZone, 'Asia/Singapore');
    assert.equal(initial.activity.since, '2024-02-28T16:00:00Z');
    assert.deepEqual(initial.activity.days, [{ date: '2024-02-29', reviews: 0, questions: 1, quizzes: 0, articlesCompleted: 0, total: 1, wordsStudied: 0, wordKeys: [] }]);
    assert.equal(initial.memory.summary.activity, undefined);
    await request('/words/word%3Aorbit', { rating: 'known' });
    await request('/words/word%3Aorbit', { rating: 'fuzzy' });
    await request('/articles/article-1', { completed: true });
    await request('/articles/article-1', { completed: false });
    await request('/articles/article-1', { completed: true });
    let state = await request('/state');
    assert.equal(sum(state.activity), 4);
    assert.equal(state.activity.days.at(-1).articlesCompleted, 1);
    assert.equal(state.activity.days.at(-1).reviews, 2);
    assert.equal(state.activity.days.at(-1).wordsStudied, 1, 'Repeated HTTP ratings do not increase the number of studied words');
    assert.deepEqual(state.activity.days.at(-1).wordKeys, [wordKey('orbit')]);
    assert.doesNotMatch(JSON.stringify(state.activity), /orbit/);
    await recording(false);
    await request('/words/word%3Aorbit', { rating: 'fuzzy' });
    state = await request('/state');
    assert.equal(state.activity.recording, false);
    assert.equal(sum(state.activity), 4);
    await recording(true);
    await request('/words/word%3Aorbit', { rating: 'unknown' });
    state = await request('/state');
    assert.equal(sum(state.activity), 5);
    assert.equal(state.activity.days.at(-1).wordsStudied, 1);
    assert.deepEqual((await request('/bootstrap')).activity, state.activity);
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await closed; }
    rmSync(directory, { recursive: true, force: true });
  }
});
