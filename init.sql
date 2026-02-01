CREATE TABLE IF NOT EXISTS divisions (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS players (
    id SERIAL PRIMARY KEY,
    division_id INTEGER REFERENCES divisions(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    played INTEGER DEFAULT 0,
    won INTEGER DEFAULT 0,
    lost INTEGER DEFAULT 0,
    points INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fixtures (
    id SERIAL PRIMARY KEY,
    division_id INTEGER REFERENCES divisions(id) ON DELETE CASCADE,
    player1_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
    player2_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
    player1_score INTEGER,
    player2_score INTEGER,
    set_scores JSONB,
    player1_sets INTEGER DEFAULT 0,
    player2_sets INTEGER DEFAULT 0,
    winner_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
    played BOOLEAN DEFAULT FALSE,
    match_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_players_division ON players(division_id);
CREATE INDEX idx_fixtures_division ON fixtures(division_id);
CREATE INDEX idx_fixtures_played ON fixtures(played);