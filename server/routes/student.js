/**
 * Student profile & penalty routes.
 *
 * Mounted at /api — not under /api/admin — so they are reachable at
 * /api/students/me and /api/penalties/:id/waive.
 */
const express = require('express');
const db = require('../db');
const { requireAuth, requireStaff, positiveInteger } = require('../middleware');

const router = express.Router();

/**
 * GET /students/me — Current student profile + loans + penalties.
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
    WHERE loans.student_id = ? AND loans.returned_at IS NULL
    ORDER BY loans.issued_at DESC
  `).all(req.userId);

  const penalties = db.prepare(`
    SELECT penalties.*, students.name
    FROM penalties
    JOIN students ON penalties.student_id = students.id
    WHERE penalties.student_id = ?
    ORDER BY penalties.created_at DESC
  `).all(req.userId);

  const entryLogs = db.prepare(`
    SELECT entry_logs.id, entry_logs.booked_at, entry_logs.check_in_at,
           entry_logs.check_out_at, entry_logs.status, seats.seat_label
    FROM entry_logs
    JOIN seats ON seats.id = entry_logs.seat_id
    WHERE entry_logs.student_id = ?
    ORDER BY COALESCE(entry_logs.check_in_at, entry_logs.booked_at) DESC
    LIMIT 30
  `).all(req.userId);

  const booking = db.prepare(`
    SELECT id, seat_label, status, held_at, hold_expires_at, occupied_since
    FROM seats
    WHERE (held_by = ? AND status = 'held') OR (occupied_by = ? AND status = 'occupied')
    ORDER BY id LIMIT 1
  `).get(req.userId, req.userId);

  const overdueFinePerDay = Number(db.prepare("SELECT value FROM settings WHERE key = 'overdue_fine_per_day'").get().value) || 0;
  const now = Date.now();
  const activeFine = loans.reduce((total, loan) => {
    if (loan.returned_at || new Date(loan.due_at).getTime() >= now) return total;
    return total + Math.ceil((now - new Date(loan.due_at).getTime()) / 86400000) * overdueFinePerDay;
  }, 0);

  res.json({
    student: {
      id: student.id,
      libraryId: student.library_id,
      name: student.name,
      email: student.email,
      strikes: student.strikes,
      fineBalance: student.fine_balance,
      activeOverdueFine: activeFine,
      booking,
      loans
    },
    loans,
    penalties,
    entryLogs
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

module.exports = router;
