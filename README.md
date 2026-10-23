# ⚡ Quiz Duel

A live multiplayer quiz game. Sign in, pick a quiz (Flags, Capitals or General Knowledge), get matched with another player (or a practice bot after 10 seconds), and race through 10 questions. Faster correct answers earn more points (5–20).

## Run on your own computer

1. Install [Node.js](https://nodejs.org) and [PostgreSQL](https://www.postgresql.org/download/).
2. Create a database called `quizgame`.
3. Copy `.env.example` to `.env` and fill in your database details.
4. In a terminal in this folder:
   ```
   npm install
   npm start
   ```
5. Open http://localhost:3000

`npm start` creates the tables and loads the questions automatically the first time.

## Files

| File | What it does |
|---|---|
| `server.js` | Game server: login, matchmaking, questions, scoring |
| `public/index.html` | The website players see |
| `schema.sql` | Database tables |
| `seed.js` | Downloads and loads the quiz questions |
| `setup.js` | Runs before the server: creates tables, loads questions if empty |
