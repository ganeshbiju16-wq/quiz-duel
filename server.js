/**
 * Real-time quiz server (starter)
 *
 * Flow: Google sign-in -> username -> pick quiz type -> wait up to 10s for a
 * human opponent (bot fallback) -> 10 questions -> result -> rematch / new match.
 *
 * The server is the referee: it sends the questions, measures answer time,
 * checks answers and awards 5-20 points per correct answer based on speed.
 */
require('dotenv').config();
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');

// ---------- config ----------
const PORT = process.env.PORT || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';
const DEV_AUTH = process.env.DEV_AUTH === 'true'; // lets you log in with token "dev:<name>" while testing

const QUESTIONS_PER_MATCH = 10;
const QUESTION_TIME_MS = 10_000;
const ANSWER_GRACE_MS = 500;      // network slack after the timer ends
const MATCH_WAIT_MS = 10_000;     // wait for a human this long, then use a bot
const INTRO_MS = 3_000;           // pause between "match found" and question 1
const BETWEEN_QUESTIONS_MS = 2_500;
const REMATCH_WINDOW_MS = 20_000;
const MIN_POINTS = 5;
const MAX_POINTS = 20;
const BOT_ACCURACY = 0.65;
const BOT_NAMES = ['Alex_K', 'Maria92', 'QuizNinja', 'Sam_T', 'Priya_S', 'LeoTheLion', 'Nadia', 'Kenji', 'Omar_77', 'Chloe'];

// ---------- helpers ----------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const ack = (fn) => (typeof fn === 'function' ? fn : () => {});

// 20 points for an instant answer, sliding down to 5 at the time limit
function pointsFor(elapsedMs) {
  const t = Math.min(Math.max(elapsedMs / QUESTION_TIME_MS, 0), 1);
  return Math.round(MAX_POINTS - (MAX_POINTS - MIN_POINTS) * t);
}

// ---------- state (single server process; move to Redis to scale out) ----------
const quizTypes = new Map();  // slug -> { id, slug, name }
const queues = new Map();     // slug -> [{ socket, timer }]
const busy = new Set();       // user ids that are searching or playing

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ---------- HTTP ----------
const app = express();
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', CLIENT_ORIGIN);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/quiz-types', (req, res) => res.json([...quizTypes.values()]));
app.get('/leaderboard', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT username, total_points, wins, losses, draws
       FROM users WHERE username IS NOT NULL
       ORDER BY total_points DESC LIMIT 50`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CLIENT_ORIGIN } });

// ---------- auth ----------
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error('missing_token'));

    let googleId;
    let email = null;
    if (DEV_AUTH && token.startsWith('dev:')) {
      googleId = token;
    } else {
      const ticket = await googleClient.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      googleId = payload.sub;
      email = payload.email || null;
    }

    const { rows } = await pool.query(
      `INSERT INTO users (google_id, email) VALUES ($1, $2)
       ON CONFLICT (google_id) DO UPDATE SET email = COALESCE(EXCLUDED.email, users.email)
       RETURNING id, username, total_points`,
      [googleId, email]
    );
    socket.user = rows[0];
    next();
  } catch (err) {
    console.error('auth failed:', err.message);
    next(new Error('auth_failed'));
  }
});

// ---------- matchmaking ----------
function removeFromQueue(slug, entry) {
  const q = queues.get(slug) || [];
  const i = q.indexOf(entry);
  if (i !== -1) q.splice(i, 1);
}

function leaveQueue(socket) {
  const qe = socket.data.queueEntry;
  if (!qe) return false;
  clearTimeout(qe.entry.timer);
  removeFromQueue(qe.slug, qe.entry);
  socket.data.queueEntry = null;
  return true;
}

function humanPlayer(socket) {
  return {
    id: socket.user.id,
    username: socket.user.username,
    socket,
    isBot: false,
    connected: true,
    score: 0,
    answers: [],
  };
}

function botPlayer() {
  return { id: null, username: pick(BOT_NAMES), socket: null, isBot: true, connected: true, score: 0, answers: [] };
}

function enqueue(socket, type) {
  const q = queues.get(type.slug) || [];
  queues.set(type.slug, q);

  const waiting = q.shift();
  if (waiting) {
    clearTimeout(waiting.timer);
    waiting.socket.data.queueEntry = null;
    startMatch(type, [humanPlayer(waiting.socket), humanPlayer(socket)]);
    return;
  }

  const entry = { socket, timer: null };
  entry.timer = setTimeout(() => {
    removeFromQueue(type.slug, entry);
    socket.data.queueEntry = null;
    startMatch(type, [humanPlayer(socket), botPlayer()]); // bot always second
  }, MATCH_WAIT_MS);
  q.push(entry);
  socket.data.queueEntry = { slug: type.slug, entry };
}

// ---------- match engine ----------
const humansOf = (match) => match.players.filter((p) => !p.isBot);
const opponentOf = (match, player) => match.players.find((p) => p !== player);

async function startMatch(type, players) {
  let questions = [];
  try {
    const { rows } = await pool.query(
      `SELECT id, prompt, image_url, options, correct_index
       FROM questions
       WHERE quiz_type_id = $1 AND approved
       ORDER BY random() LIMIT $2`,
      [type.id, QUESTIONS_PER_MATCH]
    );
    questions = rows;
  } catch (err) {
    console.error('question load failed:', err);
  }

  if (questions.length < QUESTIONS_PER_MATCH) {
    for (const p of players) {
      if (p.socket) {
        p.socket.emit('match_error', { error: 'not_enough_questions' });
        busy.delete(p.id);
      }
    }
    return;
  }

  const match = {
    id: crypto.randomUUID(),
    type,
    players,
    questions,
    current: null,
    finishedAt: null,
    rematchVotes: new Set(),
  };
  for (const p of humansOf(match)) {
    p.socket.data.match = match;
    p.connected = p.socket.connected; // may have dropped while questions were loading
  }

  try {
    await runMatch(match);
  } catch (err) {
    console.error('match crashed:', err);
  } finally {
    for (const p of humansOf(match)) {
      busy.delete(p.id);
      if (p.socket.data.match === match) p.socket.data.match = null;
    }
  }
}

async function runMatch(match) {
  for (const p of humansOf(match)) {
    if (!p.connected) continue;
    const opp = opponentOf(match, p);
    p.socket.emit('match_found', {
      matchId: match.id,
      quizType: match.type.slug,
      questionCount: match.questions.length,
      // isBot lets your client show a "Practice opponent" label if you want one
      opponent: { username: opp.username, isBot: opp.isBot },
    });
  }
  await sleep(INTRO_MS);

  for (let i = 0; i < match.questions.length; i++) {
    if (!humansOf(match).some((p) => p.connected)) return; // everyone left: abandon, nothing saved
    await playQuestion(match, i);
    if (i < match.questions.length - 1) await sleep(BETWEEN_QUESTIONS_MS);
  }
  await finishMatch(match);
}

function playQuestion(match, index) {
  return new Promise((resolve) => {
    const q = match.questions[index];
    const cur = { index, startedAt: Date.now(), answered: new Map(), settled: false, timers: [] };
    match.current = cur;

    const settle = () => {
      if (cur.settled) return;
      cur.settled = true;
      cur.timers.forEach(clearTimeout);

      // anyone who didn't answer scores nothing
      for (const p of match.players) {
        if (!cur.answered.has(p)) storeAnswer(cur, p, q, null, false, 0, QUESTION_TIME_MS);
      }

      for (const p of humansOf(match)) {
        if (!p.connected) continue;
        const opp = opponentOf(match, p);
        const mine = cur.answered.get(p);
        const theirs = cur.answered.get(opp);
        p.socket.emit('question_result', {
          index,
          correctIndex: q.correct_index,
          you: { choice: mine.choice, points: mine.points, score: p.score },
          opponent: { choice: theirs.choice, points: theirs.points, score: opp.score },
        });
      }
      resolve();
    };

    cur.tryFinish = () => {
      if (match.players.every((p) => cur.answered.has(p) || !p.connected)) settle();
    };

    cur.timers.push(setTimeout(settle, QUESTION_TIME_MS + ANSWER_GRACE_MS));

    // never send correct_index to the client before the result
    const payload = {
      index,
      total: match.questions.length,
      prompt: q.prompt,
      imageUrl: q.image_url,
      options: q.options,
      timeLimitMs: QUESTION_TIME_MS,
    };
    for (const p of humansOf(match)) if (p.connected) p.socket.emit('question', payload);

    for (const p of match.players) {
      if (p.isBot) cur.timers.push(scheduleBotAnswer(match, p, q));
    }
  });
}

function storeAnswer(cur, player, q, choice, correct, points, elapsedMs) {
  cur.answered.set(player, { choice, correct, points });
  player.score += points;
  player.answers.push({
    questionId: q.id,
    choice,
    correct,
    timeMs: Math.min(elapsedMs, QUESTION_TIME_MS),
    points,
  });
}

function registerAnswer(match, player, choice) {
  const cur = match.current;
  if (!cur || cur.settled || cur.answered.has(player)) return; // first answer only
  const elapsed = Date.now() - cur.startedAt;                   // server-side timing
  if (elapsed > QUESTION_TIME_MS + ANSWER_GRACE_MS) return;

  const q = match.questions[cur.index];
  const valid = Number.isInteger(choice) && choice >= 0 && choice < q.options.length;
  const correct = valid && choice === q.correct_index;
  storeAnswer(cur, player, q, valid ? choice : null, correct, correct ? pointsFor(elapsed) : 0, elapsed);

  const opp = opponentOf(match, player);
  if (opp.socket && opp.connected) opp.socket.emit('opponent_answered', { index: cur.index });
  cur.tryFinish();
}

function scheduleBotAnswer(match, bot, q) {
  const delay = 2000 + Math.random() * 6000;
  let choice = q.correct_index;
  if (Math.random() > BOT_ACCURACY) {
    choice = pick(q.options.map((_, n) => n).filter((n) => n !== q.correct_index));
  }
  return setTimeout(() => registerAnswer(match, bot, choice), delay);
}

async function finishMatch(match) {
  const [a, b] = match.players;
  const winner = a.score > b.score ? a : b.score > a.score ? b : null;
  const totals = new Map();

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const { rows } = await db.query(
      `INSERT INTO matches
         (quiz_type_id, player1_id, player2_id, player1_score, player2_score, winner_id, is_bot_match)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [match.type.id, a.id, b.id, a.score, b.score, winner ? winner.id : null, a.isBot || b.isBot]
    );
    const matchId = rows[0].id;

    for (const p of humansOf(match)) {
      for (const [i, ans] of p.answers.entries()) {
        await db.query(
          `INSERT INTO match_answers (match_id, user_id, question_id, chosen_index, is_correct, time_ms, points)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [matchId, p.id, ans.questionId, ans.choice, ans.correct, ans.timeMs, ans.points]
        );
      }
      const res = await db.query(
        `UPDATE users
         SET total_points = total_points + $2,
             wins   = wins   + $3,
             losses = losses + $4,
             draws  = draws  + $5
         WHERE id = $1 RETURNING total_points`,
        [p.id, p.score, winner === p ? 1 : 0, winner && winner !== p ? 1 : 0, winner ? 0 : 1]
      );
      totals.set(p, res.rows[0].total_points);
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('saving match failed:', err);
  } finally {
    db.release();
  }

  match.finishedAt = Date.now();
  for (const p of humansOf(match)) {
    p.socket.data.lastMatch = match;
    if (!p.connected) continue;
    const opp = opponentOf(match, p);
    p.socket.emit('match_end', {
      result: winner === p ? 'win' : winner ? 'lose' : 'draw',
      pointsGained: p.score,
      totalPoints: totals.get(p) ?? null,
      you: { username: p.username, score: p.score },
      opponent: { username: opp.username, score: opp.score, isBot: opp.isBot },
    });
  }
}

// ---------- socket events ----------
io.on('connection', (socket) => {
  const user = socket.user;
  socket.emit('ready', {
    username: user.username,
    needsUsername: !user.username,
    totalPoints: user.total_points,
  });

  socket.on('set_username', async (data, cb) => {
    const reply = ack(cb);
    if (user.username) return reply({ ok: true, username: user.username });
    const username = data && data.username;
    if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(username)) {
      return reply({ ok: false, error: 'invalid_username' }); // 3-16 letters, numbers or _
    }
    try {
      const { rows } = await pool.query(
        'UPDATE users SET username = $1 WHERE id = $2 AND username IS NULL RETURNING username',
        [username, user.id]
      );
      if (rows[0]) user.username = rows[0].username;
      reply({ ok: true, username: user.username });
    } catch (err) {
      reply({ ok: false, error: err.code === '23505' ? 'username_taken' : 'server_error' });
    }
  });

  socket.on('find_match', (data, cb) => {
    const reply = ack(cb);
    if (!user.username) return reply({ ok: false, error: 'username_required' });
    if (busy.has(user.id)) return reply({ ok: false, error: 'already_busy' });
    const type = quizTypes.get(data && data.quizType);
    if (!type) return reply({ ok: false, error: 'invalid_quiz_type' });
    busy.add(user.id);
    reply({ ok: true, waitMs: MATCH_WAIT_MS });
    enqueue(socket, type);
  });

  socket.on('cancel_search', (data, cb) => {
    if (leaveQueue(socket)) busy.delete(user.id);
    ack(cb)({ ok: true });
  });

  socket.on('answer', (data) => {
    const match = socket.data.match;
    if (!match || !match.current || !data || match.current.index !== data.questionIndex) return;
    const player = match.players.find((p) => p.socket === socket);
    if (player) registerAnswer(match, player, data.choice);
  });

  socket.on('rematch', (data, cb) => {
    const reply = ack(cb);
    const last = socket.data.lastMatch;
    if (!last || Date.now() - last.finishedAt > REMATCH_WINDOW_MS) {
      return reply({ ok: false, error: 'rematch_expired' });
    }
    if (busy.has(user.id)) return reply({ ok: false, error: 'already_busy' });

    const me = last.players.find((p) => p.socket === socket);
    const opp = opponentOf(last, me);

    if (opp.isBot) {
      busy.add(user.id);
      reply({ ok: true });
      return startMatch(last.type, [humanPlayer(socket), botPlayer()]);
    }
    if (!opp.socket.connected || busy.has(opp.id)) return reply({ ok: false, error: 'opponent_unavailable' });

    last.rematchVotes.add(me);
    if (last.rematchVotes.has(opp)) {
      last.rematchVotes.clear();
      busy.add(me.id);
      busy.add(opp.id);
      reply({ ok: true, waiting: false });
      startMatch(last.type, [humanPlayer(opp.socket), humanPlayer(socket)]);
    } else {
      reply({ ok: true, waiting: true });
      opp.socket.emit('rematch_requested');
    }
  });

  socket.on('disconnect', () => {
    if (leaveQueue(socket)) busy.delete(user.id);
    const match = socket.data.match;
    if (match) {
      const p = match.players.find((x) => x.socket === socket);
      if (p) p.connected = false;
      if (match.current && !match.current.settled) match.current.tryFinish();
    }
  });
});

// ---------- boot ----------
(async () => {
  const { rows } = await pool.query('SELECT id, slug, name FROM quiz_types ORDER BY id');
  rows.forEach((r) => quizTypes.set(r.slug, r));
  server.listen(PORT, () => console.log(`Quiz server listening on :${PORT} (${rows.length} quiz types)`));
})().catch((err) => {
  console.error('startup failed:', err);
  process.exit(1);
});