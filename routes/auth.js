const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sendPasswordResetEmail } = require('../lib/notify');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = '30d';
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 heure

function hashResetToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function makeToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, tier: user.tier, is_admin: !!user.is_admin },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

// Journalise chaque tentative de connexion (réussie ou non) pour l'historique admin.
// Best-effort : une erreur ici ne doit jamais faire échouer la connexion elle-même.
async function logLoginEvent(req, { email, success, tier }) {
  try {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || null;
    await db.query(
      `INSERT INTO login_events (email, success, tier, ip) VALUES ($1, $2, $3, $4)`,
      [email.toLowerCase(), success, tier || null, ip]
    );
  } catch (err) {
    console.error('Erreur de journalisation de connexion:', err);
  }
}

// --- POST /api/auth/signup ---
router.post('/signup', async (req, res) => {
  const { name, email, password, notify_email } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nom, email et mot de passe requis.' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Email invalide.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères.' });
  }

  const { rows: existingRows } = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existingRows[0]) {
    return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const notifyEmailFlag = notify_email === false ? false : true; // opt-out explicite uniquement

  const { rows } = await db.query(
    `INSERT INTO users (name, email, password_hash, tier, notify_email) VALUES ($1, $2, $3, 'account', $4) RETURNING id`,
    [name.trim(), email.toLowerCase().trim(), passwordHash, notifyEmailFlag]
  );

  const user = { id: rows[0].id, email: email.toLowerCase(), tier: 'account' };
  const token = makeToken(user);

  res.status(201).json({
    token,
    user: { id: user.id, name: name.trim(), email: user.email, tier: user.tier }
  });
});

// --- POST /api/auth/login ---
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email et mot de passe requis.' });
  }

  const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  const user = rows[0];
  if (!user) {
    logLoginEvent(req, { email, success: false, tier: null });
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    logLoginEvent(req, { email, success: false, tier: user.tier });
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }

  // Si l'abonnement pro est expiré, on repasse l'utilisateur en "account"
  let effectiveTier = user.tier;
  if (user.tier === 'pro' && user.pro_until && new Date(user.pro_until) < new Date()) {
    effectiveTier = 'account';
    await db.query(`UPDATE users SET tier = 'account' WHERE id = $1`, [user.id]);
  }

  logLoginEvent(req, { email, success: true, tier: effectiveTier });

  const token = makeToken({ id: user.id, email: user.email, tier: effectiveTier, is_admin: user.is_admin });

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, tier: effectiveTier, is_admin: !!user.is_admin }
  });
});

// --- POST /api/auth/forgot-password ---
// Toujours la même réponse, que l'email existe ou non en base : on ne veut
// jamais laisser un attaquant deviner quels emails sont inscrits sur le site.
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'Email invalide.' });
  }

  const genericResponse = { ok: true, message: 'Si un compte existe avec cet email, un lien de réinitialisation vient d\'être envoyé.' };

  const { rows } = await db.query('SELECT id, name, email FROM users WHERE email = $1', [email.toLowerCase().trim()]);
  const user = rows[0];
  if (!user) {
    // On répond pareil, mais on n'envoie rien.
    return res.json(genericResponse);
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashResetToken(rawToken);
  const expires = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();

  await db.query('UPDATE users SET reset_token_hash = $1, reset_token_expires = $2 WHERE id = $3', [tokenHash, expires, user.id]);

  const resetUrl = `${SITE_URL}/reinitialiser-mdp.html?token=${rawToken}`;

  try {
    await sendPasswordResetEmail(user, resetUrl);
  } catch (err) {
    // On ne fait jamais échouer la requête côté utilisateur pour ça (même
    // logique que les notifications) — mais on logge pour pouvoir diagnostiquer
    // si le SMTP est mal configuré.
    console.error('Erreur envoi email réinitialisation:', err);
  }

  res.json(genericResponse);
});

// --- POST /api/auth/reset-password ---
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'Token et nouveau mot de passe requis.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères.' });
  }

  const tokenHash = hashResetToken(token);
  const { rows } = await db.query(
    'SELECT id, reset_token_expires FROM users WHERE reset_token_hash = $1',
    [tokenHash]
  );
  const user = rows[0];

  if (!user || !user.reset_token_expires || new Date(user.reset_token_expires) < new Date()) {
    return res.status(400).json({ error: 'Ce lien de réinitialisation est invalide ou expiré.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await db.query(
    'UPDATE users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = $2',
    [passwordHash, user.id]
  );

  res.json({ ok: true, message: 'Mot de passe mis à jour. Tu peux te connecter.' });
});

// --- GET /api/auth/me ---
router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, name, email, tier, pro_until, notify_email, is_admin FROM users WHERE id = $1',
    [req.user.id]
  );
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  res.json({ user: { ...user, notify_email: !!user.notify_email, is_admin: !!user.is_admin } });
});

// --- PATCH /api/auth/notifications ---
// Permet à l'utilisateur connecté d'activer/désactiver l'email à chaque
// nouveau prono (indépendant du palier — ça ne change rien à l'accès).
router.patch('/notifications', requireAuth, async (req, res) => {
  const { notify_email } = req.body;
  if (typeof notify_email !== 'boolean') {
    return res.status(400).json({ error: 'notify_email doit être un booléen.' });
  }
  await db.query('UPDATE users SET notify_email = $1 WHERE id = $2', [notify_email, req.user.id]);
  res.json({ ok: true, notify_email });
});

// --- GET /api/auth/users (admin only) ---
// Liste tous les utilisateurs inscrits, pour le panel admin.
// Ne renvoie jamais password_hash.
router.get('/users', requireAdmin, async (req, res) => {
  const { rows } = await db.query(`
    SELECT id, name, email, tier, pro_until, notify_email, is_admin, created_at
    FROM users
    ORDER BY created_at DESC
  `);

  res.json({
    users: rows.map(u => ({ ...u, notify_email: !!u.notify_email, is_admin: !!u.is_admin }))
  });
});

// --- GET /api/auth/login-history (admin only) ---
// Dernières tentatives de connexion (réussies ou non), pour surveiller les
// accès au panel admin.
router.get('/login-history', requireAdmin, async (req, res) => {
  const { rows } = await db.query(`
    SELECT id, email, success, tier, ip, created_at
    FROM login_events
    ORDER BY created_at DESC
    LIMIT 50
  `);

  res.json({
    events: rows.map(e => ({ ...e, success: !!e.success }))
  });
});

// --- GET /api/auth/stats (admin only) ---
// Chiffres pour le tableau de bord du panel admin : inscriptions par semaine
// (8 dernières semaines) et taux de conversion compte gratuit → pro.
router.get('/stats', requireAdmin, async (req, res) => {
  const { rows: users } = await db.query('SELECT tier, created_at FROM users');

  // Lundi de la semaine contenant `date`, au format YYYY-MM-DD.
  function weekStart(date) {
    const d = new Date(date);
    const day = (d.getDay() + 6) % 7; // 0 = lundi
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - day);
    return d.toISOString().slice(0, 10);
  }

  // Construit les 8 dernières semaines (la plus ancienne en premier), même sans inscription.
  const weeks = [];
  const now = new Date();
  for (let i = 7; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    weeks.push(weekStart(d));
  }
  const counts = Object.fromEntries(weeks.map(w => [w, 0]));
  users.forEach(u => {
    const w = weekStart(u.created_at);
    if (w in counts) counts[w] += 1;
  });

  const totalUsers = users.length;
  const proUsers = users.filter(u => u.tier === 'pro').length;
  const conversionRate = totalUsers > 0 ? Math.round((proUsers / totalUsers) * 1000) / 10 : null;

  res.json({
    signupsByWeek: weeks.map(w => ({ week: w, count: counts[w] })),
    totalUsers,
    proUsers,
    conversionRate,
  });
});

module.exports = router;
