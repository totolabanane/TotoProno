const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/apex.db';

// Crée le dossier data/ s'il n'existe pas
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

// --- Schéma ---
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'account', -- 'account' ou 'pro'
    pro_until DATETIME, -- date de fin d'abonnement pro (NULL si pas pro)
    notify_email INTEGER NOT NULL DEFAULT 1, -- 1 = reçoit un email à chaque nouveau prono débloqué pour son palier
    is_admin INTEGER NOT NULL DEFAULT 0, -- 1 = accès au panel admin (indépendant du palier payant)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pronos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_label TEXT NOT NULL,      -- ex: "PSG vs Marseille"
    competition TEXT,               -- ex: "Ligue 1"
    pick TEXT NOT NULL,             -- ex: "PSG -1.5 handicap"
    odds REAL,                      -- cote
    analysis TEXT,                  -- analyse détaillée (réservée pro)
    visibility TEXT NOT NULL DEFAULT 'public', -- 'public' | 'account' | 'pro'
    match_date DATETIME NOT NULL,
    result TEXT,                    -- NULL (pas encore joué) | 'won' | 'lost'
    hors_anj INTEGER NOT NULL DEFAULT 0, -- 1 = prono sur un opérateur/marché non agréé ANJ (à signaler)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS login_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    success INTEGER NOT NULL,       -- 1 = connexion réussie, 0 = échec (mauvais mdp / email inconnu)
    tier TEXT,                      -- palier de l'utilisateur au moment de la tentative (NULL si email inconnu)
    ip TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// --- Migration douce pour les bases créées avant l'ajout de hors_anj ---
try {
  db.exec(`ALTER TABLE pronos ADD COLUMN hors_anj INTEGER NOT NULL DEFAULT 0`);
} catch (err) {
  if (!/duplicate column/i.test(err.message)) throw err;
}

// --- Migration douce pour les bases créées avant l'ajout de notify_email ---
// (les nouvelles bases ont déjà la colonne via le CREATE TABLE ci-dessus,
// ce bloc ne sert que pour une base existante).
try {
  db.exec(`ALTER TABLE users ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 1`);
} catch (err) {
  if (!/duplicate column/i.test(err.message)) throw err;
}

// --- Migration douce pour les bases créées avant l'ajout de is_admin ---
try {
  db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
} catch (err) {
  if (!/duplicate column/i.test(err.message)) throw err;
}

// --- Migration douce pour les bases créées avant l'intégration Stripe ---
try {
  db.exec(`ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`);
} catch (err) {
  if (!/duplicate column/i.test(err.message)) throw err;
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT`);
} catch (err) {
  if (!/duplicate column/i.test(err.message)) throw err;
}

module.exports = db;
