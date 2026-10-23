/**
 * Fills the questions table (safe to run more than once; duplicates are skipped).
 *   flag    -> "Which country's flag is this?" built from a public countries dataset
 *   country -> "What is the capital of X?"     built from the same dataset
 *   general -> ~100 questions from Open Trivia DB (category 9)
 *
 * Needs Node 18+ (built-in fetch) and internet access.
 * Check each source's terms before you launch commercially.
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// correct answer + 3 random wrong ones, shuffled
function buildOptions(correct, candidates) {
  const wrong = shuffle([...new Set(candidates)].filter((x) => x !== correct)).slice(0, 3);
  const options = shuffle([correct, ...wrong]);
  return { options, correctIndex: options.indexOf(correct) };
}

async function typeId(slug) {
  const { rows } = await pool.query('SELECT id FROM quiz_types WHERE slug = $1', [slug]);
  if (!rows[0]) throw new Error(`Run schema.sql first (missing quiz type "${slug}")`);
  return rows[0].id;
}

async function insertQuestion(quizTypeId, prompt, imageUrl, options, correctIndex) {
  const res = await pool.query(
    `INSERT INTO questions (quiz_type_id, prompt, image_url, options, correct_index)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [quizTypeId, prompt, imageUrl, JSON.stringify(options), correctIndex]
  );
  return res.rowCount;
}

async function seedCountries() {
  const res = await fetch('https://raw.githubusercontent.com/mledoze/countries/master/countries.json');
  if (!res.ok) throw new Error(`countries download failed: ${res.status}`);
  const countries = (await res.json())
    .filter((c) => c.independent && c.name?.common && c.capital?.length && c.cca2)
    .map((c) => ({ ...c, flags: { png: `https://flagcdn.com/w320/${c.cca2.toLowerCase()}.png` } }));

  const names = countries.map((c) => c.name.common);
  const capitals = countries.map((c) => c.capital[0]);
  const flagId = await typeId('flag');
  const countryId = await typeId('country');

  let flags = 0;
  let caps = 0;
  for (const c of countries) {
    const f = buildOptions(c.name.common, names);
    flags += await insertQuestion(flagId, "Which country's flag is this?", c.flags.png, f.options, f.correctIndex);

    const k = buildOptions(c.capital[0], capitals);
    caps += await insertQuestion(countryId, `What is the capital of ${c.name.common}?`, null, k.options, k.correctIndex);
  }
  console.log(`flag: +${flags}, country: +${caps}`);
}

async function seedGeneral() {
  const id = await typeId('general');
  let added = 0;
  for (let batch = 0; batch < 2; batch++) {
    if (batch > 0) await sleep(5500); // Open Trivia DB allows 1 request per 5 seconds
    const url = 'https://opentdb.com/api.php?amount=50&category=9&type=multiple&encode=url3986';
    const res = await fetch(url);
    const data = await res.json();
    for (const item of data.results || []) {
      const correct = decodeURIComponent(item.correct_answer);
      const wrong = item.incorrect_answers.map(decodeURIComponent);
      const options = shuffle([correct, ...wrong]);
      added += await insertQuestion(id, decodeURIComponent(item.question), null, options, options.indexOf(correct));
    }
  }
  console.log(`general: +${added}`);
}

(async () => {
  await seedCountries();
  await seedGeneral();
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
