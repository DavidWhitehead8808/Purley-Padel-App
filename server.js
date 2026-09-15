require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const app = express();
app.set('trust proxy', 1); // Caddy sits in front; trust the first proxy for secure cookies
const port = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://padel_admin:changeme123@localhost:5432/padel_league'
});

// ─── Middleware ────────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.use(session({
  store: new pgSession({ pool, tableName: 'sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// Protect all /api routes except /api/auth/*
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  if (req.path.startsWith('/admin/')) return next(); // admin routes check their own secret
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
});

// ─── Migrations ────────────────────────────────────────────────────────────────

async function runMigrations() {
  // Set-based scoring columns
  await pool.query(`ALTER TABLE fixtures
    ADD COLUMN IF NOT EXISTS set_scores JSONB,
    ADD COLUMN IF NOT EXISTS player1_sets INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS player2_sets INTEGER DEFAULT 0;`);

  // Users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP
    );
  `);
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

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username.trim().toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ username: user.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ username: req.session.username });
});

app.post('/api/auth/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (username.trim().length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2)',
      [username.trim().toLowerCase(), hash]
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That username is already taken' });
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/auth/change-password', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Both current and new password are required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    const user = result.rows[0];
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── Admin routes (protected by ADMIN_SECRET header) ─────────────────────────

function requireAdminSecret(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: 'ADMIN_SECRET not configured on server' });
  if (req.headers['x-admin-secret'] !== secret) {
    return res.status(403).json({ error: 'Invalid admin secret' });
  }
  next();
}

// Create a user
app.post('/api/admin/users', requireAdminSecret, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at',
      [username.trim().toLowerCase(), hash]
    );
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Reset a user's password
app.post('/api/admin/users/:username/reset', requireAdminSecret, async (req, res) => {
  const { username } = req.params;
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'UPDATE users SET password_hash = $1 WHERE username = $2 RETURNING id, username',
      [hash, username.trim().toLowerCase()]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, username: result.rows[0].username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// List users (no passwords)
app.get('/api/admin/users', requireAdminSecret, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, created_at, last_login FROM users ORDER BY username');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Delete a user
app.delete('/api/admin/users/:username', requireAdminSecret, async (req, res) => {
  const { username } = req.params;
  try {
    await pool.query('DELETE FROM users WHERE username = $1', [username.trim().toLowerCase()]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── League API routes ────────────────────────────────────────────────────────

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
      `SELECT id, name, division_id, played,
              won  AS sets_won,
              lost AS sets_lost,
              points
       FROM players
       WHERE division_id = $1
       ORDER BY points DESC, (won - lost) DESC, name ASC;`,
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

app.put('/api/players/:id', async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    const result = await pool.query(
      'UPDATE players SET name = $1 WHERE id = $2 RETURNING *',
      [name.trim(), id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Team not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/players/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM players WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.post('/api/divisions/:id/reset', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM fixtures WHERE division_id = $1', [id]);
    await client.query(
      'UPDATE players SET played = 0, won = 0, lost = 0, points = 0 WHERE division_id = $1',
      [id]
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

app.post('/api/divisions/:id/generate-fixtures', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const playersResult = await client.query('SELECT * FROM players WHERE division_id = $1', [id]);
    const players = playersResult.rows;
    if (players.length < 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Need at least 2 teams' });
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
      SELECT f.*, p1.name as player1_name, p2.name as player2_name
      FROM fixtures f
      JOIN players p1 ON f.player1_id = p1.id
      JOIN players p2 ON f.player2_id = p2.id
      WHERE f.division_id = $1 ORDER BY f.id
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
  const { set_scores, player1_score, player2_score } = req.body;

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

  let p1Sets = 0;
  let p2Sets = 0;
  for (const s of normalizedSetScores) {
    if (!Array.isArray(s) || s.length !== 2) {
      return res.status(400).json({ error: 'Each set must be [player1Games, player2Games]' });
    }
    const a = Number(s[0]);
    const b = Number(s[1]);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
      return res.status(400).json({ error: 'Set scores must be non-negative integers' });
    }
    if (a === b) return res.status(400).json({ error: 'A set cannot end in a tie' });
    if (a > b) p1Sets += 1;
    else p2Sets += 1;
  }
  if (p1Sets === p2Sets) {
    return res.status(400).json({ error: 'Match cannot end tied on sets' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fixtureResult = await client.query('SELECT * FROM fixtures WHERE id = $1 FOR UPDATE', [id]);
    const fixture = fixtureResult.rows[0];
    if (!fixture) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Fixture not found' });
    }

    const p1Id = fixture.player1_id;
    const p2Id = fixture.player2_id;

    if (fixture.played) {
      const oldP1Sets = Number.isInteger(fixture.player1_sets) ? fixture.player1_sets : null;
      const oldP2Sets = Number.isInteger(fixture.player2_sets) ? fixture.player2_sets : null;

      if (oldP1Sets !== null && oldP2Sets !== null) {
        await client.query(
          `UPDATE players SET played = GREATEST(played - 1, 0), won = won - $2, lost = lost - $3, points = points - $2 WHERE id = $1`,
          [p1Id, oldP1Sets, oldP2Sets]
        );
        await client.query(
          `UPDATE players SET played = GREATEST(played - 1, 0), won = won - $2, lost = lost - $3, points = points - $2 WHERE id = $1`,
          [p2Id, oldP2Sets, oldP1Sets]
        );
      } else if (fixture.winner_id) {
        const oldWinner = fixture.winner_id;
        const oldLoser = oldWinner === p1Id ? p2Id : p1Id;
        await client.query(
          `UPDATE players SET played = GREATEST(played - 1, 0), won = GREATEST(won - 1, 0), points = GREATEST(points - 3, 0) WHERE id = $1`,
          [oldWinner]
        );
        await client.query(
          `UPDATE players SET played = GREATEST(played - 1, 0), lost = GREATEST(lost - 1, 0) WHERE id = $1`,
          [oldLoser]
        );
      }
    }

    const winnerId = p1Sets > p2Sets ? p1Id : p2Id;
    await client.query(
      `UPDATE fixtures SET set_scores = $1, player1_sets = $2, player2_sets = $3, winner_id = $4, played = TRUE, match_date = NOW() WHERE id = $5`,
      [JSON.stringify(normalizedSetScores), p1Sets, p2Sets, winnerId, id]
    );
    await client.query(
      `UPDATE players SET played = played + 1, won = won + $2, lost = lost + $3, points = points + $2 WHERE id = $1`,
      [p1Id, p1Sets, p2Sets]
    );
    await client.query(
      `UPDATE players SET played = played + 1, won = won + $2, lost = lost + $3, points = points + $2 WHERE id = $1`,
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

// ─── Catch-all (SPA) ─────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

init();
