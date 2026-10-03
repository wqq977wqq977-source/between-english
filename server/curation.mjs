import { UserError, filters, normalizeWord, schemas, validateShape } from './contracts.mjs';

const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const targets = ['auto', 'both', 'words', 'articles'];
const s = { type: 'string' }, n = { type: 'number' }, b = { type: 'boolean' };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const levelSchema = { type: 'string', enum: levels };
export const curationSchema = object({
  title: s,
  wordsRequested: b,
  articlesRequested: b,
  wordFilters: object({ count: n, level: levelSchema, topic: s, range: s, extra: s, excludeKnown: b }),
  articleFilters: object({ count: n, level: levelSchema, topic: s, extra: s, minWords: n, maxWords: n, type: s, domain: s, since: s }),
  words: schemas.words.properties.words,
  articles: schemas.articles.properties.articles,
  note: s,
});

function boundedInteger(value, min, max, fallback, status = 400) {
  const candidate = value === undefined ? fallback : value;
  if (!['number', 'string'].includes(typeof candidate) || candidate === '' || !Number.isInteger(Number(candidate)) || Number(candidate) < min || Number(candidate) > max) {
    throw new UserError(`请输入 ${min}–${max} 之间的整数。`, status);
  }
  return Number(candidate);
}

export function prepareCuration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UserError('请填写本次学习方向。');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 2000) throw new UserError('请填写 1–2,000 字符的学习方向。');
  const target = input.target === undefined ? 'auto' : input.target;
  const level = input.defaultLevel === undefined ? 'B2' : input.defaultLevel;
  if (!targets.includes(target)) throw new UserError('请选择有效的筛选范围。');
  if (!levels.includes(level)) throw new UserError('请选择有效的参考难度。');
  return {
    prompt: input.prompt.trim(), target,
    defaultWordCount: boundedInteger(input.defaultWordCount, 1, 100, 10),
    defaultArticleCount: boundedInteger(input.defaultArticleCount, 1, 10, 2),
    defaultLevel: level,
  };
}

export function buildCurationPrompt(params, { exclude = [] } = {}) {
  return {
    task: 'Interpret the learner request into concrete wordFilters and articleFilters, then perform actual web searches and select verified English learning materials in this ONE task. Current explicit criteria in learnerRequest override the defaults. Never silently relax the learner criteria; return fewer matches and explain the shortfall briefly in note. Do not ask a follow-up question. Give the selection a short Chinese title.',
    scope: 'target=words means wordsRequested=true and articlesRequested=false. target=articles means the opposite. target=both requires both true. target=auto follows the material types explicitly requested by the learner; if no material type is specified, select both. Unrequested result arrays MUST be empty. Always return both complete filter objects; their count is the requested count, not the number found.',
    wordRules: 'Select words from reputable dictionaries, published vocabulary lists, or relevant English material. Every sourceUrl MUST exactly match a URL returned by actual web search. Provide short Chinese meanings, English definitions, IPA if known (otherwise empty), and your own English example with Chinese translation. Honor topic, range and extra criteria. If excludeKnown is true, omit excludedKnownWords; the learner may explicitly ask to include known words. Levels are estimates. Do not return more than wordFilters.count words.',
    articleRules: 'Select real, directly readable English HTML articles from reputable public educational sources, research communication or open publications. No PDFs, homepages, category pages, paywalls, login-only pages or generated article bodies. Every url MUST exactly match a URL returned by actual web search. Supply a supported publication date or an empty string, a short Chinese summary and match reason, and estimated CEFR and word count. Honor topic, minWords, maxWords, type, domain, since and extra criteria. Do not return more than articleFilters.count articles.',
    filterRules: 'CEFR is one of A1,A2,B1,B2,C1,C2. Word count is an integer from 1 to 100; article count is an integer from 1 to 10. minWords is 50–5000, maxWords is 50–8000, and minWords must not exceed maxWords. Preserve additional natural-language requirements in extra. Use empty domain/since/extra when unspecified. If the request exceeds supported bounds, use the nearest supported bound and explain that limit in note. Difficulty is a chosen filter, never a diagnosis of the learner.',
    learnerRequest: params.prompt,
    target: params.target,
    defaults: {
      wordFilters: { count: params.defaultWordCount, level: params.defaultLevel, topic: '日常生活', range: '主题词汇', extra: '', excludeKnown: true },
      articleFilters: { count: params.defaultArticleCount, level: params.defaultLevel, topic: '日常生活', extra: '', minWords: 300, maxWords: 1000, type: '不限', domain: '', since: '' },
    },
    excludedKnownWords: [...new Set(exclude.filter(word => typeof word === 'string').map(normalizeWord).filter(Boolean))],
  };
}

function normalizedFilters(kind, value) {
  if (!levels.includes(value.level)) throw new UserError('模型返回了无效的难度，请重试。', 502);
  boundedInteger(value.count, 1, kind === 'words' ? 100 : 10, undefined, 502);
  if (kind === 'words') {
    if (typeof value.excludeKnown !== 'boolean') throw new UserError('模型返回了无效的筛选条件，请重试。', 502);
  } else {
    boundedInteger(value.minWords, 50, 5000, undefined, 502);
    boundedInteger(value.maxWords, 50, 8000, undefined, 502);
    if (value.minWords > value.maxWords) throw new UserError('模型返回的篇幅范围不正确，请重试。', 502);
  }
  return filters(kind, value);
}

export function normalizeCuration(value, params) {
  validateShape(value, curationSchema);
  const { wordsRequested, articlesRequested } = value;
  const expected = { both: [true, true], words: [true, false], articles: [false, true] }[params.target];
  if ((!wordsRequested && !articlesRequested) || (expected && (wordsRequested !== expected[0] || articlesRequested !== expected[1]))) {
    throw new UserError('模型返回的内容与筛选范围不一致，请重试。', 502);
  }
  const wordFilters = normalizedFilters('words', value.wordFilters);
  const articleFilters = normalizedFilters('articles', value.articleFilters);
  return {
    title: value.title.trim().slice(0, 100) || '本次学习', wordsRequested, articlesRequested, wordFilters, articleFilters,
    words: wordsRequested ? value.words.slice(0, wordFilters.count) : [],
    articles: articlesRequested ? value.articles.slice(0, articleFilters.count) : [],
    note: value.note.trim().slice(0, 2000),
  };
}

const clean = (value, max = 180) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
const short = (value, max = 50) => { const text = clean(value, 1000); return text.length > max ? `${text.slice(0, max)}…` : text; };

function noteSignals(notes) {
  const found = {};
  for (const line of (typeof notes === 'string' ? notes : '').split(/\r?\n/)) {
    const match = line.replace(/^\s*[-*]\s*/, '').match(/^(学习目标|感兴趣的主题|兴趣主题)\s*[：:]\s*(.+)$/);
    if (!match) continue;
    const text = clean(match[2]);
    if (/^(待补充|待填写|未填写|暂无|无|待积累)[。.!！\s]*$/.test(text) || /^积累英语词汇，提升英文阅读理解能力[。.!！\s]*$/.test(text)) continue;
    if (text) found[match[1] === '学习目标' ? 'goal' : 'interests'] = text;
  }
  return found;
}

export function memoryDirections(memoryView) {
  const items = [];
  const allowed = memoryView?.personalize === true && !memoryView.warning;
  if (allowed) {
    const summary = memoryView.summary || {};
    const reviewWords = [...new Set((Array.isArray(summary.reviewWords) ? summary.reviewWords : []).filter(item => item && ['unknown', 'fuzzy'].includes(item.rating)).map(item => clean(item.word, 100)).filter(Boolean))].slice(0, 4);
    if (reviewWords.length) {
      const words = reviewWords.join('、');
      items.push({ id: 'memory-words', title: '让生词回到语境', reason: `你曾将 ${words} 标为模糊或不认识。`, prompt: `围绕待巩固的 ${words}，筛选 10 个相关词汇和 2 篇英文短文。优先选择能在语境中回顾这些词的材料。`, target: 'both' });
    } else {
      const recentWords = [...new Set((Array.isArray(summary.recentWords) ? summary.recentWords : []).filter(item => item && ['known', 'unknown', 'fuzzy'].includes(item.rating)).map(item => clean(item.word, 100)).filter(Boolean))].slice(0, 4);
      if (recentWords.length) {
        const words = recentWords.join('、');
        items.push({ id: 'memory-recent-words', title: '从熟悉的词出发', reason: `最近练习了 ${words}。`, prompt: `从最近练习的 ${words} 出发，筛选 2 篇英文文章，优先选择包含这些词的材料；再拓展 10 个相关的新词。`, target: 'both' });
      }
    }
    const review = (Array.isArray(summary.needsReview) ? summary.needsReview : []).find(item => item && clean(item.question));
    if (review) {
      const question = clean(review.question, 220), title = clean(review.title, 200);
      items.push({ id: 'memory-review', title: '换个角度再读一次', reason: `练习中有一道待回顾题：「${short(question)}」`, prompt: `围绕${title ? `《${title}》中` : ''}待回顾的问题「${question}」，筛选 2 篇英文文章和 10 个相关词汇，帮助从新的语境理解这个问题。`, target: 'both' });
    }
    const topic = (Array.isArray(summary.recentTopics) ? summary.recentTopics : []).find(item => item && clean(item.topic) && Number.isInteger(item.searches) && item.searches > 0);
    if (topic) {
      const name = clean(topic.topic, 100);
      items.push({ id: 'memory-topic', title: `继续探索${short(name, 14)}`, reason: `你曾检索「${name}」${topic.searches} 次。`, prompt: `继续探索「${name}」，筛选 2 篇英文文章和 10 个相关词汇。尝试与先前不同的切入角度。`, target: 'both' });
    }
    const notes = noteSignals(memoryView.notes);
    if (notes.interests) items.push({ id: 'memory-interests', title: '从兴趣开始', reason: `你在备注中写了兴趣：「${short(notes.interests)}」`, prompt: `围绕我记录的兴趣「${notes.interests}」，筛选 2 篇英文文章和 10 个实用词汇。`, target: 'both' });
    else if (notes.goal) items.push({ id: 'memory-goal', title: '向目标靠近一点', reason: `你的学习目标：「${short(notes.goal)}」`, prompt: `围绕我的学习目标「${notes.goal}」，筛选 2 篇英文文章和 10 个相关词汇。`, target: 'both' });
    const question = (Array.isArray(summary.recentQuestions) ? summary.recentQuestions : []).find(item => item && clean(item.question));
    if (question) items.push({ id: 'memory-question', title: '沿着问题读下去', reason: `你最近问过：「${short(question.question)}」`, prompt: `我最近在阅读${clean(question.title) ? `《${clean(question.title)}》时` : '时'}问过「${clean(question.question, 600)}」。请寻找 2 篇英文文章，提供可以继续理解这个问题的新语境。`, target: 'articles' });
  }
  const personalized = items.length > 0;
  const starters = [
    { id: 'starter-daily', title: '生活里的英语', reason: '起步方向 · 日常表达', prompt: '筛选 10 个日常生活词汇和 2 篇关于生活习惯的英文短文。', target: 'both' },
    { id: 'starter-science', title: '读懂一个新发现', reason: '起步方向 · 科普阅读', prompt: '寻找 2 篇 300–800 词的英文科普文章，并筛选 10 个相关词汇。优先选择公开可读的教育或科研机构文章。', target: 'both' },
    { id: 'starter-world', title: '换个地方看看', reason: '起步方向 · 文化与旅行', prompt: '围绕不同地区的文化与旅行，筛选 2 篇英文文章和 10 个实用词汇。', target: 'both' },
  ];
  const selected = items.slice(0, 4);
  for (const starter of starters) if (selected.length < (personalized ? 4 : 3)) selected.push(starter);
  return { personalized, items: selected, note: personalized ? '根据你的学习记录与备注' : '起步方向' };
}
