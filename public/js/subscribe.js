// Drives mailing-list.html.

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

async function loadSubscriberList() {
  const listEl = document.getElementById('subscriber-list');
  if (!listEl) return;

  const res = await fetch('/api/admin/mailing-list');
  if (!res.ok) return;
  const subscribers = await res.json();

  if (subscribers.length === 0) {
    listEl.innerHTML = '<p class="empty-state">No subscribers yet.</p>';
    return;
  }

  listEl.innerHTML = subscribers
    .map(
      (s) => `
        <label class="subscriber-row" data-id="${s.id}">
          <input type="checkbox" class="subscriber-toggle" ${s.excluded ? '' : 'checked'} />
          <span class="subscriber-email">${escapeHTML(s.email)}</span>
          <span class="subscriber-date">${formatDate(s.createdAt)}</span>
        </label>
      `
    )
    .join('');

  listEl.querySelectorAll('.subscriber-toggle').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const row = checkbox.closest('.subscriber-row');
      const id = row.dataset.id;
      checkbox.disabled = true;
      try {
        const toggleRes = await fetch(`/api/admin/mailing-list/${id}/toggle-exclude`, { method: 'POST' });
        if (!toggleRes.ok) {
          checkbox.checked = !checkbox.checked;
          return;
        }
        const data = await toggleRes.json();
        checkbox.checked = !data.excluded;
      } finally {
        checkbox.disabled = false;
      }
    });
  });
}

document.addEventListener('admin-ready', () => {
  const panel = document.getElementById('mailing-list-admin');
  if (!panel) return;
  panel.style.display = 'block';
  loadSubscriberList();
});

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('subscribe-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const email = form.elements.email.value.trim();
    const errorEl = document.getElementById('subscribe-error');
    const messageEl = document.getElementById('subscribe-message');
    errorEl.textContent = '';
    messageEl.textContent = '';

    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        errorEl.textContent = data.error || 'Something went wrong.';
        return;
      }
      messageEl.textContent = data.message || 'Subscribed!';
      form.reset();
    } catch (err) {
      errorEl.textContent = 'Something went wrong.';
    }
  });
});
