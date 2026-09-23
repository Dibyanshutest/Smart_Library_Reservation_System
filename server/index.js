/**
 * Smart Library System — Express entry point.
 *
 * Architecture:
 *  - server/middleware.js   shared helpers (JWT, guards, rate limiter, validators)
 *  - server/sockets.js      Socket.IO init + emit helpers
 *  - server/db.js           better-sqlite3 connection + seeding
 *  - server/routes/*.js     modular route modules mounted below
 *  - server/jobs/expireHolds.js  background seat-hold expiry job
 */

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');

const db = require('./db');
const { startExpireHoldsJob } = require('./jobs/expireHolds');
const { initSocket } = require('./sockets');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// ---- Middleware -------------------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const clientPath = path.join(__dirname, '..', 'client');
app.use(express.static(clientPath));
app.use('/client', express.static(clientPath));
app.use('/vendor/html5-qrcode', express.static(path.join(__dirname, '..', 'node_modules', 'html5-qrcode')));

// ---- Standalone endpoints ---------------------------------------------------

/**
 * GET /api/categories — Distinct book categories for the catalog filter.
 */
app.get('/api/categories', (req, res) => {
  const categories = db.prepare('SELECT DISTINCT category FROM books WHERE category IS NOT NULL ORDER BY category').all();
  res.json({ categories });
});

/**
 * GET /api/health — Health-check endpoint for deployment & tests.
 */
app.get('/api/health', (req, res) => {
  try {
    const count = db.prepare('SELECT COUNT(*) AS n FROM books').get().n;
    res.json({ status: 'ok', db: 'connected', books: count });
  } catch (error) {
    res.status(503).json({ status: 'error', db: 'disconnected' });
  }
});

// ---- Route modules ----------------------------------------------------------
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/books',       require('./routes/books'));
app.use('/api/loans',       require('./routes/loans'));
app.use('/api/seats',       require('./routes/seats'));
app.use('/api/entry',       require('./routes/entry'));
app.use('/api/admin',       require('./routes/admin'));
app.use('/api',             require('./routes/student'));

// ---- Socket.IO --------------------------------------------------------------
initSocket(server);

// ---- Background jobs --------------------------------------------------------
startExpireHoldsJob(db);

// ---- Start server -----------------------------------------------------------
server.listen(PORT, () => {
  console.log(`Smart Library System running at http://localhost:${PORT}`);
});
