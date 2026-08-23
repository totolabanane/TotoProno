require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const db = require('./db');
const { attachUser } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const pronosRoutes = require('./routes/pronos');
const billingRoutes = require('./routes/billing');

if (!process.env.JWT_SECRET) {
  console.error('ERREUR: JWT_SECRET manquant dans .env — copie .env.example vers .env et remplis-le.');
  process.exit(1);
}

const app = express();

app.use(cors());

// Le webhook Stripe DOIT recevoir le corps brut (non parsé en JSON) pour
// que la vérification de signature fonctionne — donc monté AVANT
// express.json(), et uniquement pour ce chemin précis.
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(attachUser); // attache req.user (ou null) sur TOUTES les routes

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/pronos', pronosRoutes);
app.use('/api/billing', billingRoutes);

// Site statique (public/index.html + assets) — servi après les routes /api
// pour qu'aucune requête API ne puisse être interceptée par un fichier statique.
app.use(express.static(path.join(__dirname, 'public')));

// Gestion d'erreurs générique (évite de renvoyer des stack traces au client)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur.' });
});

const PORT = process.env.PORT || 3000;

async function start() {
  await db.init(); // crée les tables PostgreSQL si besoin, avant d'accepter des requêtes
  app.listen(PORT, () => {
    console.log(`API prête sur http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = app;
