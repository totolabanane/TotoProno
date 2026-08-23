// Script utilitaire : passe un compte existant au palier "pro".
// Utile pour toi-même (l'admin) puisqu'il n'y a pas de vrai système de
// paiement — c'est la seule façon d'obtenir un accès "pro" pour l'instant.
//
// Usage :
//   node scripts/set-tier.js toi@email.com pro
//   node scripts/set-tier.js toi@email.com account   (pour repasser en compte gratuit)

require('dotenv').config();
const db = require('../db');

const [, , email, tier] = process.argv;

if (!email || !tier) {
  console.error('Usage: node scripts/set-tier.js <email> <account|pro>');
  process.exit(1);
}
if (!['account', 'pro'].includes(tier)) {
  console.error('Le palier doit être "account" ou "pro".');
  process.exit(1);
}

const user = db.prepare('SELECT id, name, tier FROM users WHERE email = ?').get(email.toLowerCase());
if (!user) {
  console.error(`Aucun compte trouvé pour ${email}. Crée d'abord un compte via le formulaire d'inscription du site.`);
  process.exit(1);
}

db.prepare('UPDATE users SET tier = ? WHERE id = ?').run(tier, user.id);
console.log(`${user.name} (${email}) est passé de "${user.tier}" à "${tier}".`);
console.log('Reconnecte-toi sur le site pour que le changement prenne effet (nouveau token).');
