/**
 * Lightweight toast notification module.
 *
 * Add <div id="toast-root"></div> to every page (inserted before scripts).
 * Usage: Toast.showToast('Saved', 'success', 3000)
 */

const TOAST_ROOT_ID = 'toast-root';

function ensureRoot() {
  let root = document.getElementById(TOAST_ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = TOAST_ROOT_ID;
    root.setAttribute('aria-live', 'polite');
    root.setAttribute('role', 'status');
    root.style.cssText = 'position:fixed;top:1rem;right:1rem;z-index:9999;display:flex;flex-direction:column;gap:0.5rem;pointer-events:none;';
    document.body.appendChild(root);
  }
  return root;
}

function showToast(message, type = 'info', duration = 3500) {
  const root = ensureRoot();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  root.appendChild(toast);

  // Trigger reflow for entrance animation
  void toast.offsetWidth;
  toast.classList.add('toast-visible');

  setTimeout(() => {
    toast.classList.remove('toast-visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 400);
  }, duration);
}

window.Toast = { showToast };
