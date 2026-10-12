// The reading service on its own: bill PDFs in, what the form needs out.
// No database, no accounts, nothing written to disk — for PCs that run
// FillPilot from a folder (package/). Sign-in, the approved websites and the
// activity log live in the extension's own storage there instead.
//
// It answers this PC only (127.0.0.1 by default) and only the extension:
// a web page open in the same browser cannot have a bill read by it.
//
//   CORS_ORIGIN=chrome-extension://<id> node src/reader-server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (!allowedOrigins.length) {
  throw new Error('CORS_ORIGIN is not set — name the extension that may use the reader (chrome-extension://<id>).');
}

const app = express();
app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
    allowedHeaders: ['Content-Type', 'X-Client'],
  }),
);

app.get('/api/health', (req, res) => res.json({ status: 'ok', mode: 'reader' }));

// Browsers always state where such a request comes from; anything that is not the extension stops here.
app.use('/api', (req, res, next) => {
  if (allowedOrigins.includes(req.headers.origin)) return next();
  res.status(403).json({ error: 'Only the FillPilot extension can use this service' });
});

app.use('/api/claims', require('./routes/claims.routes'));

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.name === 'MulterError') {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `File too large (max ${Number(process.env.MAX_UPLOAD_MB) || 20} MB)`
      : err.code === 'LIMIT_FILE_COUNT' ? 'Too many files at once' : err.message;
    return res.status(400).json({ error: message });
  }
  if (!err.status || err.status >= 500) console.error(err);
  res.status(err.status || 500).json({ error: err.status && err.status < 500 ? err.message : 'Internal server error' });
});

const PORT = Number(process.env.PORT) || 4100;
const HOST = process.env.HOST || '127.0.0.1';

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`FillPilot reader listening on http://${HOST}:${PORT} (no database, nothing stored)`);
  });
}

module.exports = app;
