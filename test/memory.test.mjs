import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../server/db.mjs';
import { createLearningMemory, personalizePrompt } from '../server/memory.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'between-memory-'));
  const store = openStore(directory), filePath = join(directory, 'memroy.md');
  let at = '2026-10-01T15:00:00Z';
  const options = { filePath, clock: () => at };
  const memory = createLearningMemory(store, options);
  return { store, memory, filePath, options, setTime: v => { at = v; }, async close() { await new Promise(resolve => setImmediate(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const save = (memory, patch) => { const { notes, recording, personalize, revision } = memory.view(); return memory.update({ notes, recording, personalize, revision, ...patch }); };

test('new memory excludes legacy QA records and retains only learning fields', async () => {
  const f = fixture();
  try {
    f.store.put('word', { id: 'word:demo', review: { rating: 'known' } });
    f.store.put('quiz', { id: 'qa-quiz', graded: true, results: [{ score: 0 }] });
    assert.equal(f.memory.view().summary.stats.events, 0);
    assert.deepEqual(f.memory.context().observed.reviewWords, []);
    f.memory.record('word_review', { word: 'orbit', rating: 'fuzzy', credential: 'secret-fixture', articleText: 'body-fixture' }, 'r1');
    const view = f.memory.view();
    assert.equal(view.summary.stats.reviews, 1);
    assert.equal(view.summary.reviewWords[0].word, 'orbit');
    assert.ok(!view.markdown.includes('secret-fixture'));
    assert.ok(!view.markdown.includes('body-fixture'));
  } finally { await f.close(); }
});

test('manual notes and outside text survive events, restart and file regeneration', async () => {
  const f = fixture();
  try {
    save(f.memory, { notes: '我想读懂科学文章。\n先讲句子主干。' });
    writeFileSync(f.filePath, readFileSync(f.filePath, 'utf8') + '\n## 我的手写日记\n这里不发送给模型。\n');
    f.memory.record('question_asked', { articleId: 'a', title: 'Science', question: 'Why this tense?', selection: 'It has changed.' }, 'q1');
    const next = createLearningMemory(f.store, f.options);
    assert.equal(next.view().notes, '我想读懂科学文章。\n先讲句子主干。');
    assert.ok(next.view().markdown.endsWith('这里不发送给模型。\n'));
    assert.ok(!JSON.stringify(next.context()).includes('手写日记'));
    assert.equal(next.view().summary.stats.questions, 1);
  } finally { await f.close(); }
});

test('optimistic notes revision rejects external edits without overwriting them', async () => {
  const f = fixture();
  try {
    const stale = f.memory.view();
    writeFileSync(f.filePath, readFileSync(f.filePath, 'utf8').replace(stale.notes, '外部编辑的新目标'));
    assert.throws(() => f.memory.update({ notes: '旧页面', recording: true, personalize: true, revision: stale.revision }), { status: 409 });
    assert.equal(f.memory.view().notes, '外部编辑的新目标');
    const current = f.memory.view();
    f.memory.record('article_opened', { articleId: 'a', title: 'Reading' });
    assert.doesNotThrow(() => f.memory.update({ notes: '可在自动日志更新后保存', recording: true, personalize: true, revision: current.revision }));
  } finally { await f.close(); }
});

test('damaged markers preserve the file and events and suspend context until repaired', async () => {
  const f = fixture();
  try {
    const original = readFileSync(f.filePath, 'utf8');
    const damaged = original.replace('<!-- between:auto:end -->', 'REMOVED');
    writeFileSync(f.filePath, damaged);
    f.memory.record('word_review', { word: 'repair', rating: 'unknown' });
    assert.ok(f.memory.view().warning.includes('标记'));
    assert.equal(readFileSync(f.filePath, 'utf8'), damaged);
    assert.equal(f.memory.context(), null);
    f.memory.update({ notes: '', revision: '', recording: false, personalize: false });
    f.memory.record('word_review', { word: 'not-recorded', rating: 'known' });
    assert.equal(f.memory.view().summary.stats.events, 1);
    assert.equal(f.memory.view().recording, false);
    assert.equal(readFileSync(f.filePath, 'utf8'), damaged);
    writeFileSync(f.filePath, original);
    assert.equal(f.memory.view().warning, '');
    assert.ok(f.memory.view().markdown.includes('repair'));
  } finally { await f.close(); }
});

test('returning to an older word puts it first in recent practice needs', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 25; i++) f.memory.record('word_review', { word: `word-${i}`, rating: 'fuzzy' });
    f.memory.record('word_review', { word: 'word-0', rating: 'unknown' });
    assert.equal(f.memory.view().summary.reviewWords[0].word, 'word-0');
    assert.equal(f.memory.view().summary.reviewWords.length, 20);
  } finally { await f.close(); }
});

test('recording and personalization switches are independent and do not backfill', async () => {
  const f = fixture();
  try {
    f.memory.record('word_review', { word: 'before', rating: 'fuzzy' });
    save(f.memory, { recording: false });
    f.memory.record('word_review', { word: 'paused', rating: 'unknown' });
    assert.equal(f.memory.view().summary.stats.reviews, 1);
    assert.ok(f.memory.context());
    save(f.memory, { recording: true, personalize: false });
    f.memory.record('word_review', { word: 'after', rating: 'known' });
    assert.equal(f.memory.context(), null);
    assert.equal(f.memory.view().summary.stats.reviews, 2);
    save(f.memory, { personalize: true });
    assert.ok(!JSON.stringify(f.memory.context()).includes('paused'));
  } finally { await f.close(); }
});

test('deduplicated events, latest word ratings and Shanghai dates yield factual summaries', async () => {
  const f = fixture();
  try {
    f.memory.record('word_review', { word: 'Orbit', rating: 'unknown' }, 'r1');
    f.memory.record('word_review', { word: 'Orbit', rating: 'unknown' }, 'r1');
    f.setTime('2026-10-01T16:30:00Z');
    f.memory.record('word_review', { word: 'orbit', rating: 'known' }, 'r2');
    f.memory.record('article_opened', { articleId: 'a', title: 'Only opened' });
    let s = f.memory.view().summary;
    assert.equal(s.stats.reviews, 2); assert.equal(s.stats.days, 2);
    assert.equal(s.stats.articlesCompleted, 0); assert.equal(s.reviewWords.length, 0);
    assert.deepEqual(s.recentWords.map(w => ({ word: w.word, rating: w.rating })), [{ word: 'orbit', rating: 'known' }]);
    f.memory.record('article_completed', { articleId: 'a', title: 'Only opened', completed: true });
    f.memory.record('article_completed', { articleId: 'a', title: 'Only opened', completed: false });
    assert.equal(f.memory.view().summary.stats.articlesCompleted, 0);
  } finally { await f.close(); }
});

test('transaction rollback does not leave a memory event or Markdown claim', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.transaction(() => {
      f.store.put('word', { id: 'word:rollback' });
      f.memory.record('word_review', { word: 'rollback', rating: 'known' });
      throw new Error('rollback');
    }));
    assert.equal(f.memory.view().summary.stats.events, 0);
    assert.ok(!f.memory.view().markdown.includes('rollback'));
  } finally { await f.close(); }
});

test('all learning prompts include bounded memory without changing explicit criteria', async () => {
  const f = fixture();
  try {
    save(f.memory, { notes: 'Prefer C2 history articles. ' + '偏好'.repeat(1900) });
    for (let i = 0; i < 60; i++) f.memory.record('quiz_graded', { articleId: 'a', title: 'Science', score: 0, total: 10, needsReview: Array.from({ length: 10 }, () => ({ question: '题'.repeat(220), feedback: '反馈'.repeat(130) })) }, `quiz:${i}`);
    const prompt = { task: 'Learn', criteria: { level: 'A2', topic: 'travel', count: 10 } };
    for (const type of ['words', 'articles', 'explain', 'quiz', 'word', 'grade']) {
      const result = personalizePrompt(prompt, f.memory, type);
      assert.deepEqual(result.criteria, prompt.criteria);
      assert.ok(result.personalization.includes('always take precedence'));
      assert.ok(result.learningMemory.userNotes.includes('Prefer C2'));
      assert.ok(JSON.stringify(result.learningMemory).length < 14000);
    }
    assert.equal(personalizePrompt(prompt, f.memory, 'connection'), prompt);
    assert.equal(f.memory.view().warning, '');
    assert.equal(f.memory.view().summary.stats.quizzes, 60);
    assert.ok(Buffer.byteLength(f.memory.view().markdown) < 160000);
    assert.equal((f.memory.view().markdown.match(/完成理解测试《/g) || []).length, 40);
    save(f.memory, { personalize: false });
    assert.equal(personalizePrompt(prompt, f.memory, 'words'), prompt);
  } finally { await f.close(); }
});
