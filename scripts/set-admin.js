// Script utilitaire : donne ou retire le rôle admin à un compte existant.
// Le rôle admin est totalement indépendant du palier payant "tier" —
// un abonné "pro" ne peut PAS accéder au panel admin sans ce flag.
// C'est la seule façon d'obtenir un accès admin, il n'y a pas d'interface
// pour ça (volontairement, pour ne jamais pouvoir se l'auto-attribuer via l'app).
//
// Usage :
//   node scripts/set-admin.js toi@email.com on
//   node scripts/set-admin.js toi@email.com off

require('dotenv').config();
const db = require('../db');

const [, , email, action] = process.argv;

if (!email || !action) {
  console.error('Usage: node scripts/set-admin.js <email> <on|off>');
  process.exit(1);
}
if (!['on', 'off'].includes(action)) {
  console.error('Le second argument doit être "on" ou "off".');
  process.exit(1);
}

const user = db.prepare('SELECT id, name, is_admin FROM users WHERE email = ?').get(email.toLowerCase());
if (!user) {
  console.error(`Aucun compte trouvé pour ${email}. Crée d'abord un compte via le formulaire d'inscription du site.`);
  process.exit(1);
}

const isAdmin = action === 'on' ? 1 : 0;
db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin, user.id);
console.log(`${user.name} (${email}) est ${isAdmin ? 'maintenant admin' : "n'est plus admin"}.`);
console.log('Reconnecte-toi sur le site pour que le changement prenne effet (nouveau token).');
