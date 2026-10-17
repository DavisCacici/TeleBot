const { Pool } = require('pg');

const connectionString =
  process.env.DATABASE_URL ||
  `postgresql://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD || 'postgres'}@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || 5433}/${process.env.POSTGRES_DB || 'telegraf_logs'}`;

const pool = new Pool({
  connectionString
});

pool.on('error', (err) => {
  console.error('Errore imprevisto sul client PostgreSQL:', err.message);
});

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        level VARCHAR(20) NOT NULL DEFAULT 'INFO',
        event_type VARCHAR(100) NOT NULL,
        chat_id BIGINT,
        project_name VARCHAR(255),
        conversation_id VARCHAR(255),
        message TEXT,
        payload JSONB
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_state (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    console.log('🗄️ Database PostgreSQL inizializzato correttamente.');
  } catch (err) {
    console.error('❌ Errore durante l\'inizializzazione del database PostgreSQL:', err.message);
  }
}

async function saveLog({
  level = 'INFO',
  eventType = 'general',
  chatId = null,
  projectName = null,
  conversationId = null,
  message = '',
  payload = null
}) {
  try {
    await pool.query(
      `INSERT INTO logs (level, event_type, chat_id, project_name, conversation_id, message, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        level,
        eventType,
        chatId ? Number(chatId) : null,
        projectName,
        conversationId,
        message,
        payload ? JSON.stringify(payload) : null
      ]
    );
  } catch (err) {
    console.error('Errore durante il salvataggio del log su PostgreSQL:', err.message);
  }
}

async function loadStateFromDb() {
  try {
    const res = await pool.query(`SELECT value FROM bot_state WHERE key = 'main_state'`);
    if (res.rows.length > 0) {
      return res.rows[0].value;
    }
    return null;
  } catch (err) {
    console.error('Errore durante il caricamento dello stato da PostgreSQL:', err.message);
    return null;
  }
}

async function saveStateToDb(stateObj) {
  try {
    await pool.query(
      `INSERT INTO bot_state (key, value, updated_at)
       VALUES ('main_state', $1, NOW())
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(stateObj)]
    );
  } catch (err) {
    console.error('Errore durante il salvataggio dello stato su PostgreSQL:', err.message);
  }
}

module.exports = {
  pool,
  initDb,
  saveLog,
  loadStateFromDb,
  saveStateToDb
};
