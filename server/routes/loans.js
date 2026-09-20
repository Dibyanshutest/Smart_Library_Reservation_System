/**
 * Loan routes: borrow and return books.
 */
const express = require('express');
const db = require('../db');
const {
  requireAuth,
  positiveInteger
} = require('../middleware');

const router = express.Router();

/**
 * POST /api/loans — Borrow a book.
 */
router.post('/', requireAuth, (req, res) => {
  const { bookId } = req.body;
  const studentId = req.userId;

  if (!positiveInteger(bookId)) {
    return res.status(400).json({ error: 'A valid book ID is required' });
  }

  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  if (book.available_copies <= 0) {
    return res.status(409).json({ error: 'No copies available' });
  }

  const activeLoan = db.prepare(`
    SELECT * FROM loans WHERE book_id = ? AND student_id = ? AND returned_at IS NULL
  `).get(bookId, studentId);
  if (activeLoan) {
    return res.status(409).json({ error: 'You already have this book borrowed' });
  }

  const loanPeriodDays = Number(db.prepare("SELECT value FROM settings WHERE key = 'loan_period_days'").get().value);
  const dueDate = new Date(Date.now() + loanPeriodDays * 24 * 60 * 60 * 1000);

  const result = db.prepare(`
    INSERT INTO loans (book_id, student_id, due_at) VALUES (?, ?, ?)
  `).run(bookId, studentId, dueDate.toISOString());

  db.prepare('UPDATE books SET available_copies = available_copies - 1 WHERE id = ?').run(bookId);

  res.status(201).json({
    message: 'Book borrowed successfully',
    loanId: result.lastInsertRowid,
    dueDate: dueDate.toISOString()
  });
});

/**
 * POST /api/loans/:id/return — Return a book (calculates fine if late).
 */
router.post('/:id/return', requireAuth, (req, res) => {
  const loanId = positiveInteger(req.params.id);
  if (!loanId) return res.status(400).json({ error: 'Invalid loan ID' });

  const loan = db.prepare(`
    SELECT loans.*, books.title, students.name AS student_name
    FROM loans JOIN books ON loans.book_id = books.id
    JOIN students ON loans.student_id = students.id
    WHERE loans.id = ?
  `).get(loanId);

  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (loan.returned_at) return res.status(409).json({ error: 'Book already returned' });
  if (req.role === 'student' && loan.student_id !== req.userId) {
    return res.status(403).json({ error: 'You can only return your own books' });
  }

  const now = new Date();
  const dueDate = new Date(loan.due_at);
  const finePerDay = Number(db.prepare("SELECT value FROM settings WHERE key = 'overdue_fine_per_day'").get().value);

  let fine = 0;
  if (now > dueDate) {
    const daysLate = Math.ceil((now - dueDate) / (24 * 60 * 60 * 1000));
    fine = daysLate * finePerDay;
  }

  db.transaction(() => {
    db.prepare('UPDATE loans SET returned_at = ?, fine_charged = ? WHERE id = ?')
      .run(now.toISOString(), fine, loanId);
    db.prepare('UPDATE books SET available_copies = available_copies + 1 WHERE id = ?')
      .run(loan.book_id);
    if (fine > 0) {
      db.prepare('UPDATE students SET fine_balance = fine_balance + ? WHERE id = ?')
        .run(fine, loan.student_id);
    }
  })();

  res.json({ message: 'Book returned successfully', fineCharged: fine });
});

module.exports = router;