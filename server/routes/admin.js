/**
 * Admin / Analytics routes.
 *
 * Requires staff (librarian/admin) role for most endpoints.
 * Student-only endpoints (/students/me, /students/me/penalties, /penalties/:id/waive)
 * are included here but use different auth guards in the handlers.
 */
const express = require('express');
const db = require('../db');
const {
  requireAuth,
  requireStaff,
  requireAdmin,
  positiveInteger,
  nonNegativeInteger,
  rateLimit
} = require('../middleware');
const { emitSeatUpdate } = require('../sockets');

const router = express.Router();

// ============================================
// STUDENT PROFILE & PENALTIES (student-authenticated)
// ============================================

/**
 * GET /students/me — Current student profile.
 */
router.get('/students/me', requireAuth, (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.userId);
  if (!student) {
    return res.status(404).json({ error: 'Student not found' });
  }

  const loans = db.prepare(`
    SELECT loans.*, books.title, books.author
    FROM loans
    JOIN books ON loans.book_id = books.id
    WHERE loans.student_id = ?
    ORDER BY loans.issued_at DESC
  `).all(req.userId);

  const penalties = db.prepare(`
    SELECT penalties.*, students.name
    FROM penalties
    JOIN students ON penalties.student_id = students.id
    WHERE penalties.student_id = ?
    ORDER BY penalties.created_at DESC
  `).all(req.userId);

  res.json({
    student: {
      id: student.id,
      libraryId: student.library_id,
      name: student.name,
      email: student.email,
      strikes: student.strikes,
      cooldownUntil: student.cooldown_until,
      fineBalance: student.fine_balance
    },
    loans,
    penalties
  });
});

/**
 * GET /students/me/penalties — Penalty history for the current student.
 */
router.get('/students/me/penalties', requireAuth, (req, res) => {
  const penalties = db.prepare(`
    SELECT penalties.*, students.name
    FROM penalties
    JOIN students ON penalties.student_id = students.id
    WHERE penalties.student_id = ?
    ORDER BY penalties.created_at DESC
  `).all(req.userId);

  res.json({ penalties });
});

/**
 * POST /penalties/:id/waive — Waive a penalty (staff only).
 */
router.post('/penalties/:id/waive', requireAuth, (req, res) => {
  if (req.role !== 'admin' && req.role !== 'librarian') {
    return res.status(403).json({ error: 'Staff access required' });
  }

  const penaltyId = positiveInteger(req.params.id);
  if (!penaltyId) return res.status(400).json({ error: 'Invalid penalty ID' });

  const penalty = db.prepare('SELECT * FROM penalties WHERE id = ?').get(penaltyId);
  if (!penalty) {
    return res.status(404).json({ error: 'Penalty not found' });
  }
  if (penalty.waived_at) {
    return res.status(409).json({ error: 'Penalty is already waived' });
  }

  db.transaction(() => {
    db.prepare(`UPDATE penalties SET waived_by = ?, waived_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(req.userId, penaltyId);
    db.prepare(`
      UPDATE students
      SET strikes = CASE WHEN strikes > 0 THEN strikes - 1 ELSE 0 END,
        cooldown_until = CASE WHEN cooldown_until > CURRENT_TIMESTAMP THEN NULL ELSE cooldown_until END
      WHERE id = ?
    `).run(penalty.student_id);
  })();

  res.json({ message: 'Penalty waived successfully' });
});

// ============================================
// ADMIN / ANALYTICS (staff-only)
// ============================================

/**
 * GET /admin/occupancy — Live occupancy counts.
 */
router.get('/occupancy', requireAuth, requireStaff, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS count FROM seats').get().count;
  const occupied = db.prepare("SELECT COUNT(*) AS count FROM seats WHERE status = 'occupied'").get().count;
  const held = db.prepare("SELECT COUNT(*) AS count FROM seats WHERE status = 'held'").get().count;
  const available = db.prepare("SELECT COUNT(*) AS count FROM seats WHERE status = 'available'").get().count;

  res.json({
    total,
    occupied,
    held,
    available,
    occupancyRate: total ? (occupied / total) * 100 : 0
  });
});

/**
 * GET /admin/defaulters — Students with most no-shows.
 */
router.get('/defaulters', requireAuth, requireStaff, (req, res) => {
  const defaulters = db.prepare(`
    SELECT students.id, students.library_id, students.name,
           COUNT(penalties.id) AS no_show_count,
           MAX(penalties.created_at) AS last_penalty
    FROM students
    LEFT JOIN penalties ON students.id = penalties.student_id
    WHERE penalties.reason = 'no_show'
    GROUP BY students.id
    ORDER BY no_show_count DESC
    LIMIT 10
  `).all();

  res.json({ defaulters });
});

/**
 * GET /admin/settings — Get system settings.
 */
router.get('/settings', requireAuth, requireStaff, (req, res) => {
  const settings = db.prepare('SELECT key, value FROM settings').all();
  const settingsObj = {};
  settings.forEach(setting => {
    settingsObj[setting.key] = Number(setting.value);
  });

  res.json({ settings: settingsObj });
});

/**
 * PUT /admin/settings — Update system settings.
 */
router.put('/settings', requireAuth, requireStaff, (req, res) => {
  const settings = req.body.settings || req.body;
  const allowedKeys = [
    'booking_hold_minutes',
    'strikes_before_cooldown',
    'cooldown_hours',
    'no_show_fine',
    'overdue_fine_per_day',
    'loan_period_days'
  ];

  const updateSetting = db.prepare('UPDATE settings SET value = ? WHERE key = ?');

  for (const key of allowedKeys) {
    if (settings[key] !== undefined) {
      const value = Number(settings[key]);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ error: `${key} must be a non-negative number` });
      }
      updateSetting.run(String(value), key);
    }
  }

  res.json({ message: 'Settings updated successfully' });
});

/**
 * GET /admin/analytics — Historical analytics (peak hours + circulation).
 */
router.get('/analytics', requireAuth, requireStaff, (req, res) => {
  const peakHours = db.prepare(`
    SELECT CAST(strftime('%H', COALESCE(check_in_at, check_out_at)) AS INTEGER) AS hour,
           COUNT(*) AS visits
    FROM entry_logs
    WHERE check_in_at IS NOT NULL
    GROUP BY hour
    ORDER BY hour
  `).all();
  const circulation = db.prepare(`
    SELECT COUNT(*) AS total_loans,
           SUM(CASE WHEN returned_at IS NULL THEN 1 ELSE 0 END) AS active_loans,
           SUM(CASE WHEN returned_at IS NOT NULL THEN 1 ELSE 0 END) AS returned_loans,
           COALESCE(SUM(fine_charged), 0) AS fines_charged
    FROM loans
  `).get();
  res.json({ peakHours, circulation });
});

/**
 * GET /admin/penalties — All penalties (staff only).
 */
router.get('/penalties', requireAuth, requireStaff, (req, res) => {
  const penalties = db.prepare(`
    SELECT penalties.id, penalties.reason, penalties.created_at, penalties.waived_at,
           students.library_id, students.name
    FROM penalties JOIN students ON students.id = penalties.student_id
    ORDER BY penalties.created_at DESC LIMIT 50
  `).all();
  res.json({ penalties });
});

// ============================================
// BOOK OVERRIDE
// ============================================

/**
 * PUT /admin/books/:id/availability — Override book availability (staff only).
 */
router.put('/books/:id/availability', requireAuth, requireStaff, (req, res) => {
  const bookId = positiveInteger(req.params.id);
  if (!bookId) return res.status(400).json({ error: 'Invalid book ID' });

  const availableCopies = nonNegativeInteger(req.body.availableCopies);
  if (availableCopies === null) {
    return res.status(400).json({ error: 'availableCopies must be a non-negative integer' });
  }

  const book = db.prepare('SELECT total_copies FROM books WHERE id = ?').get(bookId);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  if (availableCopies > book.total_copies) {
    return res.status(400).json({ error: 'Available copies cannot exceed total copies' });
  }

  db.prepare('UPDATE books SET available_copies = ? WHERE id = ?')
    .run(availableCopies, bookId);

  res.json({ message: 'Book availability updated successfully' });
});

// ============================================
// SEAT EDITOR
// ============================================

/**
 * POST /admin/seats — Add a seat (staff only).
 */
router.post('/seats', requireAuth, requireStaff, (req, res) => {
  const { seatLabel, hall = 'main', posX, posY } = req.body;
  const x = positiveInteger(posX);
  const y = positiveInteger(posY);
  if (!seatLabel || !x || !y) {
    return res.status(400).json({ error: 'Seat label and valid position are required' });
  }
  try {
    const result = db.prepare(`
      INSERT INTO seats (seat_label, hall, pos_x, pos_y, status) VALUES (?, ?, ?, ?, 'available')
    `).run(seatLabel.trim(), hall.trim(), x, y);
    emitSeatUpdate();
    res.status(201).json({ message: 'Seat added successfully', seatId: result.lastInsertRowid });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Seat already exists' });
    }
    throw error;
  }
});

/**
 * PATCH /admin/seats/:id — Update seat status (maintenance toggle).
 */
router.patch('/seats/:id', requireAuth, requireStaff, (req, res) => {
  const seatId = positiveInteger(req.params.id);
  if (!seatId) return res.status(400).json({ error: 'Invalid seat ID' });

  const allowedStatuses = ['available', 'maintenance'];
  const { status } = req.body;
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'Status must be available or maintenance' });
  }

  const result = db.prepare(`
    UPDATE seats SET status = ?, held_by = NULL, held_at = NULL, hold_expires_at = NULL
    WHERE id = ? AND status NOT IN ('held', 'occupied')
  `).run(status, seatId);
  if (!result.changes) {
    return res.status(409).json({ error: 'Seat is active or does not exist' });
  }
  emitSeatUpdate();
  res.json({ message: 'Seat status updated successfully' });
});

/**
 * DELETE /admin/seats/:id — Remove a seat (staff only, inactive seats only).
 */
router.delete('/seats/:id', requireAuth, requireStaff, (req, res) => {
  const seatId = positiveInteger(req.params.id);
  if (!seatId) return res.status(400).json({ error: 'Invalid seat ID' });

  const seat = db.prepare('SELECT status FROM seats WHERE id = ?').get(seatId);
  if (!seat) return res.status(404).json({ error: 'Seat not found' });
  if (seat.status !== 'available' && seat.status !== 'maintenance') {
    return res.status(409).json({ error: 'Only inactive seats can be removed' });
  }

  db.prepare('DELETE FROM seats WHERE id = ?').run(seatId);
  emitSeatUpdate();
  res.json({ message: 'Seat removed successfully' });
});

// ============================================
// STAFF MANAGEMENT (admin only)
// ============================================

/**
 * GET /admin/staff — List all staff accounts (admin only).
 */
router.get('/staff', requireAuth, requireAdmin, (req, res) => {
  const staff = db.prepare('SELECT id, name, email, role FROM staff ORDER BY name').all();
  res.json({ staff });
});

/**
 * POST /admin/staff — Create a staff account (admin only).
 */
router.post('/staff', requireAuth, requireAdmin, async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || password.length < 8 || !['admin', 'librarian'].includes(role)) {
    return res.status(400).json({ error: 'Name, valid email, role, and an 8-character password are required' });
  }
  try {
    const bcrypt = require('bcrypt');
    const passwordHash = await bcrypt.hash(password, 10);
    const result = db.prepare(`
      INSERT INTO staff (name, email, password_hash, role) VALUES (?, ?, ?, ?)
    `).run(name.trim(), email.trim().toLowerCase(), passwordHash, role);
    res.status(201).json({ message: 'Staff account created successfully', staffId: result.lastInsertRowid });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Staff email already exists' });
    }
    throw error;
  }
});

/**
 * PATCH /admin/staff/:id — Update a staff account (admin only).
 */
router.patch('/staff/:id', requireAuth, requireAdmin, (req, res) => {
  const staffId = positiveInteger(req.params.id);
  if (!staffId) return res.status(400).json({ error: 'Invalid staff ID' });

  const { name, role } = req.body;
  if (!['admin', 'librarian'].includes(role) || !name) {
    return res.status(400).json({ error: 'Name and valid role are required' });
  }

  const result = db.prepare('UPDATE staff SET name = ?, role = ? WHERE id = ?')
    .run(name.trim(), role, staffId);
  if (!result.changes) return res.status(404).json({ error: 'Staff account not found' });

  res.json({ message: 'Staff account updated successfully' });
});

module.exports = router;