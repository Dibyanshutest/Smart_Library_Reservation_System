/**
 * Entry / QR scanning routes.
 *
 * Toggle logic:
 * - held seat → check in (seat becomes occupied)
 * - occupied seat → check out (seat becomes available)
 * - otherwise → no active booking
 */
const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const {
  requireAuth,
  rateLimit
} = require('../middleware');
const { emitSeatUpdate } = require('../sockets');

const router = express.Router();

/**
 * GET /api/entry/qr — Fetch the current student's QR image/token.
 */
router.get('/qr', requireAuth, async (req, res) => {
  const student = db.prepare('SELECT qr_token FROM students WHERE id = ?').get(req.userId);
  if (!student) {
    return res.status(404).json({ error: 'Student not found' });
  }

  const qrDataUrl = await QRCode.toDataURL(student.qr_token, { margin: 1, width: 256 });
  res.json({ qrDataUrl });
});

/**
 * POST /api/entry/scan — Check-in/check-out toggle via QR token or library ID.
 * Rate-limited to prevent brute-force QR scanning.
 */
router.post('/scan', requireAuth, rateLimit({ windowMs: 60000, max: 20 }), (req, res) => {
  const qrToken = typeof req.body.qrToken === 'string' ? req.body.qrToken.trim() : '';
  const libraryId = typeof req.body.libraryId === 'string' ? req.body.libraryId.trim() : '';

  if (!qrToken && !libraryId) {
    return res.status(400).json({ error: 'QR token or library ID is required' });
  }

  const student = qrToken
    ? db.prepare('SELECT * FROM students WHERE qr_token = ?').get(qrToken)
    : db.prepare('SELECT * FROM students WHERE library_id = ?').get(libraryId);

  if (!student) {
    return res.status(404).json({ error: 'Invalid QR code' });
  }

  if (req.role === 'student' && student.id !== req.userId) {
    return res.status(403).json({ error: 'This QR code belongs to another student' });
  }

  // Check for active held seat (check-in)
  const heldSeat = db.prepare(`
    SELECT * FROM seats
    WHERE held_by = ? AND status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at > datetime('now')
  `).get(student.id);

  if (heldSeat) {
    db.prepare(`
      UPDATE seats
      SET status = 'occupied', held_by = NULL, held_at = NULL, hold_expires_at = NULL,
          occupied_by = ?, occupied_since = CURRENT_TIMESTAMP
      WHERE id = ? AND held_by = ? AND status = 'held'
    `).run(student.id, heldSeat.id, student.id);

    db.prepare(`
      INSERT INTO entry_logs (student_id, seat_id, booked_at, check_in_at, status)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, 'active')
    `).run(student.id, heldSeat.id, heldSeat.held_at);

    emitSeatUpdate();

    res.json({
      message: `Welcome, seat ${heldSeat.seat_label} confirmed`,
      action: 'checkin',
      seatLabel: heldSeat.seat_label
    });
    return;
  }

  // Check for occupied seat (check-out)
  const occupiedSeat = db.prepare(`
    SELECT * FROM seats WHERE occupied_by = ? AND status = 'occupied'
  `).get(student.id);

  if (occupiedSeat) {
    db.prepare(`
      UPDATE seats
      SET status = 'available', occupied_by = NULL, occupied_since = NULL,
          held_by = NULL, held_at = NULL, hold_expires_at = NULL
      WHERE id = ? AND occupied_by = ? AND status = 'occupied'
    `).run(occupiedSeat.id, student.id);

    db.prepare(`
      UPDATE entry_logs
      SET check_out_at = CURRENT_TIMESTAMP, status = 'completed'
      WHERE student_id = ? AND seat_id = ? AND status = 'active'
    `).run(student.id, occupiedSeat.id);

    emitSeatUpdate();

    res.json({
      message: 'Goodbye, seat released',
      action: 'checkout'
    });
    return;
  }

  // Expired booking check
  const expiredSeat = db.prepare(`
    SELECT * FROM seats WHERE held_by = ? AND status = 'held'
      AND hold_expires_at <= CURRENT_TIMESTAMP
  `).get(student.id);

  if (expiredSeat) {
    res.status(409).json({
      error: 'Booking expired, please book a new seat',
      action: 'expired'
    });
    return;
  }

  res.status(400).json({
    error: 'No active booking found, please book a seat first',
    action: 'none'
  });
});

module.exports = router;