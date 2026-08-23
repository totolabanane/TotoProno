const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('ERREUR: DATABASE_URL manquant dans .env — copie l\'URL de connexion Neon (dashboard Neon → ton projet → "Connection string") dans .env.');
  process.exit(1);
}

// Neon exige une connexion chiffrée (SSL). rejectUnauthorized: false évite
// les soucis de certificat en environnement serverless — c'est la config
// standard recommandée par Neon pour node-postgres.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Crée les tables si elles n'existent pas encore, et ajoute les colonnes
// manquantes sur une base existante plus ancienne (Postgres supporte
// IF NOT EXISTS nativement — plus besoin du bricolage try/catch de SQLite).
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'account', -- 'account' ou 'pro'
      pro_until TIMESTAMP, -- date de fin d'abonnement pro (NULL si pas pro)
      notify_email BOOLEAN NOT NULL DEFAULT true, -- reçoit un email à chaque nouveau prono débloqué pour son palier
      is_admin BOOLEAN NOT NULL DEFAULT false, -- accès au panel admin (indépendant du palier payant)
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      reset_token_hash TEXT, -- hash SHA-256 du token de réinitialisation, jamais le token en clair
      reset_token_expires TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pronos (
      id SERIAL PRIMARY KEY,
      match_label TEXT NOT NULL,      -- ex: "PSG vs Marseille"
      competition TEXT,               -- ex: "Ligue 1"
      pick TEXT NOT NULL,             -- ex: "PSG -1.5 handicap"
      odds REAL,                      -- cote
      analysis TEXT,                  -- analyse détaillée (réservée pro)
      visibility TEXT NOT NULL DEFAULT 'public', -- 'public' | 'account' | 'pro'
      match_date TIMESTAMP NOT NULL,
      result TEXT,                    -- NULL (pas encore joué) | 'won' | 'lost'
      hors_anj BOOLEAN NOT NULL DEFAULT false, -- prono sur un opérateur/marché non agréé ANJ (à signaler)
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS login_events (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      success BOOLEAN NOT NULL,       -- true = connexion réussie, false = échec
      tier TEXT,                      -- palier de l'utilisateur au moment de la tentative (NULL si email inconnu)
      ip TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Migrations douces pour une base créée avant l'ajout de ces colonnes.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP`);
}

module.exports = {
  pool,
  init,
  // Petit raccourci pratique : db.query('SELECT ... WHERE id = $1', [id])
  query: (text, params) => pool.query(text, params),
};
