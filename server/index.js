const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');
const db = require('./db');

const {
  JWT_SECRET,
  requireAuth,
  requireStaff,
  rateLimit
} = require('./middleware');
const { initSocket } = require('./sockets');
const authRoutes = require('./routes/auth');
const bookRoutes = require('./routes/books');
const loansRoutes = require('./routes/loans');
const seatRoutes = require('./routes/seats');
const entryRoutes = require('./routes/entry');
const adminRoutes = require('./routes/admin');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const clientPath = path.join(__dirname, '..', 'client');
app.use(express.static(clientPath));
app.use('/client', express.static(clientPath));

app.get('/', (req, res) => {
  res.sendFile(path.join(clientPath, 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, service: 'smart-library', time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'Database unavailable' });
  }
});

// API categories
app.get('/api/categories', (req, res) => {
  const categories = [...new Set(
    db.prepare('SELECT category FROM books').all()
      .map(r => r.category)
      .filter(Boolean)
  )];
  res.json({ categories });
});

// Stricter rate limit for auth endpoints
const authRateLimiter = rateLimit({ windowMs: 60000, max: 5 });
app.use('/api/auth/register', authRateLimiter);
app.use('/api/auth/login', authRateLimiter);
app.use('/api/auth/staff-login', authRateLimiter);

// Standalone student endpoints
app.get('/api/students/me', requireAuth, (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.userId);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const loans = db.prepare(`
    SELECT loans.*, books.title, books.author
    FROM loans JOIN books ON loans.book_id = books.id
    WHERE loans.student_id = ? ORDER BY loans.issued_at DESC
  `).all(req.userId);
  const penalties = db.prepare(`
    SELECT penalties.*, students.name FROM penalties
    JOIN students ON penalties.student_id = students.id
    WHERE penalties.student_id = ? ORDER BY penalties.created_at DESC
  `).all(req.userId);
  res.json({
    student: { id: student.id, libraryId: student.library_id, name: student.name,
      email: student.email, strikes: student.strikes, cooldownUntil: student.cooldown_until,
      fineBalance: student.fine_balance }, loans, penalties
  });
});

app.get('/api/students/me/penalties', requireAuth, (req, res) => {
  const penalties = db.prepare(`
    SELECT penalties.*, students.name FROM penalties
    JOIN students ON penalties.student_id = students.id
    WHERE penalties.student_id = ? ORDER BY penalties.created_at DESC
  `).all(req.userId);
  res.json({ penalties });
});

app.post('/api/penalties/:id/waive', requireAuth, requireStaff, (req, res) => {
  const penaltyId = Number(req.params.id);
  if (!penaltyId) return res.status(400).json({ error: 'Invalid penalty ID' });
  const penalty = db.prepare('SELECT * FROM penalties WHERE id = ?').get(penaltyId);
  if (!penalty) return res.status(404).json({ error: 'Penalty not found' });
  if (penalty.waived_at) return res.status(409).json({ error: 'Penalty already waived' });
  db.transaction(() => {
    db.prepare('UPDATE penalties SET waived_by = ?, waived_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(req.userId, penaltyId);
    db.prepare(`UPDATE students SET strikes = CASE WHEN strikes > 0 THEN strikes - 1 ELSE 0 END,
      cooldown_until = CASE WHEN cooldown_until > CURRENT_TIMESTAMP THEN NULL ELSE cooldown_until END
      WHERE id = ?`).run(penalty.student_id);
  })();
  res.json({ message: 'Penalty waived successfully' });
});

// Standalone QR endpoint
app.get('/api/entry/qr', requireAuth, async (req, res) => {
  try {
    const QRCode = require('qrcode');
    const student = db.prepare('SELECT qr_token FROM students WHERE id = ?').get(req.userId);
    if (!student) return res.status(404).json({ error: 'Student not found' });
    const qrDataUrl = await QRCode.toDataURL(student.qr_token, { margin: 1, width: 256 });
    res.json({ qrDataUrl });
  } catch (err) { res.status(500).json({ error: 'Failed to generate QR' }); }
});

// Mount route modules
app.use('/api/auth', authRoutes);
app.use('/api/books', bookRoutes);
app.use('/api/loans', loansRoutes);
app.use('/api/seats', seatRoutes);
app.use('/api/entry', entryRoutes);
app.use('/api/admin', adminRoutes);

// Socket.IO
initSocket(server);

// Background expiry job
require('./jobs/expireHolds').startExpireHoldsJob(db);

// 404 & error handler
app.use((req, res) => { res.status(404).json({ error: 'Not found' }); });
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Internal server error' }); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Smart Library System running at http://localhost:${PORT}`); });