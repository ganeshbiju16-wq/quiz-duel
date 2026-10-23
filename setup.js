/**
 * Runs automatically before the server starts (see "start" in package.json).
 * 1. Creates the database tables if they don't exist yet.
 * 2. Loads quiz questions the first time (when the questions table is empty).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('database tables ready');

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM questions');
  await pool.end();

  if (rows[0].n === 0) {
    console.log('no questions yet, loading them (takes about a minute)...');
    execFileSync(process.execPath, [path.join(__dirname, 'seed.js')], { stdio: 'inherit' });
  } else {
    console.log(`${rows[0].n} questions already loaded`);
  }
})().catch((err) => {
  console.error('setup failed:', err);
  process.exit(1);
});
