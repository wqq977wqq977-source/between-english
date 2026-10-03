import { createHash } from 'node:crypto';

const TIME_ZONE = 'Asia/Singapore';
const dateFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const fields = { word_review: 'reviews', question_asked: 'questions', quiz_graded: 'quizzes', article_completed: 'articlesCompleted' };

// Activity measures recorded practice, not time spent or knowledge mastered.
export function summarizeActivity(events, { since, recording, now = new Date().toISOString() }) {
  const start = Date.parse(since), end = Date.parse(now);
  const days = new Map(), completed = new Set(), wordKeysByDay = new Map();
  for (const event of events) {
    const field = fields[event.type], at = Date.parse(event.at);
    if (!field || !Number.isFinite(at) || at < start || at > end) continue;
    const date = dateFormatter.format(new Date(at));
    if (event.type === 'article_completed') {
      const articleId = event.data?.articleId;
      if (event.data?.completed !== true || !articleId) continue;
      const key = JSON.stringify([date, articleId]);
      if (completed.has(key)) continue;
      completed.add(key);
    }
    if (!days.has(date)) days.set(date, { date, reviews: 0, questions: 0, quizzes: 0, articlesCompleted: 0, total: 0, wordsStudied: 0, wordKeys: [] });
    const day = days.get(date);
    day[field]++;
    day.total++;
    if (event.type === 'word_review' && typeof event.data?.word === 'string') {
      const word = event.data.word.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
      if (!word) continue;
      // Stable keys let the calendar count distinct words across days without returning vocabulary text.
      const key = createHash('sha256').update(word).digest('hex');
      if (!wordKeysByDay.has(date)) wordKeysByDay.set(date, new Set());
      const keys = wordKeysByDay.get(date);
      if (keys.has(key)) continue;
      keys.add(key);
      day.wordKeys.push(key);
      day.wordsStudied++;
    }
  }
  return { timeZone: TIME_ZONE, since, recording: Boolean(recording), today: dateFormatter.format(new Date(end)), days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

export function createLearningActivity(store, { clock = () => new Date().toISOString() } = {}) {
  const rows = store.db.prepare("SELECT type,at,data FROM learning_events WHERE type IN ('word_review','question_asked','quiz_graded','article_completed') ORDER BY seq");
  return {
    view({ since, recording }) {
      const events = rows.all().map(event => ({ ...event, data: JSON.parse(event.data) }));
      return summarizeActivity(events, { since, recording, now: clock() });
    },
  };
}
