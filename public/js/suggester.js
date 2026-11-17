// Drives movie-suggester.html: scores the tagged movies on a contributor's
// "List of Movies Watched" against the visitor's preferences (see
// MovieProfile.rankMovies in movie-profile.js) and shows the best match.

const MP = window.MovieProfile;
const SUGGEST_AUTHORS = [
  { key: 'andrew', label: 'Andrew' },
  { key: 'ethan', label: 'Ethan' },
];
const TRAIT_LABELS = {
  genre: 'Genre',
  mood: 'Mood',
  length: 'Length',
  beauty: 'Beauty style',
  cortisol: 'Cortisol',
  lasting: 'Lasting effect',
};

let suggestAuthor = 'andrew';
let movies = [];
let ranked = [];
let shownIndex = 0;
let moviesLoading = Promise.resolve();

function esc(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function fillSelect(id, options) {
  const el = document.getElementById(id);
  el.innerHTML = '<option value="">Any</option>' + options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
}

function readPrefs() {
  const form = document.getElementById('suggest-form');
  const scale = (name) => (form[`${name}-any`].checked ? null : Number(form[name].value));
  return {
    genre: form.genre.value || null,
    mood: form.mood.value || null,
    length: form.length.value || null,
    lasting: form.lasting.value ? Number(form.lasting.value) : null,
    beauty: scale('beauty'),
    cortisol: scale('cortisol'),
  };
}

function describeScale(n, ends) {
  if (n <= 3) return `leans ${ends[0].toLowerCase()} (${n}/10)`;
  if (n >= 8) return `leans ${ends[1].toLowerCase()} (${n}/10)`;
  return `in between (${n}/10)`;
}

function renderTags(p) {
  return [
    ...p.genres,
    ...p.moods,
    MP.lengthLabelFor(p.runtime),
    `Beauty ${p.beauty}/10`,
    `Cortisol ${p.cortisol}/10`,
    `Sticks ${MP.lastingLabel(p.lasting).toLowerCase()}`,
  ]
    .map((t) => `<span class="tag">${esc(t)}</span>`)
    .join('');
}

// Short "why this one" notes from the per-trait fits.
function renderReasons(result) {
  const p = result.movie.profile;
  const detail = {
    genre: p.genres.join(', '),
    mood: p.moods.join(', '),
    length: MP.lengthLabelFor(p.runtime),
    beauty: describeScale(p.beauty, MP.BEAUTY_ENDS),
    cortisol: describeScale(p.cortisol, MP.CORTISOL_ENDS),
    lasting: MP.lastingLabel(p.lasting).toLowerCase(),
  };
  if (!result.parts.length) return '<p class="suggest-note">No preferences set, so this is simply the top-rated tagged movie.</p>';
  return `<ul class="fit-list">${result.parts
    .map((part) => {
      const pct = Math.round(part.fit * 100);
      const cls = pct >= 80 ? 'good' : pct >= 40 ? 'ok' : 'off';
      return `<li class="fit ${cls}"><span class="fit-trait">${TRAIT_LABELS[part.trait]}</span><span class="fit-bar"><span style="width:${pct}%"></span></span><span class="fit-detail">${esc(detail[part.trait])}</span></li>`;
    })
    .join('')}</ul>`;
}

function untaggedNote() {
  const untagged = movies.filter((m) => !m.profile).length;
  if (!untagged) return '';
  return `<p class="suggest-note">${untagged} movie${untagged === 1 ? '' : 's'} on this list ${untagged === 1 ? "isn't" : "aren't"} tagged yet, so ${untagged === 1 ? "it's" : "they're"} not in the running.</p>`;
}

function renderResult() {
  const el = document.getElementById('suggest-result');
  if (!ranked.length) {
    el.innerHTML = `<div class="suggest-card"><p class="empty-state">No tagged movies on this list yet.</p>${untaggedNote()}</div>`;
    return;
  }
  const top = ranked[shownIndex];
  const runnersUp = ranked.filter((_, i) => i !== shownIndex).slice(0, 4);
  el.innerHTML = `
    <div class="suggest-card">
      <p class="suggest-kicker">${shownIndex === 0 ? 'Best match' : `Pick #${shownIndex + 1}`}</p>
      <h2 class="suggest-title">${esc(top.movie.title)}</h2>
      <p class="suggest-score"><strong>${Math.round(top.match * 100)}% match</strong> · rated ${esc(top.movie.rating)} / 1000</p>
      <div class="tag-row">${renderTags(top.movie.profile)}</div>
      ${renderReasons(top)}
      ${ranked.length > 1 ? '<button type="button" class="btn btn-secondary" id="suggest-another">Suggest another</button>' : ''}
      ${
        runnersUp.length
          ? `<h3 class="runners-heading">Also worth a look</h3><ol class="runners">${runnersUp
              .map((r) => `<li><span class="rank-title">${esc(r.movie.title)}</span><span class="runner-match">${Math.round(r.match * 100)}%</span></li>`)
              .join('')}</ol>`
          : ''
      }
      ${untaggedNote()}
    </div>
  `;
  const again = document.getElementById('suggest-another');
  if (again) {
    again.addEventListener('click', () => {
      shownIndex = (shownIndex + 1) % ranked.length;
      renderResult();
    });
  }
}

function suggest() {
  ranked = MP.rankMovies(readPrefs(), movies);
  shownIndex = 0;
  renderResult();
}

async function loadMovies() {
  try {
    const res = await fetch(`/api/rankings?type=movie&author=${suggestAuthor}`);
    movies = res.ok ? await res.json() : [];
  } catch {
    movies = [];
  }
}

function renderSuggestAuthorTabs() {
  const tabsEl = document.getElementById('author-tabs');
  tabsEl.innerHTML =
    '<span class="tabs-label">Whose list</span>' +
    SUGGEST_AUTHORS.map(
      (a) => `<button type="button" class="author-tab${a.key === suggestAuthor ? ' active' : ''}" data-author="${a.key}">${a.label}</button>`
    ).join('');
  tabsEl.querySelectorAll('.author-tab').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.author === suggestAuthor) return;
      suggestAuthor = btn.dataset.author;
      tabsEl.querySelectorAll('.author-tab').forEach((b) => b.classList.toggle('active', b === btn));
      moviesLoading = loadMovies();
      await moviesLoading;
      if (document.getElementById('suggest-result').innerHTML.trim()) suggest();
    });
  });
}

function setupForm() {
  fillSelect('pref-genre', MP.GENRES.map((g) => ({ value: g, label: g })));
  fillSelect('pref-mood', MP.MOODS.map((m) => ({ value: m, label: m })));
  fillSelect('pref-length', MP.LENGTHS.map((l) => ({ value: l.key, label: l.label })));
  fillSelect('pref-lasting', MP.LASTING.map((l) => ({ value: l.days, label: l.label })));

  document.querySelectorAll('.scale-field').forEach((field) => {
    const name = field.dataset.scale;
    const range = field.querySelector('input[type="range"]');
    const out = field.querySelector('output');
    const any = field.querySelector(`input[name="${name}-any"]`);
    range.addEventListener('input', () => (out.textContent = range.value));
    any.addEventListener('change', () => {
      range.disabled = any.checked;
      field.classList.toggle('is-any', any.checked);
    });
  });

  document.getElementById('suggest-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await moviesLoading;
    suggest();
    document.getElementById('suggest-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setupForm();
  renderSuggestAuthorTabs();
  moviesLoading = loadMovies();
});
