/**
 * Shared middleware and helpers for the Smart Library System.
 *
 * Kept in a separate module so both the Express app and the extracted
 * route modules can import them without creating a circular dependency.
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'smart-library-secret-key-change-in-production';

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be configured in production');
}

/**
 * Create a JWT session token.
 */
function createToken(userId, role) {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '12h' });
}

/**
 * Verify the Authorization: Bearer <token> header and attach the decoded
 * payload to the request object.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.role = decoded.role;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireStaff(req, res, next) {
  if (req.role !== 'admin' && req.role !== 'librarian') {
    return res.status(403).json({ error: 'Staff access required' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Parse a positive integer from a request value, falling back to `fallback`
 * when the value is missing or invalid.
 */
function positiveInteger(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * Parse a non-negative integer from a request value.
 */
function nonNegativeInteger(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

/**
 * Generic sliding-window rate limiter keyed by client IP.
 */
function rateLimit({ windowMs, max }) {
  const requests = new Map();
  return (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of requests) {
      if (now > value.expiresAt) requests.delete(key);
    }
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const current = requests.get(key) || { count: 0, expiresAt: 0 };

    if (now > current.expiresAt) {
      current.count = 0;
      current.expiresAt = now + windowMs;
    }

    current.count += 1;
    requests.set(key, current);

    if (current.count > max) {
      return res.status(429).json({ error: 'Too many requests, please try again later' });
    }

    next();
  };
}

module.exports = {
  JWT_SECRET,
  createToken,
  requireAuth,
  requireStaff,
  requireAdmin,
  positiveInteger,
  nonNegativeInteger,
  rateLimit
};