/**
 * Seat routes: list seats, book a seat, cancel a booking.
 */
const express = require('express');
const db = require('../db');
const {
  requireAuth,
  positiveInteger,
  rateLimit
} = require('../middleware');
const { emitSeatUpdate } = require('../sockets');

const router = express.Router();
const seatWriteRateLimit = rateLimit({ windowMs: 60 * 1000, max: 30 });

/**
 * GET /api/seats — Current status of all seats.
 * Accessible to all authenticated users.
 */
router.get('/', (req, res) => {
  const seats = db.prepare('SELECT * FROM seats ORDER BY hall, pos_x, pos_y').all();
  res.json({ seats });
});

router.get('/mine', requireAuth, (req, res) => {
  const booking = db.prepare(`
    SELECT id, seat_label, status, held_at, hold_expires_at, occupied_since
    FROM seats
    WHERE (held_by = ? AND status = 'held') OR (occupied_by = ? AND status = 'occupied')
    ORDER BY id LIMIT 1
  `).get(req.userId, req.userId);
  res.json({ booking: booking || null });
});

/**
 * POST /api/seats/:id/book — Book a seat (atomic operation).
 * Enforces cooldown, prevents double-booking, race-condition safe.
 */
router.post('/:id/book', requireAuth, seatWriteRateLimit, (req, res) => {
  const seatId = positiveInteger(req.params.id);
  const studentId = req.userId;

  if (!seatId) {
    return res.status(400).json({ error: 'Invalid seat ID' });
  }

  const seat = db.prepare('SELECT * FROM seats WHERE id = ?').get(seatId);
  if (!seat) {
    return res.status(404).json({ error: 'Seat not found' });
  }

  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if (!student) {
    return res.status(404).json({ error: 'Student not found' });
  }

  // Cooldown enforcement
  if (student.cooldown_until && new Date(student.cooldown_until) > new Date()) {
    return res.status(403).json({
      error: `You're temporarily blocked from booking until ${student.cooldown_until}`
    });
  }

  // Prevent double-booking: active held seat
  const activeHeld = db.prepare(`
    SELECT * FROM seats
    WHERE held_by = ? AND status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at > datetime('now')
  `).get(studentId);
  if (activeHeld) {
    return res.status(409).json({ error: 'You already have an active seat booking' });
  }

  // Prevent double-booking: already occupied
  const activeOccupied = db.prepare(`
    SELECT * FROM seats WHERE occupied_by = ? AND status = 'occupied'
  `).get(studentId);
  if (activeOccupied) {
    return res.status(409).json({ error: 'You are already seated in a seat' });
  }

  // Atomic seat booking: only succeeds if seat is still 'available'
  const holdMinutes = Number(db.prepare("SELECT value FROM settings WHERE key = 'booking_hold_minutes'").get().value) || 15;
  const result = db.prepare(`
    UPDATE seats
    SET status = 'held', held_by = ?, held_at = CURRENT_TIMESTAMP,
        hold_expires_at = datetime('now', '+' || ? || ' minutes')
    WHERE id = ? AND status = 'available'
  `).run(studentId, holdMinutes, seatId);

  if (result.changes === 0) {
    return res.status(409).json({ error: 'Seat just got taken, please pick another' });
  }

  emitSeatUpdate();

  res.status(201).json({
    message: 'Seat booked successfully',
    seatId,
    expiresAt: new Date(Date.now() + holdMinutes * 60 * 1000).toISOString()
  });
});

/**
 * POST /api/seats/:id/cancel — Voluntarily cancel a held seat booking (no penalty).
 */
router.post('/:id/cancel', requireAuth, seatWriteRateLimit, (req, res) => {
  const seatId = positiveInteger(req.params.id);
  const studentId = req.userId;

  if (!seatId) {
    return res.status(400).json({ error: 'Invalid seat ID' });
  }

  const result = db.prepare(`
    UPDATE seats
    SET status = 'available', held_by = NULL, held_at = NULL, hold_expires_at = NULL
    WHERE id = ? AND status = 'held' AND held_by = ?
  `).run(seatId, studentId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'No active booking found for this seat' });
  }

  emitSeatUpdate();

  res.json({ message: 'Booking cancelled successfully' });
});

module.exports = router;