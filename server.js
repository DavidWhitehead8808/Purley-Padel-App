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

pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Database connected successfully');
  }
});

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
  const { player1_score, player2_score } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const fixtureResult = await client.query(
      'SELECT * FROM fixtures WHERE id = $1',
      [id]
    );
    const fixture = fixtureResult.rows[0];
    
    const winnerId = player1_score > player2_score ? fixture.player1_id : fixture.player2_id;
    const loserId = player1_score > player2_score ? fixture.player2_id : fixture.player1_id;
    
    await client.query(
      'UPDATE fixtures SET player1_score = $1, player2_score = $2, winner_id = $3, played = TRUE, match_date = NOW() WHERE id = $4',
      [player1_score, player2_score, winnerId, id]
    );
    
    await client.query(
      'UPDATE players SET played = played + 1, won = won + 1, points = points + 3 WHERE id = $1',
      [winnerId]
    );
    
    await client.query(
      'UPDATE players SET played = played + 1, lost = lost + 1 WHERE id = $1',
      [loserId]
    );
    
    await client.query('COMMIT');
    res.json({ success: true });
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