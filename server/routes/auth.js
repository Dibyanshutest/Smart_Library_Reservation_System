/**
 * Authentication routes: student register, student login, staff login.
 */
const express = require('express');
const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const crypto = require('crypto');
const db = require('../db');
const {
  createToken,
  requireAuth,
  rateLimit,
  positiveInteger
} = require('../middleware');
const { emitSeatUpdate } = require('../sockets');

const router = express.Router();

// Stricter rate limit for auth endpoints (5 req/min per IP)
const authRateLimit = rateLimit({ windowMs: 60000, max: 5 });

/**
 * POST /api/auth/register
 * Create a new student account, hash password, generate QR token & image.
 */
router.post('/register', authRateLimit, async (req, res) => {
  try {
    const { libraryId, name, email, password } = req.body;

    // Validate required fields
    if (!libraryId || !name || !password || String(password).length < 8) {
      return res.status(400).json({ error: 'Library ID, name, and password (min 8 chars) are required' });
    }
    if (email && !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }

    // Check if library ID already exists
    const existing = db.prepare('SELECT * FROM students WHERE library_id = ?').get(libraryId);
    if (existing) {
      return res.status(409).json({ error: 'Library ID already registered' });
    }

    // Generate QR token (opaque, not guessable)
    const qrToken = crypto.randomBytes(32).toString('hex');

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert student
    const result = db.prepare(`
      INSERT INTO students (library_id, name, email, password_hash, qr_token)
      VALUES (?, ?, ?, ?, ?)
    `).run(libraryId, name, email || null, passwordHash, qrToken);

    // Generate QR code image
    const qrDataUrl = await QRCode.toDataURL(qrToken, { margin: 1, width: 256 });

    res.status(201).json({
      message: 'Registration successful',
      studentId: result.lastInsertRowid,
      qrDataUrl
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const field = error.message.includes('students.email') ? 'Email' : 'Library ID';
      return res.status(409).json({ error: `${field} already registered` });
    }
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * POST /api/auth/login
 * Student login with library ID + password → returns JWT.
 */
router.post('/login', authRateLimit, async (req, res) => {
  try {
    const { libraryId, password } = req.body;

    const student = db.prepare('SELECT * FROM students WHERE library_id = ?').get(libraryId);
    if (!student) {
      return res.status(401).json({ error: 'Invalid library ID or password' });
    }

    const passwordValid = await bcrypt.compare(password, student.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid library ID or password' });
    }

    const token = createToken(student.id, 'student');
    res.json({
      token,
      student: {
        id: student.id,
        libraryId: student.library_id,
        name: student.name,
        email: student.email
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * POST /api/auth/staff-login
 * Staff (librarian/admin) login with email + password → returns JWT.
 */
router.post('/staff-login', authRateLimit, async (req, res) => {
  try {
    const { email, password } = req.body;

    const staff = db.prepare('SELECT * FROM staff WHERE email = ?').get(email);
    if (!staff) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const passwordValid = await bcrypt.compare(password, staff.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = createToken(staff.id, staff.role);
    res.json({
      token,
      staff: {
        id: staff.id,
        name: staff.name,
        email: staff.email,
        role: staff.role
      }
    });
  } catch (error) {
    console.error('Staff login error:', error);
    res.status(500).json({ error: 'Staff login failed' });
  }
});

module.exports = router;