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
  nonNegativeInteger
} = require('../middleware');
const { emitSeatUpdate } = require('../sockets');

const router = express.Router();

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
 * GET /admin/loans — Full circulation register for staff.
 */
router.get('/loans', requireAuth, requireStaff, (req, res) => {
  const loans = db.prepare(`
    SELECT loans.id, loans.issued_at, loans.due_at, loans.returned_at,
           loans.fine_charged, books.title, books.author,
           students.name, students.library_id
    FROM loans
    JOIN books ON books.id = loans.book_id
    JOIN students ON students.id = loans.student_id
    ORDER BY CASE WHEN loans.returned_at IS NULL THEN 0 ELSE 1 END,
             loans.due_at ASC
  `).all();
  res.json({ loans });
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
// BORROW REQUESTS
// ============================================

router.get('/loan-requests', requireAuth, requireStaff, (req, res) => {
  const requests = db.prepare(`
    SELECT borrow_requests.id, borrow_requests.status, borrow_requests.requested_at,
           books.id AS book_id, books.title, books.author,
           students.id AS student_id, students.name, students.library_id
    FROM borrow_requests
    JOIN books ON books.id = borrow_requests.book_id
    JOIN students ON students.id = borrow_requests.student_id
    WHERE borrow_requests.status = 'pending'
    ORDER BY borrow_requests.requested_at ASC
  `).all();
  res.json({ requests });
});

router.post('/loan-requests/:id/approve', requireAuth, requireStaff, (req, res) => {
  const requestId = positiveInteger(req.params.id);
  const request = db.prepare(`
    SELECT borrow_requests.*, books.available_copies
    FROM borrow_requests JOIN books ON books.id = borrow_requests.book_id
    WHERE borrow_requests.id = ? AND borrow_requests.status = 'pending'
  `).get(requestId);
  if (!request) return res.status(404).json({ error: 'Pending request not found' });
  if (request.available_copies <= 0) return res.status(409).json({ error: 'No copies available' });

  const loanDays = Number(db.prepare("SELECT value FROM settings WHERE key = 'loan_period_days'").get().value) || 14;
  const dueDate = new Date(Date.now() + loanDays * 86400000);
  const result = db.transaction(() => {
    const loan = db.prepare('INSERT INTO loans (book_id, student_id, due_at) VALUES (?, ?, ?)').run(request.book_id, request.student_id, dueDate.toISOString());
    db.prepare('UPDATE books SET available_copies = available_copies - 1 WHERE id = ?').run(request.book_id);
    db.prepare("UPDATE borrow_requests SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ? WHERE id = ?").run(req.userId, requestId);
    return loan;
  })();
  res.json({ message: 'Request approved', loanId: result.lastInsertRowid, dueDate: dueDate.toISOString() });
});

router.post('/loan-requests/:id/reject', requireAuth, requireStaff, (req, res) => {
  const requestId = positiveInteger(req.params.id);
  const result = db.prepare("UPDATE borrow_requests SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ? WHERE id = ? AND status = 'pending'").run(req.userId, requestId);
  if (!result.changes) return res.status(404).json({ error: 'Pending request not found' });
  res.json({ message: 'Request rejected' });
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