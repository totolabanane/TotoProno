const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { notifyNewPronoAsync } = require('../lib/notify');

const router = express.Router();

const TIER_RANK = { public: 0, account: 1, pro: 2 };

function userRank(user) {
  if (!user) return 0; // visiteur non connecté = accès public seulement
  if (user.is_admin) return TIER_RANK.pro; // l'admin voit toujours tout, indépendamment de son palier payant
  return TIER_RANK[user.tier] ?? 0;
}

// --- GET /api/pronos/stats ---
// Statistiques agrégées publiques pour le bandeau marketing du site.
// Ne révèle aucun pick verrouillé — uniquement des compteurs calculés
// sur l'ensemble des pronos (public + compte + pro confondus).
router.get('/stats', (req, res) => {
  const rows = db.prepare('SELECT visibility, odds, result FROM pronos').all();

  const total = rows.length;
  const resolved = rows.filter(r => r.result === 'won' || r.result === 'lost');
  const wins = resolved.filter(r => r.result === 'won').length;

  const winRate = resolved.length > 0 ? Math.round((wins / resolved.length) * 100) : null;

  // Convention "1 unité misée par pick" : +(cote-1) si gagné, -1 si perdu.
  const netUnits = resolved.reduce((sum, r) => {
    if (r.result === 'won') return sum + ((r.odds || 1) - 1);
    return sum - 1;
  }, 0);

  res.json({
    total,
    resolved: resolved.length,
    winRate,
    netUnits: Math.round(netUnits * 10) / 10,
  });
});

// --- GET /api/pronos ---
// Renvoie tous les pronos du jour, mais masque le contenu (pick/cote/analyse)
// des pronos dont le palier est supérieur à celui de l'utilisateur.
// req.user est déjà attaché (ou null) par le middleware attachUser global.
router.get('/', (req, res) => {
  const rank = userRank(req.user);

  const rows = db.prepare(`
    SELECT id, match_label, competition, pick, odds, analysis, visibility, match_date, result, hors_anj
    FROM pronos
    ORDER BY match_date ASC
  `).all();

  const result = rows.map(row => {
    const requiredRank = TIER_RANK[row.visibility] ?? 0;
    const unlocked = rank >= requiredRank;

    return {
      id: row.id,
      match_label: row.match_label,
      competition: row.competition,
      match_date: row.match_date,
      visibility: row.visibility,
      result: row.result,
      unlocked,
      hors_anj: !!row.hors_anj, // toujours visible, verrouillé ou non — c'est un avertissement légal
      // Le contenu sensible est retiré côté serveur si non débloqué —
      // jamais envoyé au client puis "caché" en CSS (ça se contournerait en 2 secondes).
      pick: unlocked ? row.pick : null,
      odds: unlocked ? row.odds : null,
      analysis: unlocked ? row.analysis : null,
    };
  });

  res.json({ pronos: result });
});

// --- POST /api/pronos (admin only) ---
router.post('/', requireAdmin, (req, res) => {
  const { match_label, competition, pick, odds, analysis, visibility, match_date, hors_anj } = req.body;

  if (!match_label || !pick || !visibility || !match_date) {
    return res.status(400).json({ error: 'match_label, pick, visibility et match_date sont requis.' });
  }
  if (!TIER_RANK.hasOwnProperty(visibility)) {
    return res.status(400).json({ error: "visibility doit être 'public', 'account' ou 'pro'." });
  }

  const info = db.prepare(`
    INSERT INTO pronos (match_label, competition, pick, odds, analysis, visibility, match_date, hors_anj)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(match_label, competition || null, pick, odds || null, analysis || null, visibility, match_date, hors_anj ? 1 : 0);

  // Notification (email + Telegram) — volontairement non "awaité" pour que
  // la réponse à l'admin ne soit jamais ralentie ou bloquée par SMTP/Telegram.
  notifyNewPronoAsync({
    id: Number(info.lastInsertRowid),
    match_label, competition, pick, odds, analysis, visibility, match_date,
  });

  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

// --- PATCH /api/pronos/:id/result (admin only) ---
router.patch('/:id/result', requireAdmin, (req, res) => {
  const { result } = req.body; // 'won' | 'lost'
  if (!['won', 'lost'].includes(result)) {
    return res.status(400).json({ error: "result doit être 'won' ou 'lost'." });
  }
  db.prepare('UPDATE pronos SET result = ? WHERE id = ?').run(result, req.params.id);
  res.json({ ok: true });
});

// --- DELETE /api/pronos/:id (admin only) ---
// Supprime définitivement un prono (ex: erreur de saisie, match annulé).
router.delete('/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT id FROM pronos WHERE id = ?').get(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Prono introuvable.' });
  }
  db.prepare('DELETE FROM pronos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- GET /api/pronos/win-rates-by-tier (admin only) ---
// Taux de réussite des pronos résolus, groupé par palier requis (public/account/pro).
router.get('/win-rates-by-tier', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT visibility, result FROM pronos').all();

  const byTier = { public: [], account: [], pro: [] };
  rows.forEach(r => {
    if (byTier[r.visibility]) byTier[r.visibility].push(r.result);
  });

  const stats = Object.entries(byTier).map(([tier, results]) => {
    const resolved = results.filter(r => r === 'won' || r === 'lost');
    const wins = resolved.filter(r => r === 'won').length;
    return {
      tier,
      total: results.length,
      resolved: resolved.length,
      wins,
      winRate: resolved.length > 0 ? Math.round((wins / resolved.length) * 1000) / 10 : null,
    };
  });

  res.json({ stats });
});

module.exports = router;
