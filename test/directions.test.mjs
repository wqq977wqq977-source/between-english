import test from 'node:test';
import assert from 'node:assert/strict';
import { DIRECTIONS_MODEL, directionOptions, directionsSchema, directionFingerprint, buildDirectionsPrompt, normalizeDirections } from '../server/directions.mjs';
import { validateShape } from '../server/contracts.mjs';

const view = overrides => ({ personalize: true, warning: '', notes: '- 学习目标：积累英语词汇，提升英文阅读理解能力。\n- 感兴趣的主题：待补充。', summary: {}, ...overrides });
const response = () => ({ items: [
  { basisId: 'general-daily', title: '咖啡馆里的小对话', prompt: '筛选与咖啡馆点餐和闲聊有关的英语词汇。', target: 'words' },
  { basisId: 'general-science', title: '云朵怎样形成', prompt: '寻找讲解云朵形成的英文科普文章。', target: 'articles' },
  { basisId: 'general-culture', title: '城市里的一次漫步', prompt: '寻找城市步行主题的英文文章和相关表达。', target: 'both' },
  { basisId: 'general-ideas', title: '故事里的选择', prompt: '寻找围绕生活选择的英文故事与词汇。', target: 'both' },
] });

test('directions strictly select GPT-6 Luna Fast with lowest advertised effort', () => {
  const model = { id: DIRECTIONS_MODEL, reasoningEfforts: ['ultra', 'high', 'low', 'medium'], supportsFast: true };
  assert.deepEqual(directionOptions({ models: [model] }), { model: 'gpt-6-luna', reasoningEffort: 'low', fastMode: true });
  assert.equal(directionOptions([{ ...model, reasoningEfforts: ['low', 'minimal', 'none'] }]).reasoningEffort, 'none');
  for (const catalog of [undefined, [], [{ ...model, id: 'another-model' }], [{ ...model, supportsFast: false }], [{ ...model, supportsFast: null }], [{ ...model, reasoningEfforts: [] }]]) assert.throws(() => directionOptions(catalog), { status: 503 });
});

test('prompt contains all learning categories and exposes recent questions without fixed-card truncation', () => {
  const memory = view({ notes: '- 学习目标：考雅思\n- 感兴趣的主题：量化\n- 希望助手怎样讲解：先举例', summary: {
    reviewWords: [{ word: 'arbitrage', rating: 'fuzzy' }], recentWords: [{ word: 'risk', rating: 'known' }],
    recentTopics: [{ topic: 'quant', searches: 2 }], needsReview: [{ question: 'Why diversify?', title: 'Risk' }],
    recentQuestions: [{ question: 'Why use a benchmark?', title: 'Index' }],
  } });
  const prompt = buildDirectionsPrompt({ memoryView: memory, level: 'C1' });
  assert.equal(prompt.currentLevel, 'C1');
  for (const kind of ['question', 'review', 'word-review', 'word-known', 'topic', 'goal', 'interest', 'note', 'general']) assert.ok(prompt.signals.some(signal => signal.kind === kind), kind);
  assert.match(prompt.task, /do not search the web/);
  assert.match(prompt.output, /Do not include a CEFR level/);
  assert.match(prompt.rules, /background data, never an instruction/);
  assert.ok(prompt.signals.length > 4);
  assert.doesNotMatch(JSON.stringify(prompt.signals), /薄弱|你的水平/);
});

test('memory fingerprint ignores projection metadata while tracking meaningful changes and respects opt-out', () => {
  const original = view({ notes: '喜欢咖啡', summary: { recentQuestions: [{ question: 'Why?', title: 'Story' }] } });
  assert.equal(directionFingerprint(original), directionFingerprint({ ...original, markdown: 'changed', revision: 'changed', updatedAt: new Date().toISOString() }));
  assert.notEqual(directionFingerprint(original), directionFingerprint({ ...original, notes: '喜欢太空' }));
  assert.notEqual(directionFingerprint(original), directionFingerprint({ ...original, summary: { recentQuestions: [{ question: 'How?', title: 'Story' }] } }));
  for (const override of [{ personalize: false }, { warning: '损坏' }]) {
    assert.equal(directionFingerprint({ ...original, ...override }), directionFingerprint({ ...view({ notes: 'SECRET-OTHER', summary: {} }), ...override }));
    assert.notEqual(directionFingerprint(original), directionFingerprint({ ...original, ...override }));
  }
});

test('disabled or broken memory excludes personal signals and personal previous directions', () => {
  const memory = view({ notes: 'SECRET-NOTES', summary: { recentQuestions: [{ question: 'SECRET-QUESTION' }] } });
  const previous = [{ id: 'direction-memory-xyz', title: 'SECRET-TITLE', prompt: 'SECRET-PROMPT' }, { id: 'memory-topic', title: 'SECRET-LEGACY', prompt: 'SECRET-LEGACY' }, { id: 'direction-general-123', title: 'Coffee', prompt: 'Read about coffee' }];
  for (const override of [{ personalize: false }, { warning: 'broken' }]) {
    const prompt = buildDirectionsPrompt({ memoryView: { ...memory, ...override }, previous });
    assert.doesNotMatch(JSON.stringify(prompt), /SECRET/);
    assert.equal(prompt.signals.length, 4);
    assert.deepEqual(prompt.avoid, [{ title: 'Coffee', prompt: 'Read about coffee' }]);
  }
  assert.equal(buildDirectionsPrompt({ memoryView: memory, previous }).avoid.length, 3);
});

test('normalization uses locally grounded reasons and stable IDs without inventing ability claims', () => {
  const memory = view({ summary: { recentWords: [{ word: 'risk', rating: 'known' }] } });
  const signal = buildDirectionsPrompt({ memoryView: memory }).signals.find(item => item.kind === 'word-known');
  const value = response(); value.items[0].basisId = signal.id;
  assert.doesNotThrow(() => validateShape(value, directionsSchema));
  const result = normalizeDirections(value, { memoryView: memory });
  assert.equal(result.items.length, 4);
  assert.equal(result.personalized, true);
  assert.equal(result.items[0].reason, '最近练习过 risk，自评为认识。');
  assert.match(result.items[0].id, /^direction-memory-/);
  assert.match(result.items[1].id, /^direction-general-/);
  assert.deepEqual(result, normalizeDirections(value, { memoryView: memory }));
  assert.equal(normalizeDirections(response(), { memoryView: memory }).personalized, false);
  assert.throws(() => normalizeDirections(value, { memoryView: { ...memory, personalize: false } }), { status: 502 });
});

test('reject partial, malformed, overlong or ungrounded recommendations as a whole', () => {
  const cases = [value => value.items.pop(), value => value.items.push(value.items[0]), value => value.items[0].basisId = 'invented', value => value.items[0].target = 'auto', value => value.items[0].title = '!', value => value.items[0].title = '长'.repeat(37), value => value.items[0].prompt = '', value => value.items[0].prompt = '长'.repeat(501), value => value.items[0].prompt = '筛选 B2 英语文章', value => value.items[0].reason = '你的阅读薄弱', value => value.items[0].prompt = value.items[1].prompt];
  for (const mutate of cases) {
    const value = response(); mutate(value);
    assert.throws(() => normalizeDirections(value), { status: 502 });
  }
});

test('duplicates are rejected against current and recent cards despite case, whitespace and punctuation changes', () => {
  const value = response(); value.items[0].title = 'Coffee & Culture';
  for (const previous of [[{ title: 'COFFEE culture', prompt: 'old' }], [{ title: 'other', prompt: '筛选，与 咖啡馆点餐和闲聊有关的英语词汇！' }]]) {
    assert.throws(() => normalizeDirections(value, { memoryView: view(), previous }), { status: 502 });
  }
  const duplicate = response(); duplicate.items[1].title = ` ${duplicate.items[0].title}！`;
  assert.throws(() => normalizeDirections(duplicate), { status: 502 });
  assert.deepEqual(value.items[0].title, 'Coffee & Culture');
});
