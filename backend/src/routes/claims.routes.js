// Reads hospital bill PDFs and returns what a target website's multi-step
// form needs — and keeps nothing: the PDFs are read from memory, and neither
// they nor what was read from them is written to disk or to the database.
// The caller (the extension panel) holds the result only while it fills the
// form. The bill is needed for that and for nothing afterwards.
const express = require('express');
const multer = require('multer');
const { extractDocument, ExtractionError, PdfReadError } = require('../extraction/extract');
const { buildTgnpdclClaim } = require('../claims/tgnpdcl');
const { buildPmjayClaim } = require('../claims/pmjay');

const router = express.Router();

// Nothing here needs the database, and the reading service (reader-server.js)
// runs without one — so this file does not load it either.
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 20;
const MAX_FILES = 4;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: MAX_FILES },
});

// One set of bills at a time: reading scanned pages is heavy, and two sets
// read at once would only slow each other down.
let turn = Promise.resolve();
function inTurn(task) {
  const run = turn.then(task, task);
  turn = run.catch(() => {});
  return run;
}

/**
 * The uploaded PDFs → { documents, final, summary, read }, or null after
 * answering with what is wrong. `fills` names what the final bill is needed for.
 */
async function readBills(req, res, fills) {
  const files = req.files || [];
  if (!files.length) {
    res.status(400).json({ error: 'Choose the final bill PDF (and the summary bill PDF)' });
    return null;
  }

  const read = await inTurn(async () => {
    const out = [];
    for (const file of files) {
      const fileName = String(file.originalname || 'document.pdf').slice(0, 255);
      // Trust the bytes, not the extension or the browser's mime type.
      if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
        out.push({ fileName, error: 'Not a PDF file' });
        continue;
      }
      try {
        const { docType, structured, pageCount } = await extractDocument(file.buffer);
        out.push({ fileName, docType: docType || null, pageCount, structured });
      } catch (err) {
        if (!(err instanceof ExtractionError || err instanceof PdfReadError)) throw err;
        out.push({ fileName, error: err.message });
      }
    }
    return out;
  });

  const documents = read.map((r) => ({
    fileName: r.fileName,
    docType: r.docType ?? null,
    pageCount: r.pageCount ?? null,
    ...(r.error ? { error: r.error } : {}),
  }));
  const finals = read.filter((r) => r.docType === 'yashoda-final-bill');
  const summaries = read.filter((r) => r.docType === 'yashoda-summary-bill');
  if (!finals.length) {
    const unread = read.filter((r) => r.error).map((r) => `${r.fileName}: ${r.error}`).join('; ');
    res.status(422).json({
      error: unread || `None of these PDFs is a Yashoda final bill (the itemised bill with "Charged Amount") — ${fills} filled from it.`,
      documents,
    });
    return null;
  }
  if (finals.length > 1 || summaries.length > 1) {
    res.status(422).json({ error: 'These PDFs hold more than one final or summary bill — choose one patient\'s bills at a time.', documents });
    return null;
  }
  return { documents, read, final: finals[0].structured, summary: summaries[0]?.structured };
}

/** The log records that bills were read — not whose, and not their file names. */
async function logRead(req, read, site) {
  // (The reading service on its own has no accounts and no log: reader-server.js.)
  if (!req.user) return;
  await require('../audit-log').logAction({
    actorUserId: req.user.sub,
    entityType: 'claim',
    action: 'BILLS_READ',
    details: { site, files: read.length, pages: read.reduce((n, r) => n + (r.pageCount || 0), 0) },
    req,
  });
}

// POST /api/claims/tgnpdcl — multipart "files": the Yashoda final bill and (optionally) the summary bill.
router.post('/tgnpdcl', upload.array('files', MAX_FILES), route(async (req, res) => {
  const bills = await readBills(req, res, 'the tabs are');
  if (!bills) return;
  const claim = buildTgnpdclClaim({ final: bills.final, summary: bills.summary });
  await logRead(req, bills.read, 'tgnpdcl');
  res.json({ documents: bills.documents, ...claim });
}));

// POST /api/claims/pmjay — the same bills → the PM-JAY Treatment Plan rows (one per package code).
router.post('/pmjay', upload.array('files', MAX_FILES), route(async (req, res) => {
  const bills = await readBills(req, res, 'the Treatment Plan is');
  if (!bills) return;
  const claim = buildPmjayClaim({ final: bills.final, summary: bills.summary });
  await logRead(req, bills.read, 'pmjay');
  res.json({ documents: bills.documents, ...claim });
}));

module.exports = router;
