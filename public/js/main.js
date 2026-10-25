// Shared across every page: nav highlighting, secret "o p p" admin login trigger,
// and the admin status bar.

function highlightActiveNav() {
  const path = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-pill').forEach((link) => {
    const href = link.getAttribute('href');
    if (href === path || (path === '' && href === 'index.html')) {
      link.classList.add('active');
    }
  });
}

function setupNavToggle() {
  const header = document.querySelector('.site-header');
  const toggle = header && header.querySelector('.nav-toggle');
  if (!toggle) return;
  header.classList.add('nav-ready');

  const setOpen = (open) => {
    header.classList.toggle('nav-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
  };

  toggle.addEventListener('click', () => setOpen(!header.classList.contains('nav-open')));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && header.classList.contains('nav-open')) {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (!header.contains(e.target)) setOpen(false);
  });
}

function renderLoginEntry() {
  if (document.querySelector('.site-footer')) return;
  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.innerHTML = '<button type="button" class="footer-login">Admin sign-in</button>';
  document.body.appendChild(footer);
  footer.querySelector('.footer-login').addEventListener('click', () => {
    if (!document.querySelector('.modal-overlay')) buildLoginModal();
  });
}

async function getAdminSession() {
  const res = await fetch('/api/admin/session');
  return res.json();
}

function buildLoginModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const opener = document.activeElement;
  overlay.innerHTML = `
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="admin-login-title">
      <h3 id="admin-login-title">Admin Login</h3>
      <form id="admin-login-form">
        <div class="field">
          <label for="admin-username">Username</label>
          <input id="admin-username" name="username" type="text" autocomplete="username" required />
        </div>
        <div class="field">
          <label for="admin-password">Password</label>
          <input id="admin-password" name="password" type="password" autocomplete="current-password" required />
        </div>
        <div class="modal-error" id="admin-login-error" role="alert"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" id="admin-login-cancel">Cancel</button>
          <button type="submit" class="btn">Sign In</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (opener && opener.focus) opener.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  overlay.querySelector('#admin-login-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  // With the on-screen keyboard open, keep the focused field in view.
  overlay.querySelectorAll('input').forEach((input) => {
    input.addEventListener('focus', () => {
      setTimeout(() => input.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
    });
  });

  overlay.querySelector('#admin-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = overlay.querySelector('#admin-username').value;
    const password = overlay.querySelector('#admin-password').value;
    const errorEl = overlay.querySelector('#admin-login-error');
    errorEl.textContent = '';
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        errorEl.textContent = data.error || 'Login failed.';
        return;
      }
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      window.location.reload();
    } catch (err) {
      errorEl.textContent = 'Something went wrong.';
    }
  });

  overlay.querySelector('#admin-username').focus();
}

function setupSecretLoginTrigger() {
  const sequence = ['o', 'p', 'p'];
  let buffer = [];
  let lastKeyTime = 0;
  const MAX_GAP_MS = 600;

  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    const now = Date.now();
    if (now - lastKeyTime > MAX_GAP_MS) buffer = [];
    lastKeyTime = now;

    const key = e.key.toLowerCase();
    buffer.push(key);
    if (buffer.length > sequence.length) buffer.shift();

    if (buffer.join('') === sequence.join('')) {
      buffer = [];
      if (!document.querySelector('.modal-overlay')) buildLoginModal();
    }
  });
}

function renderAdminBar() {
  if (document.querySelector('.admin-bar')) return;
  const bar = document.createElement('div');
  bar.className = 'admin-bar';
  bar.innerHTML = `<span>Admin mode</span><button id="admin-logout-btn">Log out</button>`;
  document.body.appendChild(bar);
  bar.querySelector('#admin-logout-btn').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    window.location.reload();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  highlightActiveNav();
  setupNavToggle();
  setupSecretLoginTrigger();
  const session = await getAdminSession().catch(() => ({ isAdmin: false }));
  if (!session.isAdmin) renderLoginEntry();
  if (session.isAdmin) {
    document.querySelector('.site-footer')?.remove();
    renderAdminBar();
    document.body.classList.add('is-admin');
    document.dispatchEvent(new CustomEvent('admin-ready', { detail: { username: session.username } }));
  }
});
