import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCurationPrompt, curationSchema, memoryDirections, normalizeCuration, prepareCuration } from '../server/curation.mjs';
import { validateShape } from '../server/contracts.mjs';

const params = () => prepareCuration({ prompt: '找一些太空主题的材料' });
const word = () => ({ word: 'orbit', phonetic: '', partOfSpeech: 'noun', meaning: '轨道', definition: 'A curved path.', example: 'The planet follows an orbit.', exampleTranslation: '行星沿轨道运行。', level: 'B2', sourceUrl: 'https://example.com/orbit', sourceTitle: 'Orbit' });
const article = () => ({ title: 'Orbits', url: 'https://example.com/space', source: 'Example', publishedAt: '', summary: '轨道介绍', level: 'B2', estimatedWords: 500, reason: '主题相关' });
const response = () => ({ title: '太空探索', wordsRequested: true, articlesRequested: true, ...buildCurationPrompt(params()).defaults, words: [word()], articles: [article()], note: '' });
const view = overrides => ({ personalize: true, warning: '', notes: '- 学习目标：积累英语词汇，提升英文阅读理解能力。\n- 感兴趣的主题：待补充。', summary: { reviewWords: [], recentTopics: [], recentQuestions: [], needsReview: [], stats: { reviews: 1, known: 1 } }, ...overrides });

test('curation request validates prompt, scope, CEFR and bounded defaults before invoking Codex', () => {
  assert.deepEqual(prepareCuration({ prompt: '  航天  ' }), { prompt: '航天', target: 'auto', defaultWordCount: 10, defaultArticleCount: 2, defaultLevel: 'B2' });
  assert.equal(prepareCuration({ prompt: '航天', defaultWordCount: '100', defaultArticleCount: 10, defaultLevel: 'C1' }).defaultWordCount, 100);
  for (const input of [null, [], {}, { prompt: '' }, { prompt: '   ' }, { prompt: 'x'.repeat(2001) }, { prompt: 12 }, { prompt: 'x', target: 'unknown' }, { prompt: 'x', target: null }, { prompt: 'x', defaultLevel: 'advanced' }, { prompt: 'x', defaultLevel: null }]) assert.throws(() => prepareCuration(input));
  for (const count of [0, 101, 1.5, null, false, '', 'abc']) assert.throws(() => prepareCuration({ prompt: 'x', defaultWordCount: count }));
  for (const count of [0, 11, 2.5, true]) assert.throws(() => prepareCuration({ prompt: 'x', defaultArticleCount: count }));
});

test('one search prompt keeps explicit criteria separate from defaults and normalizes exclusions', () => {
  const p = prepareCuration({ prompt: '只要 3 个 C1 天文学单词', target: 'words', defaultLevel: 'B1' });
  const prompt = buildCurationPrompt(p, { exclude: ['Orbit', ' orbit ', '', null, 'Solar   system'] });
  assert.equal(prompt.learnerRequest, p.prompt);
  assert.equal(prompt.defaults.wordFilters.count, 10);
  assert.equal(prompt.defaults.wordFilters.level, 'B1');
  assert.equal(prompt.target, 'words');
  assert.deepEqual(prompt.excludedKnownWords, ['orbit', 'solar system']);
  assert.match(prompt.task, /actual web searches/);
  assert.match(prompt.task, /explicit criteria.*override the defaults/);
  assert.match(prompt.articleRules, /generated article bodies/);
  assert.doesNotThrow(() => validateShape(response(), curationSchema));
});

test('curation results preserve interpreted filters, cap counts and discard unrequested arrays', () => {
  const value = response();
  value.wordFilters = { count: 1, level: 'C1', topic: '天文', range: '学术词汇', extra: '名词', excludeKnown: false };
  value.words.push({ ...word(), word: 'planet' });
  value.articlesRequested = false;
  const normalized = normalizeCuration(value, prepareCuration({ prompt: '只要单词', target: 'words' }));
  assert.equal(normalized.words.length, 1);
  assert.deepEqual(normalized.wordFilters, value.wordFilters);
  assert.deepEqual(normalized.articles, []);
  assert.equal(normalizeCuration({ ...response(), wordsRequested: false }, prepareCuration({ prompt: '文章', target: 'articles' })).words.length, 0);
});

test('reject model scope mismatches and malformed or out-of-range criteria with upstream errors', () => {
  const invalid = [];
  for (const [key, value] of [['level', 'advanced'], ['count', 0], ['count', 101], ['count', 2.5], ['excludeKnown', 'false']]) {
    const output = response(); output.wordFilters[key] = value; invalid.push(output);
  }
  for (const [key, value] of [['level', 'C3'], ['count', 11], ['minWords', 49], ['maxWords', 8001], ['minWords', 1100]]) {
    const output = response(); output.articleFilters[key] = value; invalid.push(output);
  }
  invalid.push({ ...response(), wordsRequested: false, articlesRequested: false }, { ...response(), unexpected: true });
  for (const output of invalid) assert.throws(() => normalizeCuration(output, params()), error => error.status === 502);
  assert.throws(() => normalizeCuration(response(), prepareCuration({ prompt: '只要单词', target: 'words' })), error => error.status === 502);
  assert.throws(() => normalizeCuration({ ...response(), articlesRequested: false }, prepareCuration({ prompt: '两个都要', target: 'both' })), error => error.status === 502);
  assert.throws(() => normalizeCuration({ ...response(), wordsRequested: 'true' }, params()), error => error.status === 502);
});

test('empty memories, known words and default notes yield explicit starter directions without invented weaknesses', () => {
  for (const memory of [undefined, view(), view({ summary: { reviewWords: [{ word: 'known-only', rating: 'known' }] } })]) {
    const directions = memoryDirections(memory);
    assert.equal(directions.personalized, false);
    assert.equal(directions.note, '起步方向');
    assert.equal(directions.items.length, 3);
    assert.ok(directions.items.every(item => item.reason.startsWith('起步方向')));
    assert.doesNotMatch(directions.items.map(item => item.prompt).join('\n'), /\b(?:A1|A2|B1|B2|C1|C2)\b/);
    assert.doesNotMatch(JSON.stringify(directions), /known-only|薄弱|你的水平/);
  }
});

test('disabled personalization or broken memory never leaks past observations or notes into direction cards', () => {
  const populated = view({ notes: '- 感兴趣的主题：私人爱好XYZ', summary: { reviewWords: [{ word: 'secretword', rating: 'unknown' }] } });
  for (const override of [{ personalize: false }, { personalize: undefined }, { warning: '文件损坏' }]) {
    const directions = memoryDirections({ ...populated, ...override });
    assert.equal(directions.personalized, false);
    assert.doesNotMatch(JSON.stringify(directions), /secretword|私人爱好XYZ/);
  }
});

test('recent known-word practice provides a factual reading direction without treating it as a weakness', () => {
  const observed = view({ summary: { recentWords: [{ word: 'universe', rating: 'known' }] } });
  const directions = memoryDirections(observed);
  assert.equal(directions.personalized, true);
  assert.equal(directions.items[0].id, 'memory-recent-words');
  assert.equal(directions.items[0].reason, '最近练习了 universe。');
  assert.match(directions.items[0].prompt, /相关的新词/);
  assert.doesNotMatch(JSON.stringify(directions), /不认识|模糊|待巩固|你的水平/);
  assert.doesNotMatch(JSON.stringify(memoryDirections({ ...observed, personalize: false })), /universe/);
});

test('personalized directions cite actual self-ratings, search counts and questions without CEFR inference', () => {
  const directions = memoryDirections(view({ summary: {
    reviewWords: [{ word: 'orbit', rating: 'fuzzy' }, { word: 'knownword', rating: 'known' }],
    recentTopics: [{ topic: '航天', searches: 2 }],
    recentQuestions: [{ title: 'Moon', question: '为什么这里用完成时？' }],
    needsReview: [{ title: 'Orbit', question: 'Why does it orbit Earth?' }],
  } }));
  assert.equal(directions.personalized, true);
  assert.equal(directions.items.length, 4);
  assert.match(directions.items.find(item => item.id === 'memory-words').reason, /orbit.*模糊或不认识/);
  assert.match(directions.items.find(item => item.id === 'memory-topic').reason, /航天.*2 次/);
  assert.match(directions.items.find(item => item.id === 'memory-review').reason, /待回顾题/);
  assert.match(directions.items.find(item => item.id === 'memory-question').reason, /最近问过/);
  assert.doesNotMatch(JSON.stringify(directions), /knownword|薄弱|你的水平/);
  assert.doesNotMatch(directions.items.map(item => item.prompt).join('\n'), /\b(?:A1|A2|B1|B2|C1|C2)\b/);
});

test('explicit goal and interests become grounded suggestions, while generic filler stays labelled', () => {
  const goal = memoryDirections(view({ notes: '- 学习目标：准备雅思阅读。' }));
  assert.equal(goal.personalized, true);
  assert.match(goal.items[0].reason, /准备雅思阅读/);
  assert.ok(goal.items.slice(1).every(item => item.reason.startsWith('起步方向')));
  const interests = memoryDirections(view({ notes: '- 感兴趣的主题：新能源汽车' }));
  assert.match(interests.items[0].reason, /在备注中.*新能源汽车/);
  for (const directions of [goal, interests]) assert.doesNotMatch(directions.items.map(item => item.prompt).join('\n'), /\b(?:A1|A2|B1|B2|C1|C2)\b/);
  assert.equal(memoryDirections(view({ notes: '- 感兴趣的主题：暂无。\n- 学习目标：待填写' })).personalized, false);
});
