const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Lit le token JWT s'il existe et attache l'utilisateur à req.user.
 * Ne bloque JAMAIS la requête — un visiteur sans compte doit pouvoir
 * accéder au contenu public. C'est aux routes de décider ce qui est
 * accessible selon req.user (ou son absence).
 *
 * Important : le token ne sert qu'à identifier QUI est l'utilisateur
 * (id/email) — son palier (tier) et son statut admin sont toujours
 * relus depuis la base à chaque requête. Le tier ne doit jamais être
 * figé dans le JWT : un paiement Stripe met à jour la base via webhook
 * bien après l'émission du token, et un token vieux de plusieurs
 * semaines (durée de vie 30 jours) ne doit pas continuer à refléter un
 * ancien palier périmé.
 */
async function attachUser(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  const token = header.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await db.query('SELECT id, email, name, tier, is_admin FROM users WHERE id = $1', [payload.id]);
    const fresh = rows[0];
    if (!fresh) {
      req.user = null;
    } else {
      req.user = { id: fresh.id, email: fresh.email, name: fresh.name, tier: fresh.tier, is_admin: !!fresh.is_admin };
    }
  } catch (err) {
    req.user = null;
  }
  next();
}

/**
 * Bloque la route si l'utilisateur n'est pas connecté.
 */
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Connexion requise.' });
  }
  next();
}

/**
 * Bloque la route si l'utilisateur n'a pas le palier "pro" actif.
 */
function requirePro(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Connexion requise.' });
  }
  if (req.user.tier !== 'pro') {
    return res.status(403).json({ error: 'Abonnement Pro requis.' });
  }
  next();
}

/**
 * Bloque la route si l'utilisateur n'a pas le rôle admin.
 * Complètement indépendant du palier payant "pro" : un abonné pro qui
 * paie pour débloquer des pronos n'a PAS accès au panel admin pour autant.
 * Seuls les comptes marqués is_admin (via scripts/set-admin.js) passent.
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Connexion requise.' });
  }
  if (!req.user.is_admin) {
    return res.status(403).json({ error: 'Accès administrateur requis.' });
  }
  next();
}

module.exports = { attachUser, requireAuth, requirePro, requireAdmin };