/**
 * Shared authentication helpers for Smart Library System.
 * Handles login, registration, token storage, and session state.
 */

const API_BASE = '';

/**
 * Store a JWT token in memory and localStorage for persistence.
 */
function setToken(token) {
  try {
    localStorage.setItem('token', token);
  } catch (e) {
    // localStorage may be unavailable in some environments
    window.__authToken = token;
  }
}

/**
 * Retrieve the stored JWT token.
 */
function getToken() {
  try {
    return localStorage.getItem('token') || window.__authToken;
  } catch (e) {
    return window.__authToken;
  }
}

/**
 * Clear the stored token and redirect to login.
 */
function logout() {
  try {
    localStorage.removeItem('token');
  } catch (e) {
    window.__authToken = null;
  }
  window.__authToken = null;
  window.location.href = '/login.html';
}

/**
 * Check if a user is currently authenticated.
 */
function isLoggedIn() {
  return !!getToken();
}

/**
 * Get the current user's role from the token (if parsed).
 */
function getUserRole() {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.role;
  } catch (e) {
    return null;
  }
}

/**
 * Get the current user's ID from the token.
 */
function getUserId() {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.userId;
  } catch (e) {
    return null;
  }
}

/**
 * Display a form message (error or success).
 */
function showFormMessage(containerId, message, type) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.className = `form-message ${type}`;
  container.textContent = message;
  container.style.display = 'block';
  // Auto-hide after 5 seconds
  setTimeout(() => {
    container.style.display = 'none';
  }, 5000);
}

/**
 * Make an authenticated API request.
 */
async function authFetch(url, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers
  });

  if (response.status === 401) {
    logout();
    return null;
  }

  return response;
}

/**
 * Initialize the auth state on page load.
 * If already logged in, redirect to dashboard.
 */
function initAuthState() {
  if (isLoggedIn()) {
    const role = getUserRole();
    if (role === 'admin' || role === 'librarian') {
      window.location.href = '/admin.html';
    } else {
      window.location.href = '/dashboard.html';
    }
  }
}

// Export for use in other modules
window.Auth = {
  setToken,
  getToken,
  logout,
  isLoggedIn,
  getUserRole,
  getUserId,
  showFormMessage,
  authFetch,
  initAuthState
};
