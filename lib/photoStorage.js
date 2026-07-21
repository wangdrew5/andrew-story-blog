// Photo storage abstraction: uses Vercel Blob in production (local disk
// writes don't persist on serverless), falls back to public/uploads for
// local dev so `npm start` works with zero cloud setup.

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Vercel Blob authenticates via a static BLOB_READ_WRITE_TOKEN, or (for
// stores connected the current way) via OIDC using BLOB_STORE_ID plus a
// VERCEL_OIDC_TOKEN Vercel injects automatically at runtime. Prefer the
// static token when one is set — it's simpler and avoids relying on the
// store's OIDC trust being configured correctly.
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const useBlob = !!(BLOB_TOKEN || process.env.BLOB_STORE_ID);
const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');

async function savePhoto(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const filename = `${uuidv4()}${ext}`;

  if (useBlob) {
    const { put } = require('@vercel/blob');
    const blob = await put(filename, file.buffer, {
      access: 'public',
      contentType: file.mimetype,
      ...(BLOB_TOKEN ? { token: BLOB_TOKEN } : {}),
    });
    return blob.url;
  }

  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), file.buffer);
  return `/uploads/${filename}`;
}

module.exports = { savePhoto };
