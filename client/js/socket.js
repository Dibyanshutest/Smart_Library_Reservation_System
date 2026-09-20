/**
 * Shared socket.io setup for Smart Library System.
 * Provides a simple startSocket() helper that connects to the server
 * and re-subscribes to seat:update events.
 */

let socket = null;
const seatUpdateCallbacks = [];
let pollingInterval = null;

function onSeatUpdate(callback) {
  seatUpdateCallbacks.push(callback);
}

function startSocket() {
  if (socket) return;
  socket = io({ auth: { token: Auth && Auth.getToken ? Auth.getToken() : null } });

  socket.on('connect', () => {
    console.log('Socket connected:', socket.id);
    stopPolling();
  });

  socket.on('seat:update', (data) => {
    seatUpdateCallbacks.forEach(cb => cb(data.seats));
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected');
    startPolling();
  });

  startPolling();
}

function startPolling() {
  if (pollingInterval) return;
  pollingInterval = setInterval(async () => {
    try {
      const response = await fetch('/api/seats');
      if (!response.ok) return;
      const data = await response.json();
      seatUpdateCallbacks.forEach(callback => callback(data.seats));
    } catch (error) {
      console.warn('Seat polling failed:', error);
    }
  }, 10000);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

function stopSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  stopPolling();
}

window.Socket = { startSocket, stopSocket, onSeatUpdate };
