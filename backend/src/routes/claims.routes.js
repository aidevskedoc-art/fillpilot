// Reads hospital bill PDFs (and, for SPDCL, the HIS Excel exports) and returns
// what a target website needs — and keeps nothing: the files are read from
// memory, and neither they nor what was read from them is written to disk or
// to the database.
// The caller (the extension panel) holds the result only while it fills the
// form. The bill is needed for that and for nothing afterwards.
const express = require('express');
const multer = require('multer');
const { extractDocument, ExtractionError, PdfReadError } = require('../extraction/extract');
const { buildTgnpdclClaim } = require('../claims/tgnpdcl');
const { buildPmjayClaim } = require('../claims/pmjay');
const { buildCilClaim } = require('../claims/cil');
const { readFirstSheet, XlsxError } = require('../claims/xlsx');
const spdcl = require('../claims/spdcl');
const { writeSpdclWorkbook } = require('../claims/spdcl-workbook');

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

// POST /api/claims/cil — the same bills → the Coal India (e-Arogya Suvidha) IP claim's Bill Details rows.
router.post('/cil', upload.array('files', MAX_FILES), route(async (req, res) => {
  const bills = await readBills(req, res, 'Bill Details is');
  if (!bills) return;
  const claim = buildCilClaim({ final: bills.final, summary: bills.summary });
  await logRead(req, bills.read, 'cil');
  res.json({ documents: bills.documents, ...claim });
}));

const ZIP = Buffer.from('PK\x03\x04', 'latin1');
const OLD_EXCEL = Buffer.from('d0cf11e0', 'hex');

// POST /api/claims/spdcl — multipart "files": the HIS final bill and pharmacy bill
// Excel files (.xlsx); optional fields admissionDate (dd/mm/yyyy) and tariffType.
// → the SPDCL upload file (base64) and what is in it. Nothing is stored.
// Not queued behind PDF reading (inTurn): an Excel file is read in milliseconds.
router.post('/spdcl', upload.array('files', MAX_FILES), route(async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Choose the HIS final bill and pharmacy bill Excel files' });

  const admissionDate = String(req.body?.admissionDate || '').trim() || null;
  if (admissionDate && spdcl.dayOf(admissionDate) == null) return res.status(400).json({ error: 'Admission date must be a date like 26/09/2026' });
  const tariffType = String(req.body?.tariffType || 'EHS');
  if (!spdcl.TARIFF_TYPES.includes(tariffType)) return res.status(400).json({ error: `Tariff type must be one of ${spdcl.TARIFF_TYPES.join(', ')}` });

  const sheets = [];
  for (const file of files) {
    const fileName = String(file.originalname || 'file.xlsx').slice(0, 255);
    // Trust the bytes, not the extension or the browser's mime type.
    const head = file.buffer.subarray(0, 4);
    if (head.equals(OLD_EXCEL)) {
      return res.status(422).json({ error: `${fileName} is an old .xls file — open it in Excel, save it as "Excel Workbook (.xlsx)" and choose that` });
    }
    if (!head.equals(ZIP)) return res.status(422).json({ error: `${fileName} is not an Excel (.xlsx) file` });
    try {
      sheets.push({ fileName, ...readFirstSheet(file.buffer) });
    } catch (err) {
      if (err instanceof XlsxError) return res.status(422).json({ error: `${fileName}: ${err.message}` });
      throw err;
    }
  }

  const finals = sheets.filter(spdcl.isFinalBill);
  const pharmacies = sheets.filter((s) => !spdcl.isFinalBill(s) && spdcl.isPharmacyBill(s));
  const others = sheets.filter((s) => !finals.includes(s) && !pharmacies.includes(s));
  if (others.length) {
    return res.status(422).json({ error: `${others.map((s) => s.fileName).join(', ')}: not the HIS final bill or pharmacy bill Excel` });
  }
  if (!finals.length) return res.status(422).json({ error: 'None of these files is the HIS final bill (the sheet with "Charged Amount")' });
  if (finals.length > 1 || pharmacies.length > 1) {
    return res.status(422).json({ error: 'These files hold more than one final or pharmacy bill — choose one patient\'s two files' });
  }

  const final = spdcl.parseFinalBill(finals[0].rows);
  const pharmacy = pharmacies.length ? spdcl.parsePharmacyBill(pharmacies[0].rows) : null;
  const sheet = spdcl.buildSpdclSheet({ final, pharmacy, admissionDate, tariffType });
  // Two patients' bills must never become one claim file.
  const mixed = sheet.checks.find((c) => c.level === 'error' && /different patients/.test(c.message));
  if (mixed) return res.status(422).json({ error: mixed.message });
  const ipDigits = String(sheet.patient.ipNo || '').replace(/[^0-9A-Za-z]/g, '');
  const file = writeSpdclWorkbook(sheet);
  // Logged as a read like the PDF sites: two files, no pages.
  await logRead(req, files.map(() => ({ pageCount: 0 })), 'spdcl');
  res.json({
    documents: [
      { fileName: finals[0].fileName, kind: 'final-bill' },
      ...pharmacies.map((p) => ({ fileName: p.fileName, kind: 'pharmacy-bill' })),
    ],
    ...sheet,
    fileName: `SPDCL-${ipDigits || 'bill'}.xlsx`,
    fileBase64: file.toString('base64'),
  });
}));

module.exports = router;
