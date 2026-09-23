/**
 * Expire stale seat holds on a server-side interval.
 *
 * This job must run on the server, not in the browser, so bookings are
 * released even when nobody has the seat map open.
 */

const { getIo } = require('../sockets');
const db = require('../db');

function getSetting(key) {
  const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return setting ? Number(setting.value) : null;
}

function expireHolds() {
  const expiredSeats = db.prepare(`
    SELECT id, seat_label, held_by AS studentId
    FROM seats
    WHERE status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= datetime('now')
  `).all();

  if (expiredSeats.length === 0) return 0;

  const strikesBeforeCooldown = getSetting('strikes_before_cooldown') || 3;
  const cooldownHours = getSetting('cooldown_hours') || 48;
  const noShowFine = getSetting('no_show_fine') || 0;

  const expireSeat = db.transaction((seat) => {
    // Release the seat.
    const seatUpdate = db.prepare(`
      UPDATE seats
      SET status = 'available',
          held_by = NULL,
          held_at = NULL,
          hold_expires_at = NULL
      WHERE id = ?
    `);

    // Record the penalty and apply its consequences.
    const penaltyInsert = db.prepare(`
      INSERT INTO penalties (student_id, reason)
      VALUES (?, 'no_show')
    `);

    const studentUpdate = db.prepare(`
      UPDATE students
      SET strikes = strikes + 1,
          fine_balance = fine_balance + ?,
          cooldown_until = CASE
            WHEN strikes + 1 >= ? THEN datetime('now', '+' || ? || ' hours')
            ELSE cooldown_until
          END
      WHERE id = ?
    `);

    const entryLogUpdate = db.prepare(`
      UPDATE entry_logs
      SET status = 'no_show'
      WHERE student_id = ?
        AND seat_id = ?
        AND status = 'active'
    `);

    seatUpdate.run(seat.id);
    penaltyInsert.run(seat.studentId);
    studentUpdate.run(noShowFine, strikesBeforeCooldown, cooldownHours, seat.studentId);
    entryLogUpdate.run(seat.studentId, seat.id);
  });

  expiredSeats.forEach(expireSeat);

  // Notify every connected client that the seat states changed.
  try {
    const io = getIo();
    const seats = db.prepare('SELECT * FROM seats ORDER BY hall, pos_x, pos_y').all();
    io.emit('seat:update', { seats });
  } catch (error) {
    // Socket.IO not initialized yet; emitSeatUpdate will be called when it is.
  }

  console.log(`Expired ${expiredSeats.length} seat hold(s)`);
  return expiredSeats.length;
}

function startExpireHoldsJob(intervalMs = 30000) {
  // Run once immediately in case any holds expired while the server was down.
  expireHolds();

  return setInterval(() => {
    try {
      expireHolds();
    } catch (error) {
      console.error('Seat expiry job failed:', error);
    }
  }, intervalMs);
}

module.exports = {
  expireHolds,
  startExpireHoldsJob
};