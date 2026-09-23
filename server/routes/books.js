/**
 * Book catalog and loan routes.
 *
 * Book CRUD is staff-only (librarian or admin).
 * Borrow/return is student-authenticated (or staff).
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

const router = express.Router();
const booksRouteRateLimit = rateLimit({ windowMs: 60 * 1000, max: 30 });

router.use(booksRouteRateLimit);

/**
 * GET /api/books — List/search/filter catalog.
 * Accessible to all authenticated users and guests (read-only).
 */
router.get('/', (req, res) => {
  const { search, category, availability } = req.query;

  if (search !== undefined && typeof search !== 'string') {
    return res.status(400).json({ error: 'Search query must be a string' });
  }
  if (category !== undefined && typeof category !== 'string') {
    return res.status(400).json({ error: 'Category filter must be a string' });
  }
  if (availability !== undefined && typeof availability !== 'string') {
    return res.status(400).json({ error: 'Availability filter must be a string' });
  }

  // Input length validation to prevent pathological LIKE patterns
  if (search && search.length > 200) {
    return res.status(400).json({ error: 'Search query too long (max 200 characters)' });
  }
  if (category && category.length > 100) {
    return res.status(400).json({ error: 'Category filter too long (max 100 characters)' });
  }

  let query = 'SELECT * FROM books WHERE 1=1';
  const params = [];

  if (search) {
    query += ' AND (title LIKE ? OR author LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }

  if (availability === 'available') {
    query += ' AND available_copies > 0';
  } else if (availability === 'unavailable') {
    query += ' AND available_copies = 0';
  }

  query += ' ORDER BY title ASC';

  const books = db.prepare(query).all(...params);
  res.json({ books });
});

/**
 * GET /api/books/:id — Book detail.
 */
router.get('/:id', (req, res) => {
  const bookId = positiveInteger(req.params.id);
  if (!bookId) {
    return res.status(400).json({ error: 'Invalid book ID' });
  }

  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
  if (!book) {
    return res.status(404).json({ error: 'Book not found' });
  }
  res.json({ book });
});

/**
 * POST /api/books — Add a book (staff only).
 */
router.post('/', requireAuth, requireStaff, (req, res) => {
  const { title, author, isbn, category, coverUrl, totalCopies, availableCopies, shelfLocation } = req.body;
  const total = positiveInteger(totalCopies, 1);
  const available = nonNegativeInteger(availableCopies, total);
  if (!title || !total || available === null || available > total) {
    return res.status(400).json({ error: 'Title and valid copy counts are required' });
  }

  const result = db.prepare(`
    INSERT INTO books (title, author, isbn, category, cover_url, total_copies, available_copies, shelf_location)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    title,
    author || null,
    isbn || null,
    category || null,
    coverUrl || null,
    total,
    available,
    shelfLocation || null
  );

  res.status(201).json({
    message: 'Book added successfully',
    bookId: result.lastInsertRowid
  });
});

/**
 * PUT /api/books/:id — Edit a book (staff only).
 */
router.put('/:id', requireAuth, requireStaff, (req, res) => {
  const bookId = positiveInteger(req.params.id);
  if (!bookId) return res.status(400).json({ error: 'Invalid book ID' });

  const existing = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
  if (!existing) {
    return res.status(404).json({ error: 'Book not found' });
  }

  const { title, author, isbn, category, coverUrl, totalCopies, availableCopies, shelfLocation } = req.body;
  const total = totalCopies === undefined ? existing.total_copies : positiveInteger(totalCopies);
  const available = availableCopies === undefined ? existing.available_copies : nonNegativeInteger(availableCopies);
  if (!total || available === null || available > total) {
    return res.status(400).json({ error: 'Invalid copy counts' });
  }

  db.prepare(`
    UPDATE books
    SET title = COALESCE(?, title),
        author = COALESCE(?, author),
        isbn = COALESCE(?, isbn),
        category = COALESCE(?, category),
        cover_url = COALESCE(?, cover_url),
        total_copies = COALESCE(?, total_copies),
        available_copies = COALESCE(?, available_copies),
        shelf_location = COALESCE(?, shelf_location)
    WHERE id = ?
  `).run(
    title ?? existing.title,
    author ?? existing.author,
    isbn ?? existing.isbn,
    category ?? existing.category,
    coverUrl ?? existing.cover_url,
    total,
    available,
    shelfLocation ?? existing.shelf_location,
    bookId
  );

  res.json({ message: 'Book updated successfully' });
});

/**
 * DELETE /api/books/:id — Remove a book (staff only).
 */
router.delete('/:id', requireAuth, requireStaff, (req, res) => {
  const bookId = positiveInteger(req.params.id);
  if (!bookId) return res.status(400).json({ error: 'Invalid book ID' });

  const deleted = db.prepare('DELETE FROM books WHERE id = ?').run(bookId);
  if (deleted.changes === 0) {
    return res.status(404).json({ error: 'Book not found' });
  }

  res.json({ message: 'Book deleted successfully' });
});

// ============================================
// LOANS
// ============================================

/**
 * POST /api/loans — Borrow a book.
 * Requires authentication (student or staff).
 */
router.post('/', requireAuth, (req, res) => {
  const { bookId } = req.body;
  const studentId = req.userId;

  if (!positiveInteger(bookId)) {
    return res.status(400).json({ error: 'A valid book ID is required' });
  }

  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
  if (!book) {
    return res.status(404).json({ error: 'Book not found' });
  }

  if (book.available_copies <= 0) {
    return res.status(409).json({ error: 'No copies available' });
  }

  // Check if student already has this book
  const activeLoan = db.prepare(`
    SELECT * FROM loans WHERE book_id = ? AND student_id = ? AND returned_at IS NULL
  `).get(bookId, studentId);

  if (activeLoan) {
    return res.status(409).json({ error: 'You already have this book borrowed' });
  }

  const loanPeriodDays = Number(db.prepare("SELECT value FROM settings WHERE key = 'loan_period_days'").get().value);
  const dueDate = new Date(Date.now() + loanPeriodDays * 24 * 60 * 60 * 1000);

  const result = db.prepare(`
    INSERT INTO loans (book_id, student_id, due_at)
    VALUES (?, ?, ?)
  `).run(bookId, studentId, dueDate.toISOString());

  db.prepare('UPDATE books SET available_copies = available_copies - 1 WHERE id = ?').run(bookId);

  res.status(201).json({
    message: 'Book borrowed successfully',
    loanId: result.lastInsertRowid,
    dueDate: dueDate.toISOString()
  });
});

/**
 * POST /api/loans/:id/return — Return a book.
 * Calculates fine if late.
 */
router.post('/:id/return', requireAuth, (req, res) => {
  const loanId = positiveInteger(req.params.id);
  if (!loanId) return res.status(400).json({ error: 'Invalid loan ID' });

  const loan = db.prepare(`
    SELECT loans.*, books.title, students.name AS student_name
    FROM loans
    JOIN books ON loans.book_id = books.id
    JOIN students ON loans.student_id = students.id
    WHERE loans.id = ?
  `).get(loanId);

  if (!loan) {
    return res.status(404).json({ error: 'Loan not found' });
  }

  if (loan.returned_at) {
    return res.status(409).json({ error: 'Book already returned' });
  }

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
    db.prepare(`UPDATE loans SET returned_at = ?, fine_charged = ? WHERE id = ?`)
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