-- Quiz Duel database tables (safe to run more than once)

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  google_id     TEXT UNIQUE NOT NULL,
  email         TEXT,
  username      TEXT,
  total_points  INT NOT NULL DEFAULT 0,
  wins          INT NOT NULL DEFAULT 0,
  losses        INT NOT NULL DEFAULT 0,
  draws         INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- usernames are unique regardless of upper/lower case
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));

CREATE TABLE IF NOT EXISTS quiz_types (
  id    SERIAL PRIMARY KEY,
  slug  TEXT UNIQUE NOT NULL,
  name  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id             SERIAL PRIMARY KEY,
  quiz_type_id   INT NOT NULL REFERENCES quiz_types(id),
  prompt         TEXT NOT NULL,
  image_url      TEXT,
  options        JSONB NOT NULL,
  correct_index  SMALLINT NOT NULL,
  approved       BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- stops the same question being added twice
CREATE UNIQUE INDEX IF NOT EXISTS questions_unique
  ON questions (quiz_type_id, prompt, COALESCE(image_url, ''));

CREATE TABLE IF NOT EXISTS matches (
  id             SERIAL PRIMARY KEY,
  quiz_type_id   INT NOT NULL REFERENCES quiz_types(id),
  player1_id     INT REFERENCES users(id),
  player2_id     INT REFERENCES users(id),      -- NULL when the opponent is a bot
  player1_score  INT NOT NULL,
  player2_score  INT NOT NULL,
  winner_id      INT REFERENCES users(id),      -- NULL for a draw or a bot win
  is_bot_match   BOOLEAN NOT NULL DEFAULT false,
  played_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS match_answers (
  id             SERIAL PRIMARY KEY,
  match_id       INT NOT NULL REFERENCES matches(id),
  user_id        INT NOT NULL REFERENCES users(id),
  question_id    INT NOT NULL REFERENCES questions(id),
  chosen_index   SMALLINT,                      -- NULL = no answer (timeout)
  is_correct     BOOLEAN NOT NULL,
  time_ms        INT NOT NULL,
  points         INT NOT NULL
);

INSERT INTO quiz_types (slug, name) VALUES
  ('flag',    'Flag Quiz'),
  ('country', 'Country Quiz'),
  ('general', 'General Knowledge')
ON CONFLICT (slug) DO NOTHING;
