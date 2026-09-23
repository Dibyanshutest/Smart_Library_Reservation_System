/**
 * Shared API client with consistent error handling and toast integration.
 *
 * Loads after auth.js (or standalone). Token helpers live here so all pages
 * share a single source of truth; Auth.js functions are re-exported for
 * backward compatibility with existing inline scripts.
 */

const API_BASE = '';

function getAuthToken() {
  try {
    return localStorage.getItem('token') || window.__authToken || null;
  } catch (error) {
    return window.__authToken || null;
  }
}

function setAuthToken(token) {
  try {
    if (token) localStorage.setItem('token', token);
    else localStorage.removeItem('token');
  } catch (error) {
    window.__authToken = token || null;
  }
}

function isLoggedIn() {
  return !!getAuthToken();
}

function logout() {
  setAuthToken(null);
  window.location.href = '/login.html';
}

async function apiFetch(url, options = {}) {
  const token = getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(API_BASE + url, { ...options, headers });
  } catch (error) {
    showToast('Network error. Please try again.', 'error');
    return null;
  }

  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = {};
  }

  if (!response.ok) {
    const message = data.error || data.message || 'Request failed';
    if (response.status === 401) {
      setAuthToken(null);
      window.location.href = '/login.html';
      return null;
    }
    showToast(message, 'error');
    return { ok: false, response, data };
  }

  return { ok: true, response, data };
}

/**
 * Convenient wrapper that returns the parsed JSON body or null on error.
 */
async function request(url, options = {}) {
  const result = await apiFetch(url, options);
  if (!result) return null;
  if (!result.ok) return result.data;
  return result.data;
}

function showToast(message, type = 'info', duration = 3500) {
  if (window.Toast && typeof window.Toast.showToast === 'function') {
    window.Toast.showToast(message, type, duration);
    return;
  }
  // Fallback if the toast module hasn't loaded yet.
  const root = document.getElementById('toast-root');
  if (root && typeof message === 'string') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    root.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  }
}

window.Api = {
  apiFetch,
  request,
  setAuthToken,
  getAuthToken,
  isLoggedIn,
  logout,
  showToast
};

// Keep Auth.js API surface intact for existing inline scripts.
if (window.Auth) {
  window.Auth.setToken = setAuthToken;
  window.Auth.getToken = getAuthToken;
  window.Auth.isLoggedIn = isLoggedIn;
  window.Auth.logout = logout;
  window.Auth.authFetch = apiFetch;
}
