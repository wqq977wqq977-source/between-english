export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const string = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export function integer(value, min, max, fallback) {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`请输入 ${min}–${max} 之间的整数。`);
  return n;
}
export function sourceURL(value) {
  try { const u = new URL(value); if (['https:', 'http:'].includes(u.protocol) && !u.username && !u.password) return u.href; } catch {}
  return '';
}
export function filters(kind, input = {}) {
  const level = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(input.level) ? input.level : 'B2';
  const common = { level, count: integer(input.count, 1, kind === 'words' ? 100 : 10, kind === 'words' ? 20 : 3), topic: string(input.topic, 150) || '日常生活', extra: string(input.extra, 500) };
  if (kind === 'words') return { ...common, range: string(input.range, 150) || '主题词汇', excludeKnown: input.excludeKnown !== false };
  const minWords = integer(input.minWords, 50, 5000, 300);
  const maxWords = integer(input.maxWords, 50, 8000, 1000);
  if (minWords > maxWords) throw new UserError('最短篇幅不能大于最长篇幅。');
  return { ...common, minWords, maxWords, type: string(input.type, 60) || '不限', domain: string(input.domain, 150), since: string(input.since, 40) };
}
const s = { type: 'string' }, n = { type: 'number' };
const obj = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = items => ({ type: 'array', items });
export const schemas = {
  words: obj({ words: arr(obj({ word: s, phonetic: s, partOfSpeech: s, meaning: s, definition: s, example: s, exampleTranslation: s, level: s, sourceUrl: s, sourceTitle: s })), note: s }),
  articles: obj({ articles: arr(obj({ title: s, url: s, source: s, publishedAt: s, summary: s, level: s, estimatedWords: n, reason: s })), note: s }),
  explain: obj({ answer: s, vocabulary: arr(obj({ word: s, meaning: s })), evidence: s }),
  quiz: obj({ questions: arr(obj({ question: s, type: s, options: arr(s), answer: s, explanation: s, evidence: s })) }),
  grade: obj({ results: arr(obj({ questionId: s, score: n, feedback: s, referenceAnswer: s, evidence: s })) }),
  word: obj({ word: s, phonetic: s, partOfSpeech: s, meaning: s, definition: s, example: s, exampleTranslation: s, level: s }),
  connection: obj({ ok: { type: 'boolean' }, message: s })
};
// Model responses are untrusted. Validate the complete shape before persisting.
export function validateShape(value, schema, path = 'result') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UserError('模型返回的数据格式不完整，请重试。', 502);
    if (Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) throw new UserError('模型返回了未知字段，请重试。', 502);
    for (const key of schema.required) validateShape(value[key], schema.properties[key], `${path}.${key}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > 120) throw new UserError('模型返回的列表无效，请重试。', 502);
    value.forEach(v => validateShape(v, schema.items, path));
  } else if (typeof value !== schema.type || (schema.type === 'number' && !Number.isFinite(value)) || (schema.type === 'string' && value.length > 20000)) {
    throw new UserError('模型返回的数据格式不完整，请重试。', 502);
  }
  return value;
}
export function normalizeWord(word) { return string(word, 100).toLocaleLowerCase('en').replace(/\s+/g, ' '); }
export function mergeWordRecord(old, word, origin = {}, timestamp = new Date().toISOString()) {
  const norm = normalizeWord(word.word);
  if (!norm || !word.meaning?.trim()) throw new UserError('返回的词条不完整，请重试。', 502);
  const retained = old?.articleId && !origin.articleId ? Object.fromEntries(['articleId','articleTitle','sourceUrl','sourceTitle','example','exampleTranslation'].map(key => [key, old[key]])) : {};
  const contexts = [...(old?.contexts || [])];
  if (origin.articleId && !contexts.some(c => c.articleId === origin.articleId && c.example === word.example)) contexts.push({ ...origin, example: word.example, exampleTranslation: word.exampleTranslation });
  return { ...word, ...origin, ...retained, contexts, exampleKind: origin.articleId || retained.articleId ? 'original' : 'generated', id: `word:${norm}`, word: string(word.word, 100), createdAt: old?.createdAt || timestamp, review: old?.review || null, saved: old?.saved || Boolean(origin.articleId) };
}
export function reviewSchedule(previous, rating, now = Date.now()) {
  if (!['unknown', 'fuzzy', 'known'].includes(rating)) throw new UserError('请选择有效的掌握程度。');
  const streak = rating === 'known' ? (previous?.streak || 0) + 1 : 0;
  const days = rating === 'unknown' ? 0 : rating === 'fuzzy' ? 1 : Math.min(60, 2 ** streak);
  return { rating, streak, reviewedAt: new Date(now).toISOString(), dueAt: new Date(now + (days ? days * 86400000 : 10 * 60000)).toISOString() };
}
