require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://padel_admin:changeme123@localhost:5432/padel_league'
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Lightweight migration to support set-based scoring without breaking existing DBs.
// - We keep the DB table name as `players` (UI can call them Teams).
// - We repurpose players.won/lost/points to represent sets won/sets lost/total points (1 set = 1 point).
// - We add fixture columns to store per-match set details so we can recalculate safely.
async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Fixtures: store set breakdown and computed set totals.
    await client.query('ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS set_scores JSONB');
    await client.query('ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS player1_sets INTEGER');
    await client.query('ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS player2_sets INTEGER');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration error:', err);
  } finally {
    client.release();
  }
}

// Validate and compute sets won from a grid payload like: [[6,0],[6,4],[0,6]]
function computeSetsFromGrid(setScores) {
  if (!Array.isArray(setScores) || setScores.length === 0) {
    throw new Error('set_scores must be a non-empty array');
  }
  if (setScores.length > 3) {
    throw new Error('Maximum of 3 sets');
  }

  let p1Sets = 0;
  let p2Sets = 0;
  const cleaned = [];

  for (const s of setScores) {
    if (!Array.isArray(s) || s.length !== 2) throw new Error('Each set must be [team1, team2]');
    const a = Number(s[0]);
    const b = Number(s[1]);
    if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error('Set scores must be integers');
    if (a < 0 || b < 0) throw new Error('Set scores must be >= 0');
    if (a === b) throw new Error('Set cannot be tied');

    // Basic padel/tennis-like sanity checks (kept permissive):
    // Winner should have at least 6 games, except allow 0-0 is already prevented.
    const winner = Math.max(a, b);
    const loser = Math.min(a, b);
    const diff = winner - loser;
    const looksLikeSet = (winner === 6 && diff >= 2) || (winner === 7 && (diff === 1 || diff === 2));
    // If user enters something unusual (e.g. 8-6), still reject to avoid corrupt standings.
    if (!looksLikeSet) {
      throw new Error(`Invalid set score ${a}-${b}. Use e.g. 6-0, 6-4, 7-5, 7-6`);
    }

    if (a > b) p1Sets += 1;
    else p2Sets += 1;
    cleaned.push([a, b]);
  }

  if (p1Sets === p2Sets) {
    throw new Error('Match result cannot be a draw');
  }

  return { p1Sets, p2Sets, cleaned };
}

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Database connected successfully');
  }
});

runMigrations().catch((e) => console.error('Migration run error:', e));

app.get('/api/divisions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM divisions ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/divisions', async (req, res) => {
  const { name } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO divisions (name) VALUES ($1) RETURNING *',
      [name]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/divisions/:id/players', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM players WHERE division_id = $1 ORDER BY points DESC, (won - lost) DESC',
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/divisions/:id/players', async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO players (division_id, name) VALUES ($1, $2) RETURNING *',
      [id, name]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/divisions/:id/fixtures', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`
      SELECT f.*, 
        p1.name as player1_name,
        p2.name as player2_name
      FROM fixtures f
      JOIN players p1 ON f.player1_id = p1.id
      JOIN players p2 ON f.player2_id = p2.id
      WHERE f.division_id = $1
      ORDER BY f.id
    `, [id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/divisions/:id/generate-fixtures', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const playersResult = await client.query(
      'SELECT * FROM players WHERE division_id = $1',
      [id]
    );
    const players = playersResult.rows;
    
    if (players.length < 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Need at least 2 players' });
    }
    
    await client.query('DELETE FROM fixtures WHERE division_id = $1', [id]);

    // Reset standings for this division when regenerating fixtures.
    // (played = matches played, won/lost = sets won/sets lost, points = sets won)
    await client.query(
      'UPDATE players SET played = 0, won = 0, lost = 0, points = 0 WHERE division_id = $1',
      [id]
    );
    
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        await client.query(
          'INSERT INTO fixtures (division_id, player1_id, player2_id) VALUES ($1, $2, $3)',
          [id, players[i].id, players[j].id]
        );
      }
    }
    
    await client.query('COMMIT');
    
    const fixturesResult = await client.query(`
      SELECT f.*, 
        p1.name as player1_name,
        p2.name as player2_name
      FROM fixtures f
      JOIN players p1 ON f.player1_id = p1.id
      JOIN players p2 ON f.player2_id = p2.id
      WHERE f.division_id = $1
      ORDER BY f.id
    `, [id]);
    
    res.json(fixturesResult.rows);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

app.put('/api/fixtures/:id/result', async (req, res) => {
  const { id } = req.params;
  const { player1_score, player2_score, set_scores } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const fixtureResult = await client.query(
      'SELECT * FROM fixtures WHERE id = $1',
      [id]
    );
    const fixture = fixtureResult.rows[0];
    if (!fixture) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Fixture not found' });
    }

    // If this fixture already has a result, undo it first (recalculate mode).
    if (fixture.played) {
      const prevP1Sets = Number(fixture.player1_sets) || 0;
      const prevP2Sets = Number(fixture.player2_sets) || 0;

      await client.query(
        'UPDATE players SET played = played - 1, won = won - $1, lost = lost - $2, points = points - $1 WHERE id = $3',
        [prevP1Sets, prevP2Sets, fixture.player1_id]
      );
      await client.query(
        'UPDATE players SET played = played - 1, won = won - $1, lost = lost - $2, points = points - $1 WHERE id = $3',
        [prevP2Sets, prevP1Sets, fixture.player2_id]
      );
    }

    let p1Sets;
    let p2Sets;
    let cleaned;

    if (set_scores !== undefined) {
      ({ p1Sets, p2Sets, cleaned } = computeSetsFromGrid(set_scores));
    } else {
      // Backwards-compatible fallback if callers still send simple totals.
      const a = Number(player1_score);
      const b = Number(player2_score);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new Error('Either provide set_scores or integer player1_score/player2_score');
      }
      if (a === b) throw new Error('Match result cannot be a draw');
      p1Sets = a;
      p2Sets = b;
      cleaned = null;
    }

    const winnerId = p1Sets > p2Sets ? fixture.player1_id : fixture.player2_id;

    await client.query(
      `UPDATE fixtures 
         SET player1_score = $1,
             player2_score = $2,
             player1_sets = $1,
             player2_sets = $2,
             set_scores = COALESCE($3, set_scores),
             winner_id = $4,
             played = TRUE,
             match_date = NOW()
       WHERE id = $5`,
      [p1Sets, p2Sets, cleaned ? JSON.stringify(cleaned) : null, winnerId, id]
    );

    // Update standings: played = matches played, won/lost = sets won/sets lost, points = sets won (1 set = 1 point)
    await client.query(
      'UPDATE players SET played = played + 1, won = won + $1, lost = lost + $2, points = points + $1 WHERE id = $3',
      [p1Sets, p2Sets, fixture.player1_id]
    );

    await client.query(
      'UPDATE players SET played = played + 1, won = won + $1, lost = lost + $2, points = points + $1 WHERE id = $3',
      [p2Sets, p1Sets, fixture.player2_id]
    );
    
    await client.query('COMMIT');
    res.json({ success: true, player1_sets: p1Sets, player2_sets: p2Sets });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(400).json({ error: err.message || 'Database error' });
  } finally {
    client.release();
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`Padel League Manager running on port ${port}`);
});