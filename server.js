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

async function runMigrations() {
  // Add columns needed for set-based scoring (safe to run multiple times)
  await pool.query(`ALTER TABLE fixtures
    ADD COLUMN IF NOT EXISTS set_scores JSONB,
    ADD COLUMN IF NOT EXISTS player1_sets INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS player2_sets INTEGER DEFAULT 0;`);
}

async function init() {
  try {
    await pool.query('SELECT 1');
    await runMigrations();
    console.log('Database connected and migrations applied');
  } catch (err) {
    console.error('Startup error (db/migrations):', err);
    process.exit(1);
  }

  app.listen(port, () => {
    console.log(`Padel League Manager running on port ${port}`);
  });
}


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
      `
      SELECT
        id,
        name,
        division_id,
        played,
        won  AS sets_won,
        lost AS sets_lost,
        points
      FROM players
      WHERE division_id = $1
      ORDER BY points DESC, (won - lost) DESC, name ASC;
      `,
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

  // New UI sends: { set_scores: [[6,0],[6,4],[0,6]] } (up to 3 sets)
  const { set_scores, player1_score, player2_score } = req.body;

  // Backwards compatibility: if old payload used, store as a single "set" (not ideal but avoids crashes)
  let normalizedSetScores = null;
  if (Array.isArray(set_scores)) {
    normalizedSetScores = set_scores;
  } else if (
    Number.isInteger(player1_score) &&
    Number.isInteger(player2_score) &&
    player1_score !== player2_score
  ) {
    normalizedSetScores = [[player1_score, player2_score]];
  }

  if (!normalizedSetScores || normalizedSetScores.length === 0) {
    return res.status(400).json({ error: 'Expected set_scores: [[p1,p2], ...]' });
  }
  if (normalizedSetScores.length > 3) {
    return res.status(400).json({ error: 'A maximum of 3 sets is allowed' });
  }

  // Count set wins
  let p1Sets = 0;
  let p2Sets = 0;

  for (const s of normalizedSetScores) {
    if (!Array.isArray(s) || s.length !== 2) {
      return res.status(400).json({ error: 'Each set must be [player1Games, player2Games]' });
    }
    const [aRaw, bRaw] = s;
    const a = Number(aRaw);
    const b = Number(bRaw);

    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
      return res.status(400).json({ error: 'Set scores must be non-negative integers' });
    }
    if (a === b) {
      return res.status(400).json({ error: 'A set cannot end in a tie' });
    }

    if (a > b) p1Sets += 1;
    else p2Sets += 1;
  }

  if (p1Sets === p2Sets) {
    return res.status(400).json({ error: 'Match cannot end tied on sets' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const fixtureResult = await client.query(
      'SELECT * FROM fixtures WHERE id = $1 FOR UPDATE',
      [id]
    );
    const fixture = fixtureResult.rows[0];
    if (!fixture) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Fixture not found' });
    }

    const p1Id = fixture.player1_id;
    const p2Id = fixture.player2_id;

    // If the fixture already had a result, undo its previous impact before applying the new one.
    if (fixture.played) {
      const oldP1Sets = Number.isInteger(fixture.player1_sets) ? fixture.player1_sets : null;
      const oldP2Sets = Number.isInteger(fixture.player2_sets) ? fixture.player2_sets : null;

      if (oldP1Sets !== null && oldP2Sets !== null) {
        // Undo set-based stats
        await client.query(
          `UPDATE players
           SET played = GREATEST(played - 1, 0),
               won = won - $2,
               lost = lost - $3,
               points = points - $2
           WHERE id = $1`,
          [p1Id, oldP1Sets, oldP2Sets]
        );

        await client.query(
          `UPDATE players
           SET played = GREATEST(played - 1, 0),
               won = won - $2,
               lost = lost - $3,
               points = points - $2
           WHERE id = $1`,
          [p2Id, oldP2Sets, oldP1Sets]
        );
      } else if (fixture.winner_id) {
        // Undo legacy match-based stats (won+1 points+3, loser lost+1)
        const oldWinner = fixture.winner_id;
        const oldLoser = oldWinner === p1Id ? p2Id : p1Id;

        await client.query(
          `UPDATE players
           SET played = GREATEST(played - 1, 0),
               won = GREATEST(won - 1, 0),
               points = GREATEST(points - 3, 0)
           WHERE id = $1`,
          [oldWinner]
        );

        await client.query(
          `UPDATE players
           SET played = GREATEST(played - 1, 0),
               lost = GREATEST(lost - 1, 0)
           WHERE id = $1`,
          [oldLoser]
        );
      }
    }

    const winnerId = p1Sets > p2Sets ? p1Id : p2Id;

    // Save fixture result
    await client.query(
      `UPDATE fixtures
       SET set_scores = $1,
           player1_sets = $2,
           player2_sets = $3,
           winner_id = $4,
           played = TRUE,
           match_date = NOW()
       WHERE id = $5`,
      [JSON.stringify(normalizedSetScores), p1Sets, p2Sets, winnerId, id]
    );

    // Apply new set-based stats
    await client.query(
      `UPDATE players
       SET played = played + 1,
           won = won + $2,
           lost = lost + $3,
           points = points + $2
       WHERE id = $1`,
      [p1Id, p1Sets, p2Sets]
    );

    await client.query(
      `UPDATE players
       SET played = played + 1,
           won = won + $2,
           lost = lost + $3,
           points = points + $2
       WHERE id = $1`,
      [p2Id, p2Sets, p1Sets]
    );

    await client.query('COMMIT');
    res.json({ success: true, player1_sets: p1Sets, player2_sets: p2Sets, set_scores: normalizedSetScores });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Database error' });
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