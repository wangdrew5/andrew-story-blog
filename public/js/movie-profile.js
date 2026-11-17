// Shared by the browser (movie suggester + movie ranking tagging) and by
// server.js (validation), so the trait vocabulary and the matching algorithm
// live in exactly one place.

(function (root) {
  const GENRES = [
    'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama',
    'Fantasy', 'Horror', 'Musical', 'Mystery', 'Romance', 'Sci-Fi', 'Thriller', 'War', 'Western',
  ];

  const MOODS = [
    'Uplifting', 'Funny', 'Heartwarming', 'Romantic', 'Whimsical', 'Thought-provoking',
    'Melancholy', 'Tense', 'Dark', 'Epic',
  ];

  // Moods that sit next to each other emotionally get partial credit, so asking
  // for "Heartwarming" can still surface an "Uplifting" movie.
  const MOOD_NEIGHBORS = {
    Uplifting: ['Heartwarming', 'Funny', 'Epic'],
    Funny: ['Uplifting', 'Whimsical'],
    Heartwarming: ['Uplifting', 'Romantic'],
    Romantic: ['Heartwarming', 'Melancholy'],
    Whimsical: ['Funny', 'Uplifting'],
    'Thought-provoking': ['Melancholy', 'Dark'],
    Melancholy: ['Thought-provoking', 'Romantic', 'Dark'],
    Tense: ['Dark', 'Epic'],
    Dark: ['Tense', 'Melancholy', 'Thought-provoking'],
    Epic: ['Tense', 'Uplifting'],
  };

  const LENGTHS = [
    { key: 'short', label: 'Short (under 100 min)', min: 0, max: 99 },
    { key: 'medium', label: 'Medium (100–129 min)', min: 100, max: 129 },
    { key: 'long', label: 'Long (130–159 min)', min: 130, max: 159 },
    { key: 'epic', label: 'Epic (160+ min)', min: 160, max: Infinity },
  ];

  // How long the movie sticks with you, in days.
  const LASTING = [
    { days: 1, label: '1 day' },
    { days: 3, label: '3 days' },
    { days: 10, label: '10 days' },
    { days: 30, label: '30 days' },
    { days: 365, label: 'Forever' },
  ];

  const SCALE_MIN = 1;
  const SCALE_MAX = 10;
  const BEAUTY_ENDS = ['Gritty', 'Surreal'];
  const CORTISOL_ENDS = ['Chill', 'Scary / violent af'];

  // How much each preference counts toward the match.
  const WEIGHTS = { genre: 3, mood: 2.5, cortisol: 2, beauty: 1.5, length: 1.5, lasting: 1.5 };
  // Share of the final score that comes from the movie's rating instead of
  // the match, so a great movie beats a mediocre one with the same fit.
  const RATING_SHARE = 0.15;

  function isScale(n) {
    return Number.isInteger(n) && n >= SCALE_MIN && n <= SCALE_MAX;
  }

  // Returns a cleaned profile, or throws with a human-readable message.
  function sanitizeProfile(input) {
    if (!input || typeof input !== 'object') throw new Error('Missing profile.');
    const genres = Array.isArray(input.genres) ? input.genres.filter((g) => GENRES.includes(g)) : [];
    const moods = Array.isArray(input.moods) ? input.moods.filter((m) => MOODS.includes(m)) : [];
    const runtime = Number(input.runtime);
    const beauty = Number(input.beauty);
    const cortisol = Number(input.cortisol);
    const lasting = Number(input.lasting);

    if (genres.length === 0) throw new Error('Pick at least one genre.');
    if (moods.length === 0) throw new Error('Pick at least one mood.');
    if (!Number.isInteger(runtime) || runtime < 1 || runtime > 1000) throw new Error('Runtime must be in minutes.');
    if (!isScale(beauty)) throw new Error(`Beauty style must be ${SCALE_MIN}–${SCALE_MAX}.`);
    if (!isScale(cortisol)) throw new Error(`Cortisol must be ${SCALE_MIN}–${SCALE_MAX}.`);
    if (!LASTING.some((l) => l.days === lasting)) throw new Error('Pick a lasting effect.');

    return { genres, moods, runtime, beauty, cortisol, lasting };
  }

  // ----- Per-trait similarity, each 0 (no fit) to 1 (perfect fit) -----

  function genreFit(want, movie) {
    return movie.genres.includes(want) ? 1 : 0;
  }

  function moodFit(want, movie) {
    if (movie.moods.includes(want)) return 1;
    const neighbors = MOOD_NEIGHBORS[want] || [];
    return movie.moods.some((m) => neighbors.includes(m)) ? 0.5 : 0;
  }

  // Full credit inside the chosen length bucket, fading to zero 60 minutes outside it.
  function lengthFit(wantKey, movie) {
    const bucket = LENGTHS.find((l) => l.key === wantKey);
    if (!bucket) return 1;
    const r = movie.runtime;
    const off = r < bucket.min ? bucket.min - r : r > bucket.max ? r - bucket.max : 0;
    return Math.max(0, 1 - off / 60);
  }

  // Squared so being 1 notch off barely matters but 5 notches off really does.
  function scaleFit(want, actual) {
    const d = Math.abs(want - actual) / (SCALE_MAX - SCALE_MIN);
    return 1 - d * d;
  }

  // Compared on a log scale: 1 vs 3 days is about as far apart as 10 vs 30.
  function lastingFit(want, actual) {
    const span = Math.log(LASTING[LASTING.length - 1].days / LASTING[0].days);
    return 1 - Math.abs(Math.log(want) - Math.log(actual)) / span;
  }

  // prefs: { genre, mood, length, beauty, cortisol, lasting } — any left
  // null/'' means "any" and is left out of the match entirely.
  function scoreMovie(prefs, movie) {
    const p = movie.profile;
    const parts = [];
    if (prefs.genre) parts.push({ trait: 'genre', w: WEIGHTS.genre, fit: genreFit(prefs.genre, p) });
    if (prefs.mood) parts.push({ trait: 'mood', w: WEIGHTS.mood, fit: moodFit(prefs.mood, p) });
    if (prefs.length) parts.push({ trait: 'length', w: WEIGHTS.length, fit: lengthFit(prefs.length, p) });
    if (prefs.beauty != null) parts.push({ trait: 'beauty', w: WEIGHTS.beauty, fit: scaleFit(prefs.beauty, p.beauty) });
    if (prefs.cortisol != null) parts.push({ trait: 'cortisol', w: WEIGHTS.cortisol, fit: scaleFit(prefs.cortisol, p.cortisol) });
    if (prefs.lasting) parts.push({ trait: 'lasting', w: WEIGHTS.lasting, fit: lastingFit(prefs.lasting, p.lasting) });

    const totalW = parts.reduce((s, x) => s + x.w, 0);
    const match = totalW ? parts.reduce((s, x) => s + x.w * x.fit, 0) / totalW : 1;
    const rating = Math.max(0, Math.min(1, (Number(movie.rating) || 0) / 1000));
    const score = (1 - RATING_SHARE) * match + RATING_SHARE * rating;
    return { movie, match, score, parts };
  }

  // Best first. Ties are broken randomly so "Surprise me" doesn't always give
  // the same answer.
  function rankMovies(prefs, movies) {
    return movies
      .filter((m) => m.profile)
      .map((m) => ({ ...scoreMovie(prefs, m), jitter: Math.random() }))
      .sort((a, b) => b.score - a.score || a.jitter - b.jitter);
  }

  function lengthLabelFor(runtime) {
    const h = Math.floor(runtime / 60);
    const m = runtime % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  function lastingLabel(days) {
    const l = LASTING.find((x) => x.days === days);
    return l ? l.label : `${days} days`;
  }

  const api = {
    GENRES,
    MOODS,
    LENGTHS,
    LASTING,
    SCALE_MIN,
    SCALE_MAX,
    BEAUTY_ENDS,
    CORTISOL_ENDS,
    sanitizeProfile,
    scoreMovie,
    rankMovies,
    lengthLabelFor,
    lastingLabel,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MovieProfile = api;
})(typeof window !== 'undefined' ? window : globalThis);
