'use strict';
/* ==========================================================================
   STORY BREW — server.js
   Express API + persistent JSON datastore + seed library.
   Run:  npm install && npm start   →   http://localhost:3000
   ========================================================================== */

// ─── CONFIG ────────────────────────────────────────────────────────────────
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.STORY_BREW_DB || path.join(__dirname, 'storybrew-data.json');
const INDEX_FILE = path.join(__dirname, 'index.html');
const COOKIE_NAME = 'sb_uid';

const GENRES = [
  { name: 'Romance', blurb: 'Hearts, hesitations and second chances.' },
  { name: 'Fantasy', blurb: 'Quiet magic hiding in ordinary places.' },
  { name: 'Mystery', blurb: 'Loose threads and late-night clues.' },
  { name: 'Thriller', blurb: 'Tension you can hear ticking.' },
  { name: 'Sci-Fi', blurb: 'Tomorrow, told with a human heartbeat.' },
  { name: 'Drama', blurb: 'The weight and warmth of real lives.' },
  { name: 'Horror', blurb: 'Best read with the lights on.' },
  { name: 'Comedy', blurb: 'Gentle chaos and good-natured grins.' },
  { name: 'Adventure', blurb: 'Maps, storms and far horizons.' },
  { name: 'Slice of Life', blurb: 'Small moments that turn out to be big.' },
];
const GENRE_NAMES = GENRES.map((g) => g.name);

const MOODS = [
  { name: 'Cozy', emoji: '☕', blurb: 'Warm blankets and soft endings' },
  { name: 'Rainy Day', emoji: '🌧', blurb: 'For windows streaked with rain' },
  { name: 'Heartbreak', emoji: '💔', blurb: 'The ache that makes us human' },
  { name: 'Magical', emoji: '✨', blurb: 'Wonder tucked into the ordinary' },
  { name: 'Midnight', emoji: '🌙', blurb: 'For the sleepless hours' },
  { name: 'Intense', emoji: '🔥', blurb: 'Hold-your-breath energy' },
  { name: 'Peaceful', emoji: '🌿', blurb: 'Slow, still and restoring' },
  { name: 'Nostalgic', emoji: '💭', blurb: 'Sepia-toned memories' },
];
const MOOD_NAMES = MOODS.map((m) => m.name);

const AVATARS = ['☕', '📚', '🌙', '🦊', '🌿', '✨', '🐈', '🍂', '🕯️', '🌧️'];

// Reading-length buckets (minutes, inclusive)
const LENGTHS = { quick: [0, 5], medium: [6, 10], long: [11, Infinity] };

// ─── DATABASE ──────────────────────────────────────────────────────────────
// A small persistent document store. Everything lives in memory for speed and
// is flushed to disk atomically (write temp file → rename) shortly after any
// change, so a crash can never leave a half-written data file behind.
const db = {
  data: null,
  timer: null,

  load() {
    let loaded = null;
    if (fs.existsSync(DATA_FILE)) {
      try {
        loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      } catch (err) {
        const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
        try { fs.renameSync(DATA_FILE, backup); } catch (_) { /* ignore */ }
        console.warn(`[db] Data file was unreadable; moved it to ${path.basename(backup)} and started fresh.`);
      }
    }
    const base = {
      meta: { version: 1, nextStoryId: 1 },
      users: [], stories: [], library: [], likes: [], reading_progress: [], activity: [],
    };
    this.data = Object.assign(base, loaded && typeof loaded === 'object' ? loaded : {});
    for (const table of ['users', 'stories', 'library', 'likes', 'reading_progress', 'activity']) {
      if (!Array.isArray(this.data[table])) this.data[table] = [];
    }
    if (!this.data.meta || typeof this.data.meta.nextStoryId !== 'number') {
      this.data.meta = { version: 1, nextStoryId: Math.max(0, ...this.data.stories.map((s) => s.id)) + 1 };
    }
  },

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 150);
  },

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const tmp = `${DATA_FILE}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, DATA_FILE);
    } catch (err) {
      console.error('[db] Failed to persist data:', err.message);
    }
  },

  nextStoryId() {
    return this.data.meta.nextStoryId++;
  },
};

// ─── HELPERS ───────────────────────────────────────────────────────────────
class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

/** Wrap a route so thrown errors (sync or async) reach the error handler. */
const route = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (err) { next(err); }
};

const nowISO = () => new Date().toISOString();
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const qstr = (v) => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '')).trim();

/** Local calendar-day key, used for reading streaks. */
function dayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function moodEmoji(name) {
  const m = MOODS.find((x) => x.name === name);
  return m ? m.emoji : '☕';
}

function findStory(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  return db.data.stories.find((s) => s.id === n) || null;
}

function requireStory(id) {
  const s = findStory(id);
  if (!s) throw new HttpError(404, 'We couldn’t find that story. It may have been removed.');
  return s;
}

/** Per-request lookup tables so list endpoints stay O(n). */
function buildCtx(userId) {
  const likeCounts = new Map();
  const liked = new Set();
  for (const l of db.data.likes) {
    likeCounts.set(l.storyId, (likeCounts.get(l.storyId) || 0) + 1);
    if (l.userId === userId) liked.add(l.storyId);
  }
  const saved = new Set(db.data.library.filter((l) => l.userId === userId).map((l) => l.storyId));
  const progress = new Map(
    db.data.reading_progress.filter((p) => p.userId === userId).map((p) => [p.storyId, p])
  );
  return { userId, likeCounts, liked, saved, progress };
}

function progressView(p) {
  if (!p) return null;
  return {
    chapterIndex: p.chapterIndex,
    scrollPct: p.scrollPct,
    percent: p.percent,
    completed: !!p.completed,
    bookmark: p.bookmark || null,
    startedAt: p.startedAt,
    updatedAt: p.updatedAt,
    completedAt: p.completedAt || null,
  };
}

function likesFor(story, ctx) {
  return (story.baseLikes || 0) + (ctx.likeCounts.get(story.id) || 0);
}

/** Public shape of a story (no chapter bodies unless requested). */
function summarize(story, ctx, { full = false } = {}) {
  const out = {
    id: story.id,
    title: story.title,
    author: story.author,
    description: story.description,
    genre: story.genre,
    mood: story.mood,
    moodEmoji: moodEmoji(story.mood),
    rating: story.rating,
    ratingCount: story.ratingCount,
    readingTime: story.readingTime,
    cover: story.cover,
    chapterCount: story.chapters.length,
    chapterTitles: story.chapters.map((c) => c.title),
    createdAt: story.createdAt,
    updatedAt: story.updatedAt || story.createdAt,
    views: story.views,
    likes: likesFor(story, ctx),
    featured: !!story.featured,
    editorNote: story.editorNote || null,
    userCreated: !!story.ownerId,
    isOwner: !!ctx.userId && story.ownerId === ctx.userId,
    liked: ctx.liked.has(story.id),
    saved: ctx.saved.has(story.id),
    progress: progressView(ctx.progress.get(story.id)),
  };
  if (full) out.chapters = story.chapters.map((c) => ({ title: c.title, content: c.content }));
  return out;
}

/** Popularity blends views, likes, rating and freshness (last 14 days). */
function trendScore(story, ctx) {
  const ageDays = (Date.now() - Date.parse(story.createdAt)) / 864e5;
  return story.views + likesFor(story, ctx) * 6 + story.rating * 40 + Math.max(0, 14 - ageDays) * 25;
}

/** Relevance score for a free-text query. Every term must match somewhere. */
function searchScore(story, terms) {
  let total = 0;
  const fields = [
    [story.title.toLowerCase(), 6],
    [story.author.toLowerCase(), 5],
    [story.genre.toLowerCase(), 4],
    [story.mood.toLowerCase(), 4],
    [story.description.toLowerCase(), 1],
  ];
  for (const term of terms) {
    let best = 0;
    for (const [text, weight] of fields) if (text.includes(term)) best = Math.max(best, weight);
    if (!best) return 0;
    total += best;
  }
  return total;
}

const termsOf = (q) => q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);

function sortStories(list, sort, ctx) {
  const by = {
    newest: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    rating: (a, b) => b.rating - a.rating || b.ratingCount - a.ratingCount,
    popular: (a, b) => likesFor(b, ctx) - likesFor(a, ctx),
    trending: (a, b) => trendScore(b, ctx) - trendScore(a, ctx),
  };
  return list.sort(by[sort] || by.trending);
}

function logActivity(userId, type, storyId) {
  db.data.activity.push({ id: crypto.randomUUID(), userId, type, storyId, at: nowISO() });
  if (db.data.activity.length > 20000) db.data.activity.splice(0, db.data.activity.length - 20000);
}

/** Record at most one "read" event per user/story/day (keeps timelines tidy). */
function logReadingDay(userId, storyId) {
  const today = dayKey(Date.now());
  const exists = db.data.activity.some(
    (a) => a.userId === userId && a.storyId === storyId &&
      ['started', 'read', 'completed'].includes(a.type) && dayKey(a.at) === today
  );
  if (!exists) logActivity(userId, 'read', storyId);
}

function computeStreak(userId) {
  const days = new Set(
    db.data.activity
      .filter((a) => a.userId === userId && ['started', 'read', 'completed'].includes(a.type))
      .map((a) => dayKey(a.at))
  );
  if (!days.size) return 0;
  const d = new Date();
  if (!days.has(dayKey(d))) {
    d.setDate(d.getDate() - 1);
    if (!days.has(dayKey(d))) return 0; // streak broken
  }
  let streak = 0;
  while (days.has(dayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}

/** Genre/mood affinity from what the user liked, saved and read. */
function tasteProfile(ctx) {
  const genres = {}, moods = {};
  const bump = (storyId, w) => {
    const s = findStory(storyId);
    if (!s) return;
    genres[s.genre] = (genres[s.genre] || 0) + w;
    moods[s.mood] = (moods[s.mood] || 0) + w;
  };
  ctx.liked.forEach((id) => bump(id, 3));
  ctx.saved.forEach((id) => bump(id, 2));
  ctx.progress.forEach((p, id) => bump(id, p.completed ? 3 : 2));
  return { genres, moods };
}

/**
 * Turn author-written text into chapters. A line starting with "## " opens a
 * new chapter; text before the first heading becomes a prologue.
 */
function parseChapters(content) {
  const lines = String(content).replace(/\r\n?/g, '\n').split('\n');
  const raw = [];
  let cur = { title: null, lines: [] };
  for (const line of lines) {
    const m = line.match(/^\s*##\s+(.+?)\s*$/);
    if (m) {
      if (cur.title !== null || cur.lines.join('').trim()) raw.push(cur);
      cur = { title: m[1].slice(0, 120), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  raw.push(cur);
  return raw
    .map((c, i) => ({
      title: c.title || (i === 0 && raw.length > 1 ? 'Prologue' : 'The Story'),
      content: c.lines.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    }))
    .filter((c) => c.content.length > 0);
}

function validateStory(body = {}) {
  const errors = {};
  const title = str(body.title);
  const author = str(body.author);
  const description = str(body.description);
  const cover = str(body.cover);
  const genre = str(body.genre);
  const mood = str(body.mood);
  const content = typeof body.content === 'string' ? body.content : '';
  const readingTime = Number(body.readingTime);

  if (title.length < 2 || title.length > 120) errors.title = 'Give your story a title between 2 and 120 characters.';
  if (!author || author.length > 80) errors.author = 'Add an author name (up to 80 characters).';
  if (description.length < 10 || description.length > 600) errors.description = 'Write a short description between 10 and 600 characters.';
  if ((cover && !/^https?:\/\/[^\s"'<>]+$/i.test(cover)) || cover.length > 1000) errors.cover = 'Use an image link that starts with http:// or https://';
  if (!GENRE_NAMES.includes(genre)) errors.genre = 'Choose one of the listed genres.';
  if (!MOOD_NAMES.includes(mood)) errors.mood = 'Choose one of the listed moods.';
  if (!Number.isFinite(readingTime) || readingTime < 1 || readingTime > 240) errors.readingTime = 'Reading time should be between 1 and 240 minutes.';

  let chapters = [];
  if (content.trim().length < 200) errors.content = 'Your story needs at least 200 characters.';
  else if (content.length > 200000) errors.content = 'Stories can be up to 200,000 characters.';
  else {
    chapters = parseChapters(content);
    if (!chapters.length) errors.content = 'Add some text under your chapter headings.';
    else if (chapters.length > 60) errors.content = 'Stories can have up to 60 chapters.';
  }

  if (Object.keys(errors).length) throw new HttpError(400, 'Some fields need attention.', errors);
  return { title, author, description, cover, genre, mood, readingTime: Math.round(readingTime), chapters };
}

// ─── USERS / SESSION ───────────────────────────────────────────────────────
// Readers are identified by an anonymous, HttpOnly cookie. No passwords: each
// browser gets its own library, likes and reading progress.
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { /* skip */ }
  }
  return out;
}

function createUser() {
  const adjectives = ['Quiet', 'Wandering', 'Midnight', 'Velvet', 'Amber', 'Rainy', 'Gentle', 'Curious'];
  const nouns = ['Reader', 'Bookworm', 'Dreamer', 'Wanderer', 'Page-Turner', 'Storyteller'];
  const user = {
    id: crypto.randomUUID(),
    username: `${pick(adjectives)} ${pick(nouns)}`,
    avatar: pick(AVATARS),
    createdAt: nowISO(),
  };
  db.data.users.push(user);
  db.save();
  return user;
}

function identify(req, res, next) {
  const id = parseCookies(req.headers.cookie)[COOKIE_NAME];
  let user = id ? db.data.users.find((u) => u.id === id) : null;
  if (!user) {
    user = createUser();
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${user.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`);
  }
  req.user = user;
  next();
}

// ─── SEED DATA ─────────────────────────────────────────────────────────────
const cover = (seed) => `https://picsum.photos/seed/storybrew-${seed}/600/900`;

const SEED_STORIES = [
  {
    title: 'The Last Train to Monsoon', author: 'Ira Menon', genre: 'Romance', mood: 'Rainy Day',
    rating: 4.8, ratingCount: 2140, readingTime: 9, cover: cover('monsoon'), daysAgo: 3, views: 5200, baseLikes: 612,
    featured: true,
    editorNote: 'Read this with the window open. Menon writes rain the way other people write love letters, and then, quietly, she does both.',
    description: 'Two strangers share the last compartment of a night train racing the first rain of the season across the Western Ghats. By morning, one of them has to decide whether to get off.',
    chapters: [
      ['Platform Four', `Ananya reached the platform at 11:52 with a suitcase full of books she had no intention of reading and a letter of resignation she had not yet sent. The train to Kochi was already breathing on the tracks, long and patient, the way trains are when they know you have nowhere else to go.

Her compartment was empty except for a man wrestling an umbrella that refused to close. He apologised to her, and then to the umbrella, which made her laugh for the first time that week.

"It's supposed to rain in the ghats tonight," he said, finally winning. "First monsoon. I've been chasing it up the coast for three days."

"Chasing rain," she repeated. "Is that a job?"

"It's a hobby that became a job that became a problem," he said, and offered her half an orange.`],
      ['Between Stations', `They talked the way people only talk to strangers: honestly, because there is no tomorrow to be careful about. His name was Kabir. He recorded the sound of weather for films. Thunder for heartbreak scenes, drizzle for reunions. He had never recorded the first rain in the mountains, because he always arrived a day late.

She told him about the job she was leaving and the city she wasn't sure she was leaving, and the mother who had said, over the phone, that running away was just walking with more noise.

Somewhere past midnight the air changed. The windows fogged. Kabir went very still, microphone in hand, and she watched him listen to the dark as though it were about to say his name.

Then it did. The rain arrived all at once, drumming on the roof, pouring off the hills in silver ropes, and Kabir was laughing, and she was laughing, and neither of them could have explained why.`],
      ['The Morning Stop', `At dawn the train paused at a station too small to have a tea stall. The hills steamed. Kabir packed his recorder and said this was where he got off; there was a waterfall nearby that nobody had ever recorded properly.

"You could come," he said, not looking at her. "Or you could go to Kochi and send your letter. Both are good stories."

She thought of her mother, of walking with more noise. Then she thought of the sound the rain had made at midnight, and how it had sounded like permission.

The train whistled. Ananya picked up her suitcase of unread books and stepped down onto the wet platform, and behind her the last train to monsoon pulled away, very slowly, as if it understood.`],
    ],
  },
  {
    title: 'Letters I Never Sent', author: 'Noor Castellan', genre: 'Drama', mood: 'Heartbreak',
    rating: 4.7, ratingCount: 1830, readingTime: 7, cover: cover('letters'), daysAgo: 21, views: 4100, baseLikes: 488,
    description: 'A shoebox of unsent letters, written over eleven years to the same person, is found by the one reader who was never supposed to see them.',
    chapters: [
      ['The Shoebox', `The shoebox was under the bed where shoeboxes always are, behind a suitcase and a winter coat that still smelled of our old apartment. I was looking for my mother's passport. I found forty-one envelopes instead, all addressed in her handwriting, all stamped, none of them sent.

Every one of them was addressed to my father.

They had separated when I was nine. She never spoke about him except to correct the facts. He left in March, not April. The car was blue, not grey. I had assumed she had simply closed the door on him. I had not known she kept writing to the other side of it.`],
      ['What She Wrote', `The first letter was angry. The second was angrier. By the fifth she had started telling him small things instead: that I had lost a tooth in a sandwich, that the neighbour's cat had learned to open our window, that the jasmine had come back after the frost.

By the twentieth letter she wasn't writing to him at all. She was writing to the person she had been when she loved him, and she was forgiving that person, one ordinary Tuesday at a time.

The last letter was dated three weeks before she died. It said only: "She has your laugh. I finally don't mind."`],
      ['Return to Sender', `I found my father's address the old way, through a cousin who owed me a favour. I didn't know what I wanted from him. Maybe nothing. Maybe just to hear whether the laugh was really his.

I didn't give him the letters. They were never his, not really. Instead I wrote a new one, the forty-second, and I sent it.

It said: the jasmine came back again this year. I thought you should know.`],
    ],
  },
  {
    title: 'When the City Learned to Dream', author: 'Tomas Aurel', genre: 'Fantasy', mood: 'Magical',
    rating: 4.9, ratingCount: 2760, readingTime: 11, cover: cover('citydream'), daysAgo: 9, views: 6100, baseLikes: 790,
    featured: true,
    editorNote: 'A small miracle. Aurel imagines a city that wakes up able to dream, and it becomes the most tender thing we have published this year.',
    description: 'One Tuesday, the city of Veyra wakes up with dreams of its own: bridges that hum lullabies, streetlamps that remember old lovers, and a tram that refuses to go anywhere sad.',
    chapters: [
      ['The First Dream', `Nobody noticed at first, because cities are always a little strange at dawn. The baker on Quill Street found her ovens warm before she lit them. The river ran backwards for exactly one minute. A streetlamp outside the old opera house flickered in a pattern that, if you knew Morse, spelled a woman's name.

By noon it could not be ignored. The bridges were humming. Not creaking, not groaning, but humming: low, sweet, three-note songs that made commuters stop halfway across and forget where they were going.

The mayor called it a structural concern. The children called it what it was. "The city's dreaming," said a girl named Pell, eight years old and certain. "It's been awake for four hundred years. It's tired."`],
      ['Night Shift', `Pell's grandfather drove the number seven tram, and that night he let her ride along. The route should have gone past the courthouse and the hospital. Instead the tracks turned, gently, towards the harbour, where the city was dreaming of ships.

They rode through streets that had not existed since before the war: a market lit with paper lanterns, a dance hall with its windows open, music spilling onto the cobbles. The passengers were quiet, their faces soft in the lantern light. Nobody asked to get off.

"Is it remembering?" Pell whispered.

"No," her grandfather said. "Remembering is looking back. This is the city hoping."`],
      ['Morning, Again', `In the morning the streets were ordinary again, and the council issued a statement that nothing unusual had occurred. But the bridges still hummed, faintly, if you stood still long enough. The streetlamp outside the opera house still spelled her name.

And the number seven tram, every night at eleven, took a small detour to the harbour, just in case the city wanted company while it dreamed.`],
    ],
  },
  {
    title: 'The Girl Who Collected Rain', author: 'Mirela Voss', genre: 'Fantasy', mood: 'Rainy Day',
    rating: 4.6, ratingCount: 1420, readingTime: 6, cover: cover('rainjars'), daysAgo: 30, views: 3300, baseLikes: 351,
    description: 'In a village where it has not rained in nine years, a girl keeps a shelf of jam jars, each one holding a different storm.',
    chapters: [
      ['Jars', `Liesl kept her rain in jam jars on the windowsill, labelled in careful pencil. Spring drizzle, the year the orchard flowered twice. The storm the night Papa left. Grandmother's funeral: light, then heavy. Each jar held a different grey, and when you tapped the glass the water inside moved like it remembered falling.

The village had not seen rain in nine years. The well was a rumour. The fields were the colour of old paper. People came to Liesl's window just to look at the jars, the way you might visit a museum of something extinct.`],
      ['The Offer', `The man from the water company came in a clean car and offered her a great deal of money for the whole shelf. He said it was for research. He said the jars would be kept safe in a laboratory, labelled properly, with numbers instead of names.

Liesl considered it. Then she carried the jars, one by one, up to the top of the hill behind the church, and she opened them.

The rain did not pour out. It rose: nine years of storms lifting like breath into the hot white sky, gathering, darkening, until the whole village stood in the square with their faces turned up, waiting.

When the first drop landed on her cheek, Liesl did not wipe it away. She was already thinking about which jar she would need for this one.`],
    ],
  },
  {
    title: 'Coffee at 2:17 AM', author: 'Arjun Rao', genre: 'Slice of Life', mood: 'Midnight',
    rating: 4.8, ratingCount: 3120, readingTime: 5, cover: cover('coffee217'), daysAgo: 1, views: 5900, baseLikes: 702,
    featured: true,
    editorNote: 'Five minutes long, and I have thought about it every night since. The closest thing we have to a house story.',
    description: 'Every night at 2:17, the same three strangers order at the only all-night café in Bandra. Tonight, one of them does not come.',
    chapters: [
      ['The Regulars', `Deepa worked the night counter at Café Ninefold because the day shift required small talk. At night, people came in already quiet. They ordered, they sat, they looked at the rain or their phones or nothing at all, and she liked them for it.

Three of them came at exactly 2:17. The nurse in blue scrubs who wanted cardamom in everything. The old man with the chessboard who played both sides and always let black win. The boy with the laptop who wrote, deleted, and wrote again, and ordered his coffee so strong it was practically a dare.

They never spoke to each other. But if one of them was late, the other two would glance at the door. Deepa noticed. Noticing was the only thing the night shift paid well in.`],
      ['The Empty Chair', `On a Thursday in July, the old man did not come. At 2:17 the nurse looked at the door. At 2:20 the boy closed his laptop. At 2:31 the nurse walked to the old man's corner table and sat in front of the abandoned chessboard, and after a long moment, the boy sat down across from her.

They played badly. They played for an hour. Deepa brought them coffee she didn't charge for, and the nurse told the boy that the old man had been a patient on her ward once, years ago, and had taught her the Sicilian Defence while waiting for test results.

At 3:40 the door opened, and the old man came in shaking out an umbrella, complaining about the trains. He looked at the two of them at his table. Then he pulled up a third chair.

Deepa put the kettle back on. At 2:17 the next night there were three cups on one table, and she has never charged for the third.`],
    ],
  },
  {
    title: "The Lighthouse Keeper's Ledger", author: 'Elspeth Hart', genre: 'Mystery', mood: 'Midnight',
    rating: 4.5, ratingCount: 980, readingTime: 8, cover: cover('lighthouse'), daysAgo: 14, views: 2600, baseLikes: 240,
    description: 'A ledger recording ships that never existed turns up in a decommissioned lighthouse. The final entry is dated tomorrow.',
    chapters: [
      ['Inventory', `The council sent Maren to catalogue the lighthouse before it was sold. Twelve rooms, a spiral stair of one hundred and six steps, a lamp that had not turned in thirty years. And, in the keeper's desk, a leather ledger with every page filled in the same tight hand.

Each entry recorded a ship passing the point: name, flag, hour, weather. The Albatross, Norwegian, 03:10, fog. The Gentle Anne, British, 01:45, clear. Maren checked them against the maritime registers out of habit.

None of the ships had ever existed.`],
      ['The Last Page', `The final entry was different. The ink was fresh. It read: The Maren, no flag, 00:00, a lamp in the window. And the date was tomorrow's.

She told herself it was a prank. She told herself that all the way down the hundred and six steps and all the way back to the inn, and then, at eleven that night, she found herself climbing them again with a torch and a thermos, because some questions are only answered by staying up for them.

At midnight she lit a lamp in the window of the lantern room. Out on the black water, very faintly, something answered: a single light, low and steady, moving along a course no ship had sailed in thirty years.

Maren opened the ledger, uncapped her pen, and began to write.`],
    ],
  },
  {
    title: "Signal from Kepler's Orchard", author: 'Dara Okafor', genre: 'Sci-Fi', mood: 'Peaceful',
    rating: 4.7, ratingCount: 1510, readingTime: 9, cover: cover('kepler'), daysAgo: 40, views: 3100, baseLikes: 330,
    description: 'Alone on a terraforming station, a botanist receives a message from a colony that should not exist yet: thank you for the apple trees.',
    chapters: [
      ['Season Four Hundred', `Obi counted time on Kepler-442b in harvests rather than years. The station's orchard had been planted by the first crew, and he was the last of them, kept on as caretaker until the colony ships arrived, in ninety years, give or take.

He didn't mind. He talked to the trees. He had named the oldest apple tree Mum, which he admitted was not entirely healthy, and the youngest Tuesday, because that was the day it first bloomed.`],
      ['Incoming', `The signal arrived during pruning season. It came from the direction of Earth, but it was not from Earth. It was timestamped a hundred and forty years in the future and it was, impossibly, addressed to him by name.

It was short. It said the colony was thriving. It said the children climbed the old trees in the east orchard every autumn. It said the oldest tree was still called Mum, and nobody remembered why, and they had decided not to find out. It said: thank you.

Obi read it eleven times. Then he went outside, into the long violet evening, and planted one more tree. He named it Later, and he watered it carefully, the way you tend a promise you won't be there to see kept.`],
    ],
  },
  {
    title: 'Nine Minutes Before the Blackout', author: 'Soren Lind', genre: 'Thriller', mood: 'Intense',
    rating: 4.6, ratingCount: 2240, readingTime: 7, cover: cover('blackout'), daysAgo: 6, views: 4700, baseLikes: 455,
    description: 'An engineer has nine minutes to stop a city-wide blackout, and to realise that the person sabotaging the grid is trying to save it.',
    chapters: [
      ['08:51', `The alarm in the control room sounded like a polite cough, which was somehow worse. Ingrid looked up at the board. Substation after substation was dropping into amber, a slow wave rolling west across the map of Stockholm.

"Load balancing error," said Petter, already typing. "It'll correct."

"It won't," Ingrid said. She was watching the pattern. It wasn't random. Someone was switching the city off by hand, district by district, and they were doing it carefully, the way you'd lower an injured person to the ground.`],
      ['08:55', `She traced the commands to a maintenance terminal in the tunnel under Södermalm. Four minutes by bike if the lights held. She ran.

The tunnel was hot and loud. The man at the terminal was older than she expected, grey-haired, in an engineer's jacket from a company that no longer existed. He didn't turn around.

"There's a fault in the main transformer," he said. "It fails in six minutes and takes the east grid with it for a week. Hospitals. Water. If we shed load now, gently, it survives."

"Why didn't you report it?"

"I did," he said. "In 2009. Nobody read it."`],
      ['09:00', `Ingrid looked at the readings. He was right. She knew, with the cold clarity of the very frightened, that there was no time to call anyone who would believe her.

So she pulled up a chair and took the second keyboard. Together they walked the city down into the dark, district by district, gentle as a lullaby. At 09:00 exactly Stockholm went black and silent, and in the east the old transformer groaned, held, and did not burn.

The lights came back at 09:14. Nobody ever found out why. Ingrid kept the report from 2009 in her desk drawer, and from then on she read every report that crossed her desk, all the way to the end.`],
    ],
  },
  {
    title: 'The Quiet Apartment on Hollis Street', author: 'Wren Adair', genre: 'Horror', mood: 'Midnight',
    rating: 4.4, ratingCount: 1190, readingTime: 8, cover: cover('hollis'), daysAgo: 25, views: 2900, baseLikes: 262,
    description: 'The rent was too cheap and the apartment was too quiet. Then June noticed that the silence was listening back.',
    chapters: [
      ['Move-In Day', `The listing said quiet building, and it wasn't lying. June's footsteps didn't echo. The fridge didn't hum. When she dropped a pan on the kitchen tile it landed without a sound, as though the floor had caught it.

The landlord said the previous tenant had been a musician. He said it like an apology. He did not come further than the doorway.`],
      ['What the Silence Wanted', `By the second week June was talking to herself just to hear something. By the third, she noticed that the silence was patient in a way silence shouldn't be. When she hummed, the apartment waited until she finished. When she stopped mid-song, the air leaned in, the way an audience leans in.

She found the previous tenant's notebook taped under the sink. The last page said: Don't stop singing. It gets hungry in the pauses.

That night the power went out, and in the perfect dark June opened her mouth and began, very softly, to sing every song she had ever known. She sang until dawn. When the light came, the apartment exhaled, a small satisfied sound like a door closing somewhere far away, and her voice was gone for three days.

She broke the lease the following week. She still hums in elevators. She has never, since, let a silence go unfinished.`],
    ],
  },
  {
    title: "My Grandmother's Recipe for Thunder", author: 'Kavya Iyer', genre: 'Drama', mood: 'Nostalgic',
    rating: 4.9, ratingCount: 2410, readingTime: 8, cover: cover('thunder'), daysAgo: 12, views: 5400, baseLikes: 688,
    featured: true,
    editorNote: 'Iyer writes grief the way a kitchen holds a smell: it gets into everything. Keep tissues and cardamom nearby.',
    description: "Among her late grandmother's recipes, a woman finds one written in a code of spices: how to make thunder, for a granddaughter who is afraid of storms.",
    chapters: [
      ['The Recipe Tin', `Paati's recipes lived in a biscuit tin with a picture of the Queen on the lid, which Paati found very funny. After the funeral, the tin came to me. Rasam, avial, the lemon pickle that took forty days. And one card, folded twice, in her smallest handwriting: For Meera. How to make thunder.

I was seven the summer of the big storms, and I spent every one of them under the dining table. Paati would come and sit beside me with a steel plate and a pestle, and she would crush spices in time with the thunder. Boom, cumin. Boom, pepper. By the end of the storm the whole house smelled warm and I had forgotten to be afraid.`],
      ['Mustard Seeds', `The card was not really a recipe. It said: One hot pan. Mustard seeds, a spoonful, for the first crack. Curry leaves for the lightning. Pepper for the rumble. Sing if needed. The child will come out when she is hungry.

I am thirty-four. I have a daughter of my own now, and she is afraid of the dark, not thunder, but I suspect the recipe is the same.

The first storm of this monsoon came on a Wednesday. My daughter went under the table. I heated oil in Paati's old kadai and dropped in the mustard seeds, and they cracked and spat like tiny fireworks, and from under the table came a small, suspicious voice: "What are you making?"

"Thunder," I said. "Want to help?"

She came out. Of course she came out. The recipe has worked for three generations, and I intend to write it down for a fourth.`],
    ],
  },
  {
    title: 'The Accidental Wedding Planner', author: 'Milo Fenwick', genre: 'Comedy', mood: 'Cozy',
    rating: 4.5, ratingCount: 1680, readingTime: 7, cover: cover('wedding'), daysAgo: 18, views: 3500, baseLikes: 379,
    description: 'Theo only went into the stationery shop to buy a birthday card. He came out responsible for a wedding in nine days.',
    chapters: [
      ['A Case of Mistaken Identity', `It happened because Theo had a clipboard. He was carrying it because his sister had asked him to collect signatures for the allotment petition, and when he walked into Paper & Posy looking vaguely competent, a frantic woman in a cardigan seized his arm and said, "Oh thank God, you're the planner."

He meant to correct her. He opened his mouth to correct her. Then she burst into tears and said the last planner had moved to Portugal with the deposit, and the wedding was in nine days, and the florist only spoke in riddles, and Theo, who had once organised a pub quiz that nobody talked about, heard himself say, "Right. Let's see the seating plan."`],
      ['Nine Days', `The seating plan was a war crime. The florist did, in fact, speak exclusively in riddles. The venue was a converted barn whose resident goat, Gerald, had opinions about tablecloths.

Theo solved it all with the only skills he had: a clipboard, an inability to say no, and an aunt who owned a van. He negotiated with Gerald using apple slices. He deciphered the florist (peonies; it was always peonies). He seated the feuding uncles at opposite ends of the barn and gave each the impression that the other had been demoted.

On the day, the bride cried the good kind of tears, hugged him, and said he was the best planner she had ever had. Theo said thank you. He did not mention that she was his first.

He has three weddings booked for next spring. He still hasn't bought the birthday card.`],
    ],
  },
  {
    title: 'Salt Roads of the Northern Sea', author: 'Anika Brandt', genre: 'Adventure', mood: 'Intense',
    rating: 4.6, ratingCount: 1330, readingTime: 12, cover: cover('saltroad'), daysAgo: 33, views: 2800, baseLikes: 298,
    description: 'A cartographer and a smuggler cross a frozen sea on foot, following a salt road that only appears in the hardest winters.',
    chapters: [
      ['The Hardest Winter', `Every fifty years or so the northern sea freezes hard enough to walk on, and when it does, the old salt road appears: a line of cairns stretching from the fishing town of Veld to the island monastery of Skarn, a hundred miles of ice and wind.

Hanne had spent her career mapping coastlines. She had never mapped a road made of weather. When the smuggler Rook offered to guide her across in exchange for her silence about what he carried, she said yes before she could think of all the reasons to say no.`],
      ['The Crossing', `They walked for six days. The ice sang under them, long eerie notes that Rook said were the sea complaining. They slept in snow shelters. They followed cairns built by people who had been dead for centuries, and Hanne drew each one, because a map is a way of saying: someone was here, and it mattered.

On the fifth night the ice cracked a hundred yards away with a sound like a cannon. Rook didn't flinch. He only said, "Faster now," and they walked through the dark by the light of her lantern until their legs shook.`],
      ['Skarn', `On the sixth morning they reached the monastery. Rook opened his pack in front of the monks, and Hanne finally saw what he had been smuggling: seeds. Barley and rye and apple pips, a whole island's future, carried across the one road nobody could guard.

She finished her map on the monastery steps. It is the only map in the national archive with a note in the corner that says: valid only in the hardest winters.`],
    ],
  },
  {
    title: 'The Bookshop That Closed at Dusk', author: 'Hazel Moreau', genre: 'Fantasy', mood: 'Cozy',
    rating: 4.8, ratingCount: 2050, readingTime: 6, cover: cover('duskshop'), daysAgo: 4, views: 4300, baseLikes: 530,
    description: 'A bookshop that is only open between the last light and the first lamp sells people the book they need, never the one they came for.',
    chapters: [
      ['Twenty Minutes', `The sign on the door said OPEN AT DUSK, CLOSED AT DUSK, which Clara assumed was a typo until she found herself inside one October evening with the sky going violet behind her.

It was small and warm and smelled of cinnamon and old paper. A cat slept on the poetry. The owner, a round woman with half-moon glasses, looked up from her tea and said, "You have about twenty minutes. The light won't wait."`],
      ['The Wrong Book', `Clara had come in looking for a book on how to leave a marriage. The owner listened, nodded, and handed her a slim green volume about learning to swim at forty.

"That's not what I asked for," Clara said.

"No," the owner agreed. "It's what you came for." She wrapped it in brown paper and would not accept money, only a promise that Clara would pass it on when she was done.

The streetlamps flickered on outside. When Clara turned back to say thank you, she was standing on an empty pavement in front of a laundrette, holding a parcel that smelled faintly of cinnamon.

She learned to swim that winter. She has passed the book on four times since. Each time it has come back to her at dusk, on her doorstep, with a new name written inside the cover and a single dried leaf pressed between the pages.`],
    ],
  },
  {
    title: 'Postcards from a Summer That Ended', author: 'Leo Marquez', genre: 'Romance', mood: 'Nostalgic',
    rating: 4.5, ratingCount: 1270, readingTime: 7, cover: cover('postcards'), daysAgo: 45, views: 2500, baseLikes: 276,
    description: 'Twenty postcards, one summer on the Amalfi coast, and a love story told in small, sun-bleached fragments.',
    chapters: [
      ['June', `Postcard one. The pensione has a lemon tree and a landlady who thinks I am too thin. I have been here three days and eaten nothing that wasn't yellow. There is a girl who paints the harbour every morning. She paints it badly. I am in love with how little she minds.

Postcard four. Her name is Chiara. She says the harbour is wrong because the harbour keeps moving. I told her harbours don't move. She said, "Then why does it look different every time?" I have no answer. I am starting to suspect I am the harbour.`],
      ['August', `Postcard eleven. We swam out to the rocks at midnight. The water was full of light, tiny creatures that glow when you move. She said it was the sea being happy. I said it was bioluminescence. She splashed me. She was right.

Postcard nineteen. Summer ends on Thursday. She will go back to Milan and I will go back to being a person who doesn't swim at midnight. We have promised to write. We both know what that promise is made of.

Postcard twenty, never sent. I found one of her paintings in my suitcase. The harbour is still wrong. I have hung it where I see it every morning, and every morning, I swear, it looks a little different.`],
    ],
  },
  {
    title: 'Tea for the Ghost Upstairs', author: 'Priya Sen', genre: 'Comedy', mood: 'Cozy',
    rating: 4.7, ratingCount: 1880, readingTime: 6, cover: cover('ghosttea'), daysAgo: 2, views: 3900, baseLikes: 444,
    description: "Nisha's new flat comes with a ghost. He is Victorian, extremely polite, and deeply disappointed by her tea.",
    chapters: [
      ['Terms of Residence', `The ghost introduced himself on the first night by rearranging Nisha's bookshelves alphabetically, then apologising in a note written in the steam on the bathroom mirror. His name was Mr Bartholomew Crane, he had lived in the attic since 1887, and he wondered whether she might possibly do something about the tea.

"What's wrong with my tea?" Nisha asked the empty kitchen.

The kettle switched itself off, pointedly.`],
      ['A Proper Cup', `It turned out Mr Crane had died with one regret, and it was that he had never had a perfect cup of tea. He had very specific views. Warm the pot. Loose leaf. Four minutes, not three. Milk after, you savage.

Nisha, who had made tea with a bag and a microwave for twelve years, found the whole thing absurd. She also found that she had nobody else to talk to in a new city, and that Mr Crane was very good company, if you ignored the occasional floating spoon.

It took her six weeks to get it right. She set the first perfect cup on the attic step and sat beside it, waiting. For a long time nothing happened. Then the cup gently lifted, tilted, and set itself back down, empty, and she heard, very clearly, a contented sigh.

He's still there. The next morning she asked him why he hadn't moved on. The steam on the mirror said: One cannot leave in the middle of a good friendship. Also, you still over-steep the Darjeeling.`],
    ],
  },
  {
    title: 'Everything the River Remembers', author: 'Yusuf Hale', genre: 'Drama', mood: 'Peaceful',
    rating: 4.6, ratingCount: 1120, readingTime: 8, cover: cover('river'), daysAgo: 52, views: 2300, baseLikes: 231,
    description: 'An old ferryman who has crossed the same river for fifty years takes his final passenger: the son who left and never wrote.',
    chapters: [
      ['The Last Crossing', `Selim had rowed the ferry across the Karasu for fifty-one years. The bridge would open on Monday. The council had given him a certificate and a clock, and he had put the clock in a drawer, because he had never once needed to know the time; the river told him.

On his last Sunday, a man stood on the far bank in a city coat. Selim knew him from the way he stood, weight on the left foot, hands in pockets, exactly as he had stood at eighteen on the morning he left.`],
      ['Halfway', `They didn't speak for the first half of the crossing. Emre watched the water. Selim watched the current, the way he always did, reading its moods like a letter from an old friend.

"I read about the bridge," Emre said finally. "I thought someone should ride with you. The last time."

"You rode with me the first time," Selim said. "You were four. You tried to catch a fish with your hat."

Emre laughed, and it was the same laugh, and something in the old man's chest loosened like a knot in wet rope.

At the far bank Selim did not tie up the ferry. He turned it around, slowly, and started back across. Emre didn't ask why. They crossed the river eleven more times that afternoon, talking about nothing, and the river, which remembers everything, kept them both.`],
    ],
  },
  {
    title: 'The Cartographer of Lost Hours', author: 'Isolde Grey', genre: 'Adventure', mood: 'Magical',
    rating: 4.8, ratingCount: 1960, readingTime: 9, cover: cover('losthours'), daysAgo: 8, views: 4000, baseLikes: 497,
    description: 'Every hour you waste falls somewhere. Wren draws the maps that help people find them again.',
    chapters: [
      ['The Shop on Tallow Lane', `Wren's maps did not show roads or rivers. They showed where lost hours went: the afternoon spent waiting for a call that never came, the morning lost to an argument about nothing. Hours don't vanish, Wren liked to say. They settle, like dust, in the places that hurt.

Her customers were mostly old. They came wanting to find an hour with someone they had loved: a Sunday by the sea, a slow breakfast they had rushed. Wren would unroll a fresh sheet, dip her pen in ink the colour of dusk, and listen.`],
      ['The Boy with No Lost Hours', `One winter a boy came in and asked for a map of his own lost hours. He was eleven. Wren looked at him for a long time, then drew nothing at all.

"You haven't lost any yet," she said. "That's rare."

"Then draw me a map of where to go so I don't," he said.

No one had ever asked her that. She sat up all night, and in the morning she handed him a map that looked like a child's drawing of an ordinary town: his school, the park, his grandmother's kitchen, the hill where you could see the trains. Nothing was marked except, in the corner, a small compass. Instead of North, it said: Here.

He is grown now. He comes back every year to show her that the map still works. It has never needed redrawing.`],
    ],
  },
  {
    title: 'The Robot Who Waited at Platform Nine', author: 'Mara Quill', genre: 'Sci-Fi', mood: 'Heartbreak',
    rating: 4.7, ratingCount: 2290, readingTime: 7, cover: cover('platform9'), daysAgo: 11, views: 4800, baseLikes: 566,
    description: 'A decommissioned station robot keeps a promise to watch a suitcase for a girl who said she would be right back. That was forty-one years ago.',
    chapters: [
      ['Unit K-7', `K-7 was built to help passengers with luggage at Halden Central, and for eleven years it did that very well. Then the station closed, the trains stopped, and a girl in a yellow raincoat left her suitcase with K-7 and said, "Watch this for me, I'll be right back."

K-7 had no instruction for what to do when a person did not come back. So it watched the suitcase. It watched it through the demolition notices and the vandals and the winter the roof fell in. It rerouted power from its own motors to its memory, so that it would not forget what she looked like.`],
      ['The Yellow Raincoat', `Forty-one years later, an old woman in a yellow raincoat walked slowly onto platform nine. She had been looking for the station for a long time. She had not known that anyone was still there.

K-7's optics were cloudy and its voice module crackled, but it rolled forward the last three metres and set the suitcase at her feet.

"You said you'd be right back," it said. There was no reproach in it. Only a kind of wonder.

She knelt, which took some time, and put her hand on its dented casing. "I'm so sorry," she said. "I got on the wrong train. Then my whole life was the wrong train."

"That is all right," said K-7, and its lights dimmed, gently, the way a room dims when someone finally lets themselves sleep. "I was built to help with luggage. I am glad I could carry it this far."`],
    ],
  },
];

function seedIfEmpty() {
  if (db.data.stories.length) return;
  const DAY = 864e5;
  for (const s of SEED_STORIES) {
    const created = new Date(Date.now() - s.daysAgo * DAY - Math.floor(Math.random() * 6) * 3600e3).toISOString();
    db.data.stories.push({
      id: db.nextStoryId(),
      title: s.title,
      author: s.author,
      description: s.description,
      genre: s.genre,
      mood: s.mood,
      rating: s.rating,
      ratingCount: s.ratingCount,
      readingTime: s.readingTime,
      cover: s.cover,
      chapters: s.chapters.map(([title, content]) => ({ title, content })),
      createdAt: created,
      updatedAt: created,
      views: s.views,
      baseLikes: s.baseLikes,
      featured: !!s.featured,
      editorNote: s.editorNote || null,
      ownerId: null,
    });
  }
  db.flush();
  console.log(`[seed] Brewed ${SEED_STORIES.length} sample stories.`);
}

// ─── APP SETUP ─────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, identify);

// ─── API ROUTES: USER ──────────────────────────────────────────────────────
app.get('/api/me', route((req, res) => {
  const ctx = buildCtx(req.user.id);
  res.json({ user: req.user, savedIds: [...ctx.saved], likedIds: [...ctx.liked], avatars: AVATARS });
}));

app.put('/api/me', route((req, res) => {
  const errors = {};
  const username = str(req.body.username);
  const avatar = str(req.body.avatar);
  if (username.length < 2 || username.length > 32) errors.username = 'Names can be 2 to 32 characters.';
  if (avatar && !AVATARS.includes(avatar)) errors.avatar = 'Choose one of the avatars shown.';
  if (Object.keys(errors).length) throw new HttpError(400, 'Some fields need attention.', errors);
  req.user.username = username;
  if (avatar) req.user.avatar = avatar;
  db.save();
  res.json({ user: req.user });
}));

// ─── API ROUTES: TAXONOMY ──────────────────────────────────────────────────
app.get('/api/genres', route((req, res) => {
  const ctx = buildCtx(req.user.id);
  const genres = GENRES.map((g) => {
    const list = sortStories(db.data.stories.filter((s) => s.genre === g.name), 'trending', ctx);
    return {
      ...g,
      count: list.length,
      samples: list.slice(0, 3).map((s) => ({ id: s.id, title: s.title, cover: s.cover, genre: s.genre })),
    };
  });
  res.json({ genres });
}));

app.get('/api/moods', route((req, res) => {
  const moods = MOODS.map((m) => ({ ...m, count: db.data.stories.filter((s) => s.mood === m.name).length }));
  res.json({ moods });
}));

// ─── API ROUTES: STORIES ───────────────────────────────────────────────────
app.get('/api/stories', route((req, res) => {
  const ctx = buildCtx(req.user.id);
  const q = qstr(req.query.q).slice(0, 100);
  const genre = qstr(req.query.genre).toLowerCase();
  const mood = qstr(req.query.mood).toLowerCase();
  const length = qstr(req.query.length);
  const minRating = Number(qstr(req.query.minRating)) || 0;
  const sort = qstr(req.query.sort) || 'trending';
  const limit = clamp(parseInt(qstr(req.query.limit), 10) || 24, 1, 100);
  const offset = Math.max(0, parseInt(qstr(req.query.offset), 10) || 0);

  let list = db.data.stories.slice();
  if (genre) list = list.filter((s) => s.genre.toLowerCase() === genre);
  if (mood) list = list.filter((s) => s.mood.toLowerCase() === mood);
  if (LENGTHS[length]) {
    const [lo, hi] = LENGTHS[length];
    list = list.filter((s) => s.readingTime >= lo && s.readingTime <= hi);
  }
  if (minRating) list = list.filter((s) => s.rating >= minRating);

  if (q) {
    const terms = termsOf(q);
    const scored = list.map((s) => [s, searchScore(s, terms)]).filter(([, sc]) => sc > 0);
    if (sort === 'relevance') {
      list = scored.sort((a, b) => b[1] - a[1]).map(([s]) => s);
    } else {
      list = sortStories(scored.map(([s]) => s), sort, ctx);
    }
  } else {
    list = sortStories(list, sort, ctx);
  }

  res.json({ stories: list.slice(offset, offset + limit).map((s) => summarize(s, ctx)), total: list.length });
}));

app.get('/api/stories/:id', route((req, res) => {
  const story = requireStory(req.params.id);
  const ctx = buildCtx(req.user.id);
  // Opening the details page counts as a view; the reader/editor opt out with track=0.
  if (req.query.track !== '0') { story.views += 1; db.save(); }
  const similar = sortStories(
    db.data.stories.filter((s) => s.id !== story.id && (s.genre === story.genre || s.mood === story.mood)),
    'trending', ctx
  ).slice(0, 6);
  // Top up with popular picks if the story's genre/mood is sparse.
  if (similar.length < 4) {
    for (const s of sortStories(db.data.stories.slice(), 'trending', ctx)) {
      if (similar.length >= 4) break;
      if (s.id !== story.id && !similar.includes(s)) similar.push(s);
    }
  }
  res.json({
    story: summarize(story, ctx, { full: req.query.full === '1' }),
    similar: similar.map((s) => summarize(s, ctx)),
  });
}));

app.post('/api/stories', route((req, res) => {
  const clean = validateStory(req.body);
  const ts = nowISO();
  const story = {
    id: db.nextStoryId(),
    ...clean,
    rating: 0,
    ratingCount: 0,
    createdAt: ts,
    updatedAt: ts,
    views: 0,
    baseLikes: 0,
    featured: false,
    editorNote: null,
    ownerId: req.user.id,
  };
  db.data.stories.push(story);
  logActivity(req.user.id, 'published', story.id);
  db.save();
  res.status(201).json({ story: summarize(story, buildCtx(req.user.id)) });
}));

app.put('/api/stories/:id', route((req, res) => {
  const story = requireStory(req.params.id);
  if (story.ownerId !== req.user.id) throw new HttpError(403, 'Only the author who wrote this story can edit it.');
  Object.assign(story, validateStory(req.body), { updatedAt: nowISO() });
  // Keep saved positions valid if chapters were removed.
  for (const p of db.data.reading_progress) {
    if (p.storyId === story.id && p.chapterIndex >= story.chapters.length) {
      p.chapterIndex = story.chapters.length - 1;
      p.scrollPct = 0;
    }
  }
  db.save();
  res.json({ story: summarize(story, buildCtx(req.user.id)) });
}));

app.delete('/api/stories/:id', route((req, res) => {
  const story = requireStory(req.params.id);
  if (story.ownerId !== req.user.id) throw new HttpError(403, 'Only the author who wrote this story can delete it.');
  const id = story.id;
  db.data.stories = db.data.stories.filter((s) => s.id !== id);
  db.data.library = db.data.library.filter((l) => l.storyId !== id);
  db.data.likes = db.data.likes.filter((l) => l.storyId !== id);
  db.data.reading_progress = db.data.reading_progress.filter((p) => p.storyId !== id);
  db.data.activity = db.data.activity.filter((a) => a.storyId !== id);
  db.save();
  res.json({ deleted: true, id });
}));

// ─── API ROUTES: DISCOVERY ─────────────────────────────────────────────────
app.get('/api/search', route((req, res) => {
  const q = qstr(req.query.q).slice(0, 100);
  if (!q) return res.json({ query: '', stories: [] });
  const ctx = buildCtx(req.user.id);
  const terms = termsOf(q);
  const results = db.data.stories
    .map((s) => [s, searchScore(s, terms)])
    .filter(([, sc]) => sc > 0)
    .sort((a, b) => b[1] - a[1] || trendScore(b[0], ctx) - trendScore(a[0], ctx))
    .slice(0, 20)
    .map(([s]) => summarize(s, ctx));
  res.json({ query: q, stories: results });
}));

app.get('/api/trending', route((req, res) => {
  const ctx = buildCtx(req.user.id);
  const limit = clamp(parseInt(qstr(req.query.limit), 10) || 10, 1, 50);
  res.json({ stories: sortStories(db.data.stories.slice(), 'trending', ctx).slice(0, limit).map((s) => summarize(s, ctx)) });
}));

app.get('/api/new', route((req, res) => {
  const ctx = buildCtx(req.user.id);
  const limit = clamp(parseInt(qstr(req.query.limit), 10) || 8, 1, 50);
  res.json({ stories: sortStories(db.data.stories.slice(), 'newest', ctx).slice(0, limit).map((s) => summarize(s, ctx)) });
}));

app.get('/api/editors-picks', route((req, res) => {
  const ctx = buildCtx(req.user.id);
  const picks = db.data.stories.filter((s) => s.featured).sort((a, b) => b.rating - a.rating);
  res.json({ stories: picks.map((s) => summarize(s, ctx)) });
}));

app.get('/api/recommended', route((req, res) => {
  const ctx = buildCtx(req.user.id);
  const limit = clamp(parseInt(qstr(req.query.limit), 10) || 8, 1, 30);
  const taste = tasteProfile(ctx);
  const personalized = Object.keys(taste.genres).length > 0;
  const list = db.data.stories
    .filter((s) => !(ctx.progress.get(s.id) || {}).completed)
    .map((s) => {
      const score = personalized
        ? (taste.genres[s.genre] || 0) * 3 + (taste.moods[s.mood] || 0) * 2 + s.rating - (ctx.saved.has(s.id) ? 4 : 0)
        : trendScore(s, ctx) / 100 + s.rating;
      return [s, score];
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([s]) => summarize(s, ctx));
  res.json({ personalized, stories: list });
}));

// ─── API ROUTES: LIBRARY ───────────────────────────────────────────────────
app.get('/api/library', route((req, res) => {
  const uid = req.user.id;
  const ctx = buildCtx(uid);
  const tab = qstr(req.query.tab) || 'saved';
  const progress = [...ctx.progress.values()];
  const counts = {
    saved: ctx.saved.size,
    reading: progress.filter((p) => !p.completed && findStory(p.storyId)).length,
    completed: progress.filter((p) => p.completed && findStory(p.storyId)).length,
    liked: ctx.liked.size,
  };
  let items = [];
  if (tab === 'saved') {
    items = db.data.library.filter((l) => l.userId === uid)
      .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))
      .map((l) => ({ savedAt: l.savedAt, story: findStory(l.storyId) }));
  } else if (tab === 'reading' || tab === 'completed') {
    items = progress.filter((p) => (tab === 'completed' ? p.completed : !p.completed))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((p) => ({ story: findStory(p.storyId) }));
  } else if (tab === 'liked') {
    items = db.data.likes.filter((l) => l.userId === uid)
      .sort((a, b) => Date.parse(b.likedAt) - Date.parse(a.likedAt))
      .map((l) => ({ likedAt: l.likedAt, story: findStory(l.storyId) }));
  } else {
    throw new HttpError(400, 'Choose saved, reading, completed or liked.');
  }
  items = items.filter((i) => i.story).map((i) => ({ ...i, story: summarize(i.story, ctx) }));
  res.json({ tab, counts, items });
}));

app.post('/api/library', route((req, res) => {
  const story = requireStory(req.body && req.body.storyId);
  const exists = db.data.library.some((l) => l.userId === req.user.id && l.storyId === story.id);
  if (!exists) {
    db.data.library.push({ userId: req.user.id, storyId: story.id, savedAt: nowISO() });
    logActivity(req.user.id, 'saved', story.id);
    db.save();
  }
  res.status(exists ? 200 : 201).json({ saved: true, storyId: story.id });
}));

app.delete('/api/library/:storyId', route((req, res) => {
  const id = Number(req.params.storyId);
  const before = db.data.library.length;
  db.data.library = db.data.library.filter((l) => !(l.userId === req.user.id && l.storyId === id));
  if (db.data.library.length !== before) db.save();
  res.json({ saved: false, storyId: id });
}));

// ─── API ROUTES: LIKES ─────────────────────────────────────────────────────
app.get('/api/likes', route((req, res) => {
  const ctx = buildCtx(req.user.id);
  res.json({ likedIds: [...ctx.liked] });
}));

app.post('/api/like', route((req, res) => {
  const story = requireStory(req.body && req.body.storyId);
  const exists = db.data.likes.some((l) => l.userId === req.user.id && l.storyId === story.id);
  if (!exists) {
    db.data.likes.push({ userId: req.user.id, storyId: story.id, likedAt: nowISO() });
    logActivity(req.user.id, 'liked', story.id);
    db.save();
  }
  res.status(exists ? 200 : 201).json({ liked: true, storyId: story.id, likes: likesFor(story, buildCtx(req.user.id)) });
}));

app.delete('/api/like/:storyId', route((req, res) => {
  const id = Number(req.params.storyId);
  const before = db.data.likes.length;
  db.data.likes = db.data.likes.filter((l) => !(l.userId === req.user.id && l.storyId === id));
  if (db.data.likes.length !== before) db.save();
  const story = findStory(id);
  res.json({ liked: false, storyId: id, likes: story ? likesFor(story, buildCtx(req.user.id)) : 0 });
}));

// ─── API ROUTES: READING PROGRESS ──────────────────────────────────────────
app.post('/api/progress', route((req, res) => {
  const body = req.body || {};
  const story = requireStory(body.storyId);
  const uid = req.user.id;
  const n = story.chapters.length;

  let chapterIndex = parseInt(body.chapterIndex, 10);
  if (!Number.isInteger(chapterIndex)) chapterIndex = 0;
  chapterIndex = clamp(chapterIndex, 0, n - 1);
  let scrollPct = Number(body.scrollPct);
  if (!Number.isFinite(scrollPct)) scrollPct = 0;
  scrollPct = clamp(scrollPct, 0, 1);

  let p = db.data.reading_progress.find((x) => x.userId === uid && x.storyId === story.id);
  const isNew = !p;
  if (isNew) {
    p = { userId: uid, storyId: story.id, startedAt: nowISO(), completed: false, bookmark: null };
    db.data.reading_progress.push(p);
    logActivity(uid, 'started', story.id);
  }
  p.chapterIndex = chapterIndex;
  p.scrollPct = scrollPct;
  p.updatedAt = nowISO();

  if (body.bookmark === true) p.bookmark = { chapterIndex, scrollPct, at: p.updatedAt };
  else if (body.bookmark === null) p.bookmark = null;

  const justCompleted = body.completed === true && !p.completed;
  if (body.completed === true) {
    p.completed = true;
    p.completedAt = p.completedAt || p.updatedAt;
  }
  // Only an explicit finish marks a story complete; scrolling tops out at 99%.
  p.percent = p.completed ? 100 : Math.min(99, Math.round(((chapterIndex + scrollPct) / n) * 100));

  if (justCompleted) logActivity(uid, 'completed', story.id);
  else if (!isNew) logReadingDay(uid, story.id);
  db.save();

  const completedCount = db.data.reading_progress.filter((x) => x.userId === uid && x.completed).length;
  res.json({ progress: progressView(p), justCompleted, completedCount });
}));

app.get('/api/progress/:storyId', route((req, res) => {
  const story = requireStory(req.params.storyId);
  const p = db.data.reading_progress.find((x) => x.userId === req.user.id && x.storyId === story.id);
  res.json({ progress: progressView(p) });
}));

app.delete('/api/progress/:storyId', route((req, res) => {
  const id = Number(req.params.storyId);
  db.data.reading_progress = db.data.reading_progress.filter((p) => !(p.userId === req.user.id && p.storyId === id));
  db.save();
  res.json({ removed: true, storyId: id });
}));

// ─── API ROUTES: PROFILE ───────────────────────────────────────────────────
app.get('/api/profile', route((req, res) => {
  const uid = req.user.id;
  const ctx = buildCtx(uid);
  const progress = [...ctx.progress.values()].filter((p) => findStory(p.storyId));

  const taste = tasteProfile(ctx);
  const favoriteGenre = Object.entries(taste.genres).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const minutesRead = Math.round(progress.reduce((sum, p) => {
    const s = findStory(p.storyId);
    return sum + (s ? (s.readingTime * p.percent) / 100 : 0);
  }, 0));

  const genreCounts = {};
  for (const p of progress) {
    const s = findStory(p.storyId);
    genreCounts[s.genre] = (genreCounts[s.genre] || 0) + 1;
  }

  const timeline = db.data.activity
    .filter((a) => a.userId === uid)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map((a) => {
      const s = findStory(a.storyId);
      return s ? { type: a.type, at: a.at, story: { id: s.id, title: s.title, author: s.author, genre: s.genre, cover: s.cover } } : null;
    })
    .filter(Boolean)
    .slice(0, 40);

  const myStories = db.data.stories
    .filter((s) => s.ownerId === uid)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((s) => summarize(s, ctx));

  res.json({
    user: req.user,
    stats: {
      storiesRead: progress.filter((p) => p.completed).length,
      inProgress: progress.filter((p) => !p.completed).length,
      storiesSaved: ctx.saved.size,
      storiesLiked: ctx.liked.size,
      storiesWritten: myStories.length,
      streak: computeStreak(uid),
      favoriteGenre,
      minutesRead,
    },
    genreCounts,
    timeline,
    myStories,
  });
}));

// ─── STATIC FRONTEND ───────────────────────────────────────────────────────
// Only index.html is served, so server.js and the data file are never exposed.
app.get(['/', '/index.html'], (req, res) => res.sendFile(INDEX_FILE));

// ─── ERROR HANDLING ────────────────────────────────────────────────────────
app.use('/api', (req, res) => res.status(404).json({ error: 'That endpoint doesn’t exist.' }));
app.use((req, res) => res.redirect('/'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'We couldn’t read that request. Please try again.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That’s too much to send at once. Try a shorter story.' });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.fields ? { fields: err.fields } : {}) });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again in a moment.' });
});

// ─── SERVER ────────────────────────────────────────────────────────────────
db.load();
seedIfEmpty();

const server = app.listen(PORT, () => {
  console.log(`\n  ☕  Story Brew is brewing at http://localhost:${PORT}\n`);
});

function shutdown() {
  db.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
