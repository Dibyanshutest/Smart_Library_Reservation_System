/**
 * Socket.IO initialization and real-time helpers.
 *
 * The Express app calls `initSocket(server)` once to create the Socket.IO
 * server and attach the connection handlers.  Route modules and background
 * jobs can then call `emitSeatUpdate()` or `emitPenaltyNotice()` to push
 * updates to connected clients.
 */

const socketIo = require('socket.io');
const db = require('./db');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./middleware');

let io = null;
const userSockets = new Map();

/**
 * Create and configure the Socket.IO server attached to an HTTP server.
 *
 * @param {http.Server} server - The HTTP server to attach to.
 * @param {string|boolean} [corsOrigin] - Origin allowed by CORS (default: true).
 * @returns {SocketIO.Server} The created Socket.IO server instance.
 */
function initSocket(server, corsOrigin) {
  io = socketIo(server, { cors: { origin: corsOrigin || true } });
  wireSocket();
  return io;
}

/**
 * Get the Socket.IO server instance (throws if not initialized).
 */
function getIo() {
  if (!io) throw new Error('Socket.IO not initialized; call initSocket first');
  return io;
}

/**
 * Broadcast the latest seat state to every connected client.
 * Used after any seat status change.
 */
function emitSeatUpdate() {
  if (!io) return;
  const seats = db.prepare('SELECT * FROM seats ORDER BY hall, pos_x, pos_y').all();
  io.emit('seat:update', { seats });
}

/**
 * Send a penalty notice to a specific student if they are currently
 * connected via Socket.IO.
 */
function emitPenaltyNotice(userId, message) {
  const socket = userSockets.get(userId);
  if (socket) {
    socket.emit('penalty:notice', { message });
  }
}

/**
 * Register a Socket.IO socket as belonging to a specific user ID.
 * Used on connection so we can send direct notifications.
 */
function registerUserSocket(userId, socket) {
  userSockets.set(userId, socket);
}

/**
 * Unregister a socket when it disconnects.
 */
function unregisterUserSocket(socket) {
  for (const [userId, sock] of userSockets.entries()) {
    if (sock === socket) {
      userSockets.delete(userId);
      break;
    }
  }
}

/**
 * Internal: attach Socket.IO middleware and event handlers.
 */
function wireSocket() {
  // Verify JWT on connection; attach decoded payload to socket.user
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(); // anonymous connections allowed
    try {
      socket.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch (error) {
      next(new Error('Invalid socket token'));
    }
  });

  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Send current seat state to new connections
    const seats = db.prepare('SELECT * FROM seats ORDER BY hall, pos_x, pos_y').all();
    socket.emit('seat:update', { seats });

    if (socket.user && socket.user.userId) {
      registerUserSocket(socket.user.userId, socket);
    }

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
      unregisterUserSocket(socket);
    });
  });
}

module.exports = {
  initSocket,
  getIo,
  emitSeatUpdate,
  emitPenaltyNotice
};