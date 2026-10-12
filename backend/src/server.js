require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const db = require('./db');
const { requireAuthExcept } = require('./middleware/auth');
const { seedAdmin } = require('./seed');
const { seedAliasTable } = require('./aliases');
const { ensureStorageDir } = require('./storage');
const { requeueUnfinished } = require('./extraction/pipeline');
const { armRetention } = require('./retention');

// Extraction and matching are rule-based. AI_PROVIDER is reserved for an
// optional assist layer (e.g. Gemini) plugged in after extractDocument() in
// extraction/pipeline.js; until one exists, anything but "off" is refused
// rather than silently ignored. Never point a free-tier AI API at patient data.
const AI_PROVIDER = (process.env.AI_PROVIDER || 'off').toLowerCase();
if (AI_PROVIDER !== 'off') {
  throw new Error(`AI_PROVIDER="${AI_PROVIDER}" is not implemented. Set AI_PROVIDER=off.`);
}

const app = express();
app.set('trust proxy', 'loopback');
app.use(helmet());

// Browser origins allowed to call the API: the dashboard and the extension
// (chrome-extension://<id>). Requests with no Origin (curl, server-to-server)
// are allowed — CORS only ever restricts browsers.
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client'],
  }),
);
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Every /api route needs a signed-in user unless listed here — secure by default.
app.use('/api', requireAuthExcept(['/api/health', '/api/auth/login']));

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/users', require('./routes/users.routes'));
app.use('/api/documents', require('./routes/documents.routes'));
app.use('/api/match', require('./routes/match.routes'));
app.use('/api/form-mappings', require('./routes/form-mappings.routes'));
app.use('/api/field-aliases', require('./routes/field-aliases.routes'));
app.use('/api/allowed-sites', require('./routes/allowed-sites.routes'));
app.use('/api/fill-sessions', require('./routes/fill-sessions.routes'));
app.use('/api/audit-logs', require('./routes/audit-logs.routes'));
app.use('/api/dashboard', require('./routes/dashboard.routes'));
app.use('/api/claims', require('./routes/claims.routes'));

// Synthetic target forms for development (never in production).
if (process.env.DEMO_FORMS === 'true' && process.env.NODE_ENV !== 'production') {
  app.use('/demo/forms', express.static(path.join(__dirname, '..', 'demo-forms')));
}

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.name === 'MulterError') {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `File too large (max ${Number(process.env.MAX_UPLOAD_MB) || 20} MB)`
      : err.code === 'LIMIT_FILE_COUNT' ? 'Too many files in one upload' : err.message;
    return res.status(400).json({ error: message });
  }
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  if (!err.status || err.status >= 500) console.error(err);
  res.status(err.status || 500).json({ error: err.status && err.status < 500 ? err.message : 'Internal server error' });
});

const PORT = Number(process.env.PORT) || 4100;
const HOST = process.env.HOST || '0.0.0.0';

async function start() {
  await db.ensureDatabase();
  await db.ensureSchema();
  ensureStorageDir();
  await seedAdmin();
  const aliases = await seedAliasTable();
  if (aliases) console.log(`Seeded ${aliases} field aliases.`);
  const requeued = await requeueUnfinished();
  if (requeued) console.log(`Re-queued ${requeued} unfinished document(s).`);
  armRetention();

  app.listen(PORT, HOST, () => {
    console.log(`FillPilot backend listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
}

module.exports = app;
