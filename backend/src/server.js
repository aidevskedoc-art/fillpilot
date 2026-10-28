require('dotenv').config();

const http = require('http');
const os = require('os');
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

// The packed extension for the team's PCs (fillpilot.crx + updates.xml, written
// by extension/release.mjs). Chrome's Group Policy install and its update check
// fetch these without a sign-in; they hold no data, only the extension's code.
app.use('/extension', express.static(path.join(__dirname, '..', 'extension-release'), {
  setHeaders: (res, file) => {
    if (file.endsWith('.crx')) res.setHeader('Content-Type', 'application/x-chrome-extension');
  },
}));

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
app.use('/api/reports', require('./routes/reports.routes'));
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

  const server = app.listen(PORT, HOST, () => {
    console.log(`FillPilot backend listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    // The address the other PCs' extension is built with (API_BASE, see extension/build.mjs).
    if (HOST === '0.0.0.0') for (const address of networkAddresses()) console.log(`  from other PCs: http://${address}:${PORT}`);
  });
  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE' && (await alreadyRunning())) {
      console.log(`The FillPilot server is already running on this PC (port ${PORT}) — nothing more to start.`);
    } else {
      console.error(err.code === 'EADDRINUSE'
        ? `Port ${PORT} is in use by another program — the FillPilot server cannot start.`
        : `Failed to start server: ${err.message}`);
    }
    process.exit(1);
  });
}

/**
 * Is the program that holds the port a FillPilot server?
 * (http.get, not fetch: on Windows, process.exit() straight after a fetch trips a Node assertion.)
 */
function alreadyRunning() {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST === '0.0.0.0' ? '127.0.0.1' : HOST, port: PORT, path: '/api/health', timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(res.statusCode === 200 && /"status"\s*:\s*"ok"/.test(body)));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

function networkAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });
}

module.exports = app;
