// --- Notifications "nouveau prono" ---
// Deux canaux, tous les deux optionnels et indépendants l'un de l'autre :
//   1. Email  -> envoyé à chaque utilisateur inscrit (notify_email = 1) dont
//                le palier débloque le prono qui vient d'être posté.
//   2. Telegram -> message posté dans un groupe/canal Telegram. Comme
//                l'offre "Pro" annonce un "accès Telegram privé", on distingue
//                un canal pro (contenu complet) d'un canal public éventuel
//                (simple teaser, sans le pick, pour donner envie de créer un compte).
//
// Le tout est conçu pour ne JAMAIS faire planter la création d'un prono :
// si la config SMTP ou Telegram est absente/mauvaise, on logge une erreur
// et on continue — l'admin ne doit pas être bloqué pour poster un pronostic.

const db = require('../db');

const TIER_RANK = { public: 0, account: 1, pro: 2 };
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';

function tierLabel(tier) {
  if (tier === 'pro') return 'Pro';
  if (tier === 'account') return 'Compte gratuit';
  return 'Public';
}

// ---------------------------------------------------------------------------
// TELEGRAM
// ---------------------------------------------------------------------------

async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram API a répondu ${res.status}: ${body}`);
  }
}

async function notifyTelegram(prono) {
  const matchDate = new Date(prono.match_date).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  // Canal privé Pro : contenu complet, réservé aux abonnés qui sont dans ce groupe.
  const proChatId = process.env.TELEGRAM_CHAT_ID_PRO;
  if (proChatId) {
    const lines = [
      `⚽ <b>Nouveau prono</b> — ${prono.match_label}`,
      prono.competition ? `Compétition : ${prono.competition}` : null,
      `Coup d'envoi : ${matchDate}`,
      `Pick : <b>${prono.pick}</b>${prono.odds ? ` (cote ${prono.odds})` : ''}`,
      prono.analysis ? `\n${prono.analysis}` : null,
    ].filter(Boolean);
    await sendTelegram(proChatId, lines.join('\n'));
  }

  // Canal public/annonce : juste un teaser, jamais le pick, pour donner envie
  // de créer un compte ou de passer Pro selon le palier requis.
  const publicChatId = process.env.TELEGRAM_CHAT_ID_PUBLIC;
  if (publicChatId) {
    const lines = [
      `🔔 Nouveau prono publié — ${prono.match_label}`,
      prono.competition ? `Compétition : ${prono.competition}` : null,
      `Coup d'envoi : ${matchDate}`,
      prono.visibility === 'public'
        ? `Palier : public — à voir directement sur le site.`
        : `Palier : ${tierLabel(prono.visibility)} — connecte-toi pour le débloquer.`,
      `${SITE_URL}/offres.html`,
    ].filter(Boolean);
    await sendTelegram(publicChatId, lines.join('\n'));
  }
}

// ---------------------------------------------------------------------------
// EMAIL
// ---------------------------------------------------------------------------

let cachedTransporter;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  if (!process.env.SMTP_HOST) return null;

  // nodemailer est un dependency ajoutée au package.json — fais `npm install`
  // si le paquet n'est pas encore présent dans node_modules.
  const nodemailer = require('nodemailer');
  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    } : undefined,
  });
  return cachedTransporter;
}

function emailBody(prono, user) {
  const matchDate = new Date(prono.match_date).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const unsubscribeNote = `Tu reçois cet email car tu es inscrit sur APEX PRONOS avec les notifications activées. Tu peux les désactiver à tout moment depuis "Mon compte" (${SITE_URL}/compte.html).`;

  return [
    `Bonjour ${user.name},`,
    ``,
    `Un nouveau prono vient d'être publié :`,
    ``,
    `${prono.match_label}${prono.competition ? ' — ' + prono.competition : ''}`,
    `Coup d'envoi : ${matchDate}`,
    `Pick : ${prono.pick}${prono.odds ? ' (cote ' + prono.odds + ')' : ''}`,
    prono.analysis ? `\nAnalyse :\n${prono.analysis}` : '',
    ``,
    `Voir tous les pronos du jour : ${SITE_URL}/offres.html`,
    ``,
    `—`,
    unsubscribeNote,
  ].filter(Boolean).join('\n');
}

async function notifyEmail(prono) {
  const transporter = getTransporter();
  if (!transporter) return; // SMTP non configuré → notification email désactivée silencieusement

  const requiredRank = TIER_RANK[prono.visibility] ?? 0;

  // On ne notifie que les comptes dont le palier débloque CE prono précis —
  // jamais un pick réservé Pro envoyé à un compte gratuit par email.
  const recipients = db.prepare(`
    SELECT id, name, email, tier FROM users
    WHERE notify_email = 1
  `).all().filter(u => (TIER_RANK[u.tier] ?? 0) >= requiredRank);

  if (recipients.length === 0) return;

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  const results = await Promise.allSettled(recipients.map(user =>
    transporter.sendMail({
      from,
      to: user.email,
      subject: `Nouveau prono — ${prono.match_label}`,
      text: emailBody(prono, user),
    })
  ));

  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length > 0) {
    console.error(`notify: ${failed.length}/${recipients.length} emails ont échoué.`, failed[0].reason);
  }
}

// ---------------------------------------------------------------------------
// Point d'entrée unique, appelé après la création d'un prono.
// Volontairement non-bloquant : on ne veut jamais retarder ni faire échouer
// la réponse de POST /api/pronos à cause d'un problème SMTP/Telegram.
// ---------------------------------------------------------------------------

function notifyNewPronoAsync(prono) {
  Promise.allSettled([notifyTelegram(prono), notifyEmail(prono)])
    .then(([telegramResult, emailResult]) => {
      if (telegramResult.status === 'rejected') {
        console.error('notify: Telegram a échoué —', telegramResult.reason.message);
      }
      if (emailResult.status === 'rejected') {
        console.error('notify: Email a échoué —', emailResult.reason.message);
      }
    });
}

// ---------------------------------------------------------------------------
// Réinitialisation de mot de passe
// ---------------------------------------------------------------------------

async function sendPasswordResetEmail(user, resetUrl) {
  const transporter = getTransporter();
  if (!transporter) {
    throw new Error('SMTP non configuré — impossible d\'envoyer l\'email de réinitialisation.');
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const text = [
    `Bonjour ${user.name},`,
    ``,
    `Tu as demandé à réinitialiser ton mot de passe sur TOTOPRONO PRONOS.`,
    ``,
    `Clique sur ce lien pour choisir un nouveau mot de passe (valable 1 heure) :`,
    resetUrl,
    ``,
    `Si tu n'es pas à l'origine de cette demande, ignore simplement cet email — ton mot de passe actuel reste inchangé.`,
  ].join('\n');

  await transporter.sendMail({
    from,
    to: user.email,
    subject: 'Réinitialisation de ton mot de passe',
    text,
  });
}

module.exports = { notifyNewPronoAsync, sendPasswordResetEmail };
