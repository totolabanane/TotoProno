const express = require('express');
const Stripe = require('stripe');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRICE_PRO = process.env.STRIPE_PRICE_PRO;         // prix récurrent mensuel
const STRIPE_PRICE_SEMAINE = process.env.STRIPE_PRICE_SEMAINE; // prix ponctuel
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// Durée d'accès accordée par l'achat ponctuel "Semaine" (7 jours pleins).
const SEMAINE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function requireStripeConfigured(req, res, next) {
  if (!stripe) {
    return res.status(503).json({ error: 'Paiement indisponible : Stripe n\'est pas configuré côté serveur.' });
  }
  next();
}

// --- POST /api/billing/checkout ---
// Crée une session Stripe Checkout pour le plan demandé ('pro' ou 'semaine')
// et renvoie l'URL vers laquelle rediriger l'utilisateur.
router.post('/checkout', requireStripeConfigured, requireAuth, async (req, res) => {
  const { plan } = req.body;
  if (!['pro', 'semaine'].includes(plan)) {
    return res.status(400).json({ error: "plan doit être 'pro' ou 'semaine'." });
  }

  const price = plan === 'pro' ? STRIPE_PRICE_PRO : STRIPE_PRICE_SEMAINE;
  if (!price) {
    return res.status(503).json({ error: `Prix Stripe manquant pour le plan '${plan}' (variable d'env non définie).` });
  }

  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });

  try {
    // Réutilise le customer Stripe existant s'il y en a déjà un pour cet
    // utilisateur, plutôt que d'en recréer un à chaque achat.
    let customerId = user.stripe_customer_id;

    // Si un customer_id est enregistré mais qu'il n'existe plus côté Stripe
    // (basculement Test/Live, suppression manuelle du client...), on ne
    // plante pas : on en recrée un et on remplace l'ancien en base.
    if (customerId) {
      try {
        await stripe.customers.retrieve(customerId);
      } catch (err) {
        if (err.code === 'resource_missing') {
          customerId = null;
        } else {
          throw err;
        }
      }
    }

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { user_id: String(user.id) },
      });
      customerId = customer.id;
      await db.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, user.id]);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: plan === 'pro' ? 'subscription' : 'payment',
      line_items: [{ price, quantity: 1 }],
      success_url: `${SITE_URL}/compte.html?checkout=success`,
      cancel_url: `${SITE_URL}/offres.html?checkout=cancelled`,
      metadata: { user_id: String(user.id), plan },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Erreur création session Stripe Checkout:', err);
    res.status(500).json({ error: 'Impossible de créer la session de paiement.' });
  }
});

// --- POST /api/billing/portal ---
// Renvoie l'URL du portail client Stripe (gérer/annuler l'abonnement Pro,
// voir les factures) pour l'utilisateur connecté.
router.post('/portal', requireStripeConfigured, requireAuth, async (req, res) => {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const user = rows[0];
  if (!user || !user.stripe_customer_id) {
    return res.status(400).json({ error: 'Aucun compte de facturation Stripe associé.' });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${SITE_URL}/compte.html`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Erreur création session portail Stripe:', err);
    res.status(500).json({ error: 'Impossible d\'ouvrir le portail de facturation.' });
  }
});

// --- POST /api/billing/webhook ---
// Reçoit les événements Stripe. Doit recevoir le BODY BRUT (pas parsé en
// JSON) pour que la vérification de signature fonctionne — voir server.js.
router.post('/webhook', requireStripeConfigured, async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature webhook Stripe invalide:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = Number(session.metadata?.user_id);
        const plan = session.metadata?.plan;
        if (!userId || !plan) break;

        if (plan === 'semaine') {
          // Achat ponctuel : accès Pro pendant 7 jours, sans abonnement récurrent.
          const proUntil = new Date(Date.now() + SEMAINE_DURATION_MS).toISOString();
          await db.query(`UPDATE users SET tier = 'pro', pro_until = $1 WHERE id = $2`, [proUntil, userId]);
        } else if (plan === 'pro' && session.subscription) {
          await db.query(
            `UPDATE users SET tier = 'pro', stripe_subscription_id = $1 WHERE id = $2`,
            [session.subscription, userId]
          );
        }
        break;
      }

      // Renouvellement mensuel payé avec succès : on prolonge l'accès jusqu'à
      // la fin de la nouvelle période de facturation.
      case 'invoice.paid': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;
        if (!subscriptionId) break;
        const { rows } = await db.query('SELECT id FROM users WHERE stripe_subscription_id = $1', [subscriptionId]);
        const user = rows[0];
        if (!user) break;
        const periodEnd = invoice.lines?.data?.[0]?.period?.end;
        const proUntil = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
        await db.query(`UPDATE users SET tier = 'pro', pro_until = $1 WHERE id = $2`, [proUntil, user.id]);
        break;
      }

      // Paiement du renouvellement refusé (carte expirée, fonds insuffisants...).
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;
        if (!subscriptionId) break;
        console.warn(`Paiement échoué pour l'abonnement Stripe ${subscriptionId} — l'utilisateur repassera en compte gratuit à expiration de pro_until.`);
        break;
      }

      // Abonnement annulé (par l'utilisateur via le portail, ou après échecs
      // de paiement répétés) : retour immédiat au palier gratuit.
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        await db.query(`
          UPDATE users SET tier = 'account', stripe_subscription_id = NULL, pro_until = NULL
          WHERE stripe_subscription_id = $1
        `, [subscription.id]);
        break;
      }

      default:
        // Événement non géré — ignoré volontairement.
        break;
    }
  } catch (err) {
    console.error('Erreur traitement webhook Stripe:', err);
    // On répond quand même 200 pour éviter que Stripe ne rejoue indéfiniment
    // un événement qui échoue systématiquement côté serveur ; l'erreur est loguée.
  }

  res.json({ received: true });
});

module.exports = router;
