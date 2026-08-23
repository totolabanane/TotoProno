# APEX Pronos — Backend

API pour le site de pronostics avec 3 paliers d'accès : public, compte gratuit, pro (payant).

## Stack
- Node.js + Express
- SQLite (better-sqlite3) — fichier local, migrable vers PostgreSQL plus tard
- bcrypt (hash des mots de passe)
- JWT (sessions)

## Installation

```bash
npm install
cp .env.example .env
# ouvre .env et remplace JWT_SECRET par une vraie chaîne aléatoire longue
npm start
```

Le serveur démarre sur http://localhost:3000 (ou le PORT défini dans .env).
La base de données SQLite est créée automatiquement dans `./data/apex.db` au premier lancement.

## Endpoints

### Auth
- `POST /api/auth/signup` — { name, email, password } → crée un compte palier "account"
- `POST /api/auth/login` — { email, password } → renvoie un token JWT
- `GET /api/auth/me` — (avec token) → infos du compte connecté

### Pronos
- `GET /api/pronos` — renvoie tous les pronos. Le contenu (pick/cote/analyse) n'est
  inclus QUE si le visiteur/utilisateur a le palier suffisant. Sans token → seul le
  contenu "public" est visible. Le filtrage se fait côté serveur, jamais côté client.
- `POST /api/pronos` — (réservé pro/admin pour l'instant) crée un prono avec un palier
  de visibilité : "public" | "account" | "pro"
- `PATCH /api/pronos/:id/result` — (réservé pro/admin) enregistre le résultat (won/lost)

## Notifications "nouveau prono"

Quand un prono est créé (`POST /api/pronos`), deux canaux optionnels et
indépendants peuvent prévenir automatiquement — chacun ne s'active que si sa
config est présente dans `.env` :

- **Email** : chaque utilisateur inscrit avec `notify_email = true` reçoit un
  email, mais uniquement si son palier débloque *ce* prono précis (jamais un
  pick Pro envoyé par email à un compte gratuit). Configure `SMTP_HOST`,
  `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` dans `.env`. Fonctionne
  avec n'importe quel fournisseur SMTP (Brevo, Mailgun, Gmail SMTP...).
  Nécessite `npm install` pour récupérer la dépendance `nodemailer` ajoutée
  au `package.json`.
- **Telegram** : `TELEGRAM_CHAT_ID_PRO` reçoit le prono en clair (pick + cote +
  analyse) — pensé pour le "accès Telegram privé" déjà annoncé sur la page
  Offres. `TELEGRAM_CHAT_ID_PUBLIC` (optionnel) reçoit juste une annonce sans
  le pick, pour donner envie de créer un compte ou de passer Pro.

Chaque utilisateur peut activer/désactiver l'email depuis "Mon compte", ou via
`PATCH /api/auth/notifications` avec `{ "notify_email": true|false }`.

Si aucune config SMTP/Telegram n'est fournie, la création de prono fonctionne
normalement — les notifications sont simplement no-op (aucune erreur, aucun
blocage de l'admin).

## Important avant la mise en prod

1. **Le paiement n'est pas encore branché.** Le passage au palier "pro" doit être
   déclenché par ton futur système de paiement (ex: Stripe webhook) qui fera
   `UPDATE users SET tier='pro', pro_until=... WHERE id=...` — pas encore fait ici.

2. **Le rôle "admin" n'existe pas encore.** Pour l'instant, `requirePro` protège la
   création de pronos — ce qui veut dire que n'importe quel abonné payant pourrait
   théoriquement poster un pronostic. Il faudra un vrai champ "role: admin" distinct
   du palier d'abonnement avant la mise en ligne publique.

3. **CORS est ouvert à tous les domaines** (`cors()` sans config). À restreindre à
   ton (futur) nom de domaine avant la mise en prod.

4. **SQLite convient pour démarrer**, mais si tu montes en charge (beaucoup
   d'utilisateurs simultanés), prévois une migration vers PostgreSQL — la structure
   des requêtes ne change presque pas.
