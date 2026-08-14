const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const { readData, writeData } = require('./lib/store');
const { savePhoto } = require('./lib/photoStorage');
const { notifySubscribers, sendWelcomeEmail } = require('./lib/mailer');
const { waitUntil } = require('@vercel/functions');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Keeps the serverless function alive long enough to finish a background
// email send after the response has already gone out to the client, instead
// of either blocking the response on it or letting the platform freeze the
// function mid-send.
function runInBackground(promise) {
  try {
    waitUntil(promise);
  } catch {
    // Not running inside a Vercel Function (e.g. local dev) — let it run normally.
  }
}

const DEFAULT_ADMINS = [
  { username: 'andrew', password: 'andrew123', displayName: 'Andrew' },
  { username: 'ethan', password: 'ethan123', displayName: 'Ethan' },
];

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

if (!process.env.JWT_SECRET) {
  console.warn(
    'WARNING: JWT_SECRET is not set. On a serverless host this invalidates admin sessions ' +
      'on every cold start. Set JWT_SECRET in your environment for production.'
  );
}

// Supports multiple named admin accounts (one per contributor) instead of a
// single shared login, so each person's session is tied to their own
// username and can only publish under their own author tab.
async function getOrCreateAdmins() {
  let admins = await readData('admins', null);
  if (!admins) {
    // Migrate a pre-existing single-admin record (old "admin" key) so an
    // already-changed password isn't clobbered by the new default list.
    const legacy = await readData('admin', null);
    admins = DEFAULT_ADMINS.map((d) => {
      if (legacy && legacy.username === d.username) {
        return { username: legacy.username, passwordHash: legacy.passwordHash, displayName: d.displayName };
      }
      return { username: d.username, passwordHash: bcrypt.hashSync(d.password, 10), displayName: d.displayName };
    });
    await writeData('admins', admins);
    console.log('Created default admin accounts (change these by logging in and updating data/admins.json, or the "admins" KV key):');
    admins.forEach((a, i) => {
      const carriedOver = legacy && legacy.username === a.username;
      console.log(`  ${a.username} / ${carriedOver ? '(existing password)' : DEFAULT_ADMINS[i].password}`);
    });
  }
  return admins;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const app = express();

app.use(express.json());
app.use(cookieParser());

// Kept in sync with MAX_PHOTO_BYTES in public/js/blog.js: Vercel serverless
// functions reject request bodies over ~4.5MB before our code even runs, so
// this must stay comfortably under that or oversized uploads just drop the
// connection instead of hitting this limit.
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

function decodeAdminToken(req) {
  const token = req.cookies && req.cookies.admin_token;
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function isAdminRequest(req) {
  return !!decodeAdminToken(req);
}

function requireAdmin(req, res, next) {
  const payload = decodeAdminToken(req);
  if (!payload) return res.status(401).json({ error: 'Admin login required.' });
  req.admin = payload;
  next();
}

// ---------- Admin auth ----------

app.post(
  '/api/admin/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Missing credentials.' });
    }
    const admins = await getOrCreateAdmins();
    const admin = admins.find((a) => a.username === username);
    if (!admin || !bcrypt.compareSync(password, admin.passwordHash)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    const token = jwt.sign({ isAdmin: true, username: admin.username }, JWT_SECRET, { expiresIn: '8h' });
    res.cookie('admin_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
    });
    res.json({ ok: true });
  })
);

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.json({ ok: true });
});

app.get('/api/admin/session', (req, res) => {
  const payload = decodeAdminToken(req);
  res.json({ isAdmin: !!payload, username: payload ? payload.username : null });
});

// ---------- Posts (blog reviews) ----------

app.get(
  '/api/posts',
  asyncHandler(async (req, res) => {
    const { type, author } = req.query;
    let posts = await readData('posts', []);
    if (type) posts = posts.filter((p) => p.type === type);
    // Posts created before multi-author support didn't have an author field;
    // treat those as Andrew's so existing content still shows up.
    if (author) posts = posts.filter((p) => (p.author || 'andrew') === author);
    posts.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(posts);
  })
);

app.post(
  '/api/posts',
  requireAdmin,
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    const { type, title, creator, date, review } = req.body || {};
    if (!type || !['book', 'movie'].includes(type) || !title || !creator || !date || !review) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    const photo = req.file ? await savePhoto(req.file) : null;
    const posts = await readData('posts', []);
    const post = {
      id: uuidv4(),
      type,
      author: req.admin.username,
      title,
      creator,
      date,
      review,
      photo,
      comments: [],
      createdAt: new Date().toISOString(),
    };
    posts.push(post);
    await writeData('posts', posts);
    res.status(201).json(post);

    const subscribers = await readData('subscribers', []);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    runInBackground(notifySubscribers({ subscribers, post, baseUrl }));
  })
);

app.post(
  '/api/posts/:id/comments',
  asyncHandler(async (req, res) => {
    const { name, text } = req.body || {};
    if (!name || !text) return res.status(400).json({ error: 'Missing name or text.' });
    const posts = await readData('posts', []);
    const post = posts.find((p) => p.id === req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    const comment = { id: uuidv4(), name, text, date: new Date().toISOString() };
    post.comments.push(comment);
    await writeData('posts', posts);
    res.status(201).json(comment);
  })
);

app.delete(
  '/api/posts/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const posts = await readData('posts', []);
    const remaining = posts.filter((p) => p.id !== req.params.id);
    if (remaining.length === posts.length) {
      return res.status(404).json({ error: 'Post not found.' });
    }
    await writeData('posts', remaining);
    res.json({ ok: true });
  })
);

// ---------- Mailing list ----------

app.post(
  '/api/subscribe',
  asyncHandler(async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const subscribers = await readData('subscribers', []);
    if (subscribers.some((s) => s.email === email)) {
      return res.json({ ok: true, message: "You're already subscribed." });
    }
    const token = uuidv4();
    subscribers.push({
      id: uuidv4(),
      email,
      token,
      createdAt: new Date().toISOString(),
    });
    await writeData('subscribers', subscribers);
    res.status(201).json({ ok: true, message: "Subscribed! You'll get an email for new reviews." });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    runInBackground(sendWelcomeEmail({ email, token, baseUrl }));
  })
);

app.get(
  '/api/unsubscribe',
  asyncHandler(async (req, res) => {
    const { token } = req.query;
    const subscribers = await readData('subscribers', []);
    const remaining = subscribers.filter((s) => s.token !== token);
    if (remaining.length !== subscribers.length) {
      await writeData('subscribers', remaining);
    }
    res
      .status(200)
      .type('html')
      .send(
        '<!DOCTYPE html><html><head><meta charset="UTF-8" /><title>Unsubscribed</title></head>' +
          '<body style="font-family: Georgia, serif; text-align: center; padding: 80px 20px;">' +
          '<h1>You\'ve been unsubscribed.</h1>' +
          '<p>You will no longer receive review notifications from Andrew\'s Story Collective.</p>' +
          '<p><a href="/">Back to the site</a></p>' +
          '</body></html>'
      );
  })
);

// ---------- Rankings ----------

app.get(
  '/api/rankings',
  asyncHandler(async (req, res) => {
    const { type, author, sort } = req.query;
    let rankings = await readData('rankings', []);
    if (type) rankings = rankings.filter((r) => r.type === type);
    // Entries created before multi-author support didn't have an author
    // field; treat those as Andrew's so existing rankings still show up.
    if (author) rankings = rankings.filter((r) => (r.author || 'andrew') === author);
    if (sort === 'rating') {
      rankings.sort((a, b) => b.rating - a.rating);
    } else {
      rankings.sort((a, b) => new Date(b.date) - new Date(a.date));
    }
    res.json(rankings);
  })
);

app.post(
  '/api/rankings',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { type, title, rating } = req.body || {};
    const numericRating = Number(rating);
    if (!type || !['book', 'movie', 'story'].includes(type) || !title || Number.isNaN(numericRating)) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    if (numericRating < 0 || numericRating > 1000) {
      return res.status(400).json({ error: 'Rating must be between 0 and 1000.' });
    }
    const rankings = await readData('rankings', []);
    const entry = {
      id: uuidv4(),
      type,
      author: req.admin.username,
      title,
      rating: numericRating,
      date: new Date().toISOString(),
    };
    rankings.push(entry);
    await writeData('rankings', rankings);
    res.status(201).json(entry);
  })
);

app.delete(
  '/api/rankings/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const rankings = await readData('rankings', []);
    const remaining = rankings.filter((r) => r.id !== req.params.id);
    if (remaining.length === rankings.length) {
      return res.status(404).json({ error: 'Ranking entry not found.' });
    }
    await writeData('rankings', remaining);
    res.json({ ok: true });
  })
);

// ---------- Future watch/read list ----------

app.get(
  '/api/future',
  asyncHandler(async (req, res) => {
    const entries = await readData('future', []);
    entries.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(entries);
  })
);

app.post(
  '/api/future',
  asyncHandler(async (req, res) => {
    const { category, title } = req.body || {};
    if (!category || !['book', 'movie'].includes(category) || !title) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    const adminPayload = decodeAdminToken(req);
    const admin = !!adminPayload;
    let enteredBy;
    if (admin) {
      enteredBy = adminPayload.username.charAt(0).toUpperCase() + adminPayload.username.slice(1);
    } else {
      enteredBy = (req.body && req.body.enteredBy || '').trim();
      if (!enteredBy) {
        return res.status(400).json({ error: 'Please enter your name.' });
      }
    }

    const entries = await readData('future', []);
    const entry = {
      id: uuidv4(),
      category,
      title,
      enteredBy,
      isAdmin: admin,
      completed: false,
      date: new Date().toISOString(),
    };
    entries.push(entry);
    await writeData('future', entries);
    res.status(201).json(entry);
  })
);

app.patch(
  '/api/future/:id/toggle-complete',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entries = await readData('future', []);
    const entry = entries.find((e) => e.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Entry not found.' });
    entry.completed = !entry.completed;
    await writeData('future', entries);
    res.json(entry);
  })
);

app.delete(
  '/api/future/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const entries = await readData('future', []);
    const remaining = entries.filter((e) => e.id !== req.params.id);
    if (remaining.length === entries.length) {
      return res.status(404).json({ error: 'Entry not found.' });
    }
    await writeData('future', remaining);
    res.json({ ok: true });
  })
);

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Photo is too large. Please use an image under 4MB.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Andrew's Story Collective running at http://localhost:${PORT}`);
  });
}

module.exports = app;
