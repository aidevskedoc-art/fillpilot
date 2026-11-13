// Reads hospital bill PDFs (and, for SPDCL, the HIS Excel exports) and returns
// what a target website needs — and keeps nothing: the files are read from
// memory, and neither they nor what was read from them is written to disk or
// to the database.
// The caller (the extension panel) holds the result only while it fills the
// form. The bill is needed for that and for nothing afterwards.
const express = require('express');
const multer = require('multer');
const { extractDocument, ExtractionError, PdfReadError } = require('../extraction/extract');
const { buildTgnpdclClaim, buildTgnpdclPharmacy, pharmacyFromExcel } = require('../claims/tgnpdcl');
const { writeTgnpdclPharmacyWorkbook } = require('../claims/tgnpdcl-pharmacy-workbook');
const { buildPmjayClaim } = require('../claims/pmjay');
const { buildCilClaim } = require('../claims/cil');
const { buildBhelClaim } = require('../claims/bhel');
const { buildNtpcClaim } = require('../claims/ntpc');
const { readFirstSheet, XlsxError } = require('../claims/xlsx');
const spdcl = require('../claims/spdcl');
const { writeSpdclWorkbook } = require('../claims/spdcl-workbook');
const tgtransco = require('../claims/tgtransco');
const { writeTgTranscoWorkbook } = require('../claims/tgtransco-workbook');

const ZIP = Buffer.from('PK\x03\x04', 'latin1');
const OLD_EXCEL = Buffer.from('d0cf11e0', 'hex');

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
 * The uploaded PDFs → { documents, final, summary, pharmacies, read }, or null
 * after answering with what is wrong. `fills` names what the final bill is
 * needed for; `files` the PDFs among the uploads (all of them by default).
 */
async function readBills(req, res, fills, files = req.files || [], need = 'final') {
  // need: the bill the site is filled from — 'final' (and the summary bill with it), or 'summary' alone (NTPC).
  if (!files.length) {
    res.status(400).json({ error: need === 'summary' ? 'Choose the summary bill PDF' : 'Choose the final bill PDF (and the summary bill PDF)' });
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
  const pharmacies = read.filter((r) => r.docType === 'yashoda-pharmacy-bill');
  if (need === 'summary' && !summaries.length) {
    const unread = read.filter((r) => r.error).map((r) => `${r.fileName}: ${r.error}`).join('; ');
    res.status(422).json({
      error: unread || `None of these PDFs is a Yashoda summary bill (the bill of supply with the ICO invoice number) — ${fills} filled from it.`,
      documents,
    });
    return null;
  }
  if (need === 'final' && !finals.length) {
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
  // Only TGNPDCL uses the pharmacy bill: the other sites leave it alone, as they did before it was read.
  return { documents, read, final: finals[0]?.structured, summary: summaries[0]?.structured, pharmacies: pharmacies.map((p) => p.structured) };
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

const isExcel = (file) => file.buffer.subarray(0, 4).equals(ZIP) || file.buffer.subarray(0, 4).equals(OLD_EXCEL);

/**
 * An uploaded Excel as the hospital's pharmacy bill → { fileName, bill } (its
 * reading, pharmacyFromExcel), or { error } to answer with: an old .xls, a
 * damaged file, the site's own pharmacy Excel, or some other sheet.
 */
function readPharmacyExcel(file) {
  const fileName = String(file.originalname || 'file.xlsx').slice(0, 255);
  if (file.buffer.subarray(0, 4).equals(OLD_EXCEL)) {
    return { error: `${fileName} is an old .xls file — open it in Excel, save it as "Excel Workbook (.xlsx)" and choose that` };
  }
  let sheet;
  try {
    sheet = { fileName, ...readFirstSheet(file.buffer) };
  } catch (err) {
    if (err instanceof XlsxError) return { error: `${fileName}: ${err.message}` };
    throw err;
  }
  // The site's own pharmacy Excel (a sheet named "Pharmacy" too), made by hand or by FillPilot: it goes to the site as it is.
  if (sheet.rows[0]?.some((cell) => /date\s*of\s*utili[sz]ation/i.test(String(cell ?? '')))) {
    return { error: `${fileName} is already TGNPDCL's pharmacy Excel — upload it with the site's "Upload Excel" button. For FillPilot, choose the hospital's pharmacy bill (PDF or Excel).` };
  }
  if (!spdcl.isPharmacyBill(sheet)) return { error: `${fileName}: not the hospital's pharmacy bill Excel — the final and summary bills go in as PDFs` };
  return { fileName, bill: pharmacyFromExcel(spdcl.parsePharmacyBill(sheet.rows)) };
}

/** The Pharmacy tab's rows → TGNPDCL's upload Excel, as the panel saves it: { fileName, base64 }. */
const pharmacyFile = (rows, ipNo) => ({
  fileName: `TGNPDCL-pharmacy-${String(ipNo || '').replace(/[^0-9A-Za-z]/g, '') || 'bill'}.xlsx`,
  base64: writeTgnpdclPharmacyWorkbook(rows).toString('base64'),
});

// POST /api/claims/tgnpdcl — multipart "files": the Yashoda final bill and (optionally) the
// summary bill and the pharmacy bill — the pharmacy bill as its PDF or as the HIS Excel export.
// With a pharmacy bill the answer carries the Pharmacy tab's upload file (base64), in the site's template.
router.post('/tgnpdcl', upload.array('files', MAX_FILES), route(async (req, res) => {
  const all = req.files || [];
  const excels = all.filter(isExcel);
  let pharmacyExcel = null;
  const excelDocs = [];
  for (const file of excels) {
    const read = readPharmacyExcel(file);
    if (read.error) return res.status(422).json({ error: read.error });
    if (pharmacyExcel) return res.status(422).json({ error: 'These files hold more than one pharmacy bill — choose one patient\'s bills at a time.' });
    pharmacyExcel = read.bill;
    excelDocs.push({ fileName: read.fileName, docType: 'his-pharmacy-excel', pageCount: null });
  }

  const bills = await readBills(req, res, 'the tabs are', all.filter((f) => !excels.includes(f)));
  if (!bills) return;
  const documents = [...bills.documents, ...excelDocs];
  if (bills.pharmacies.length > 1) {
    return res.status(422).json({ error: 'These PDFs hold more than one pharmacy bill — choose one patient\'s bills at a time.', documents });
  }
  if (bills.pharmacies.length && pharmacyExcel) {
    return res.status(422).json({ error: 'The pharmacy bill was chosen twice, as a PDF and as an Excel — choose one of them.', documents });
  }
  const claim = buildTgnpdclClaim({ final: bills.final, summary: bills.summary, pharmacy: bills.pharmacies[0] ?? pharmacyExcel });
  const { pharmacy } = claim.tabs;
  if (pharmacy.rows.length) pharmacy.file = pharmacyFile(pharmacy.rows, claim.patient.ipNo);
  await logRead(req, [...bills.read, ...excelDocs], 'tgnpdcl');
  res.json({ documents, ...claim });
}));

// POST /api/claims/tgnpdcl-pharmacy — multipart "files": the pharmacy bill alone, as its PDF or as
// the HIS Excel export → TGNPDCL's pharmacy upload Excel (base64) and what is in it, for the site's
// "Upload Excel" on "3. Pharmacy". The panel's "Excel & PDF" tab: no website, no final bill. Nothing is stored.
router.post('/tgnpdcl-pharmacy', upload.array('files', MAX_FILES), route(async (req, res) => {
  const files = req.files || [];
  if (files.length !== 1) return res.status(400).json({ error: 'Choose the pharmacy bill — its PDF or the HIS Excel, one file' });
  const file = files[0];
  const fileName = String(file.originalname || 'file').slice(0, 255);
  let bill;
  let document;
  if (isExcel(file)) {
    const read = readPharmacyExcel(file);
    if (read.error) return res.status(422).json({ error: read.error });
    bill = read.bill;
    document = { fileName, docType: 'his-pharmacy-excel', pageCount: null };
  } else {
    // Trust the bytes, not the extension or the browser's mime type.
    if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return res.status(422).json({ error: `${fileName} is neither a PDF nor an Excel (.xlsx) file` });
    let read;
    try {
      read = await inTurn(() => extractDocument(file.buffer));
    } catch (err) {
      if (!(err instanceof ExtractionError || err instanceof PdfReadError)) throw err;
      return res.status(422).json({ error: `${fileName}: ${err.message}` });
    }
    document = { fileName, docType: read.docType || null, pageCount: read.pageCount };
    if (read.docType !== 'yashoda-pharmacy-bill') {
      return res.status(422).json({ error: `${fileName} is not a Yashoda pharmacy bill (the one headed "PHARMACY DETAILS") — choose the pharmacy bill`, documents: [document] });
    }
    bill = read.structured;
  }
  const sheet = buildTgnpdclPharmacy(bill);
  await logRead(req, [document], 'tgnpdcl-pharmacy');
  res.json({ documents: [document], ...sheet, ...(sheet.rows.length ? { file: pharmacyFile(sheet.rows, sheet.patient?.ipNo) } : {}) });
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

// POST /api/claims/bhel — the same bills → the BHEL (KareXpert) Upload Bill screen: Patient Details and
// one Bill Details row per Service Type.
router.post('/bhel', upload.array('files', MAX_FILES), route(async (req, res) => {
  const bills = await readBills(req, res, 'Bill Details is');
  if (!bills) return;
  const claim = buildBhelClaim({ final: bills.final, summary: bills.summary });
  await logRead(req, bills.read, 'bhel');
  res.json({ documents: bills.documents, ...claim });
}));

// POST /api/claims/ntpc — the summary bill (a final bill with it is only checked to be the same
// patient's) → NTPC Sanjeevani's Patient Discharge screen: dates, bill number, one amount per charge box.
router.post('/ntpc', upload.array('files', MAX_FILES), route(async (req, res) => {
  const bills = await readBills(req, res, 'the Patient Discharge screen is', undefined, 'summary');
  if (!bills) return;
  const claim = buildNtpcClaim({ summary: bills.summary, final: bills.final });
  await logRead(req, bills.read, 'ntpc');
  res.json({ documents: bills.documents, ...claim });
}));

/**
 * The uploads as the HIS final bill and (optionally) pharmacy bill Excel files →
 * { final, pharmacy, documents } read, or null after answering with what is wrong.
 */
function readHisExcels(req, res) {
  const files = req.files || [];
  if (!files.length) {
    res.status(400).json({ error: 'Choose the HIS final bill and pharmacy bill Excel files' });
    return null;
  }
  const fail = (error) => {
    res.status(422).json({ error });
    return null;
  };
  const sheets = [];
  for (const file of files) {
    const fileName = String(file.originalname || 'file.xlsx').slice(0, 255);
    // Trust the bytes, not the extension or the browser's mime type.
    const head = file.buffer.subarray(0, 4);
    if (head.equals(OLD_EXCEL)) return fail(`${fileName} is an old .xls file — open it in Excel, save it as "Excel Workbook (.xlsx)" and choose that`);
    if (!head.equals(ZIP)) return fail(`${fileName} is not an Excel (.xlsx) file`);
    try {
      sheets.push({ fileName, ...readFirstSheet(file.buffer) });
    } catch (err) {
      if (err instanceof XlsxError) return fail(`${fileName}: ${err.message}`);
      throw err;
    }
  }

  const finals = sheets.filter(spdcl.isFinalBill);
  const pharmacies = sheets.filter((s) => !spdcl.isFinalBill(s) && spdcl.isPharmacyBill(s));
  const others = sheets.filter((s) => !finals.includes(s) && !pharmacies.includes(s));
  if (others.length) return fail(`${others.map((s) => s.fileName).join(', ')}: not the HIS final bill or pharmacy bill Excel`);
  if (!finals.length) return fail('None of these files is the HIS final bill (the sheet with "Charged Amount")');
  if (finals.length > 1 || pharmacies.length > 1) return fail('These files hold more than one final or pharmacy bill — choose one patient\'s two files');

  return {
    final: spdcl.parseFinalBill(finals[0].rows),
    pharmacy: pharmacies.length ? spdcl.parsePharmacyBill(pharmacies[0].rows) : null,
    documents: [
      { fileName: finals[0].fileName, kind: 'final-bill' },
      ...pharmacies.map((p) => ({ fileName: p.fileName, kind: 'pharmacy-bill' })),
    ],
  };
}

/** A typed date field (dd/mm/yyyy) → its text, null when empty, or undefined after answering that it is not a date. */
function dateField(req, res, field, what) {
  const value = String(req.body?.[field] || '').trim() || null;
  if (value && spdcl.dayOf(value) == null) {
    res.status(400).json({ error: `${what} must be a date like 26/09/2026` });
    return undefined;
  }
  return value;
}

/** Two patients' bills must never become one claim file: the error to answer with, or null. */
const mixedPatients = (sheet) => sheet.checks.find((c) => c.level === 'error' && /different patients/.test(c.message))?.message ?? null;

// POST /api/claims/spdcl — multipart "files": the HIS final bill and pharmacy bill
// Excel files (.xlsx); optional fields admissionDate (dd/mm/yyyy) and tariffType.
// → the SPDCL upload file (base64) and what is in it. Nothing is stored.
// Not queued behind PDF reading (inTurn): an Excel file is read in milliseconds.
router.post('/spdcl', upload.array('files', MAX_FILES), route(async (req, res) => {
  const admissionDate = dateField(req, res, 'admissionDate', 'Admission date');
  if (admissionDate === undefined) return;
  const tariffType = String(req.body?.tariffType || 'EHS');
  if (!spdcl.TARIFF_TYPES.includes(tariffType)) return res.status(400).json({ error: `Tariff type must be one of ${spdcl.TARIFF_TYPES.join(', ')}` });

  const bills = readHisExcels(req, res);
  if (!bills) return;
  const sheet = spdcl.buildSpdclSheet({ final: bills.final, pharmacy: bills.pharmacy, admissionDate, tariffType });
  const mixed = mixedPatients(sheet);
  if (mixed) return res.status(422).json({ error: mixed });
  const ipDigits = String(sheet.patient.ipNo || '').replace(/[^0-9A-Za-z]/g, '');
  const file = writeSpdclWorkbook(sheet);
  // Logged as a read like the PDF sites: two files, no pages.
  await logRead(req, req.files.map(() => ({ pageCount: 0 })), 'spdcl');
  res.json({
    documents: bills.documents,
    ...sheet,
    fileName: `SPDCL-${ipDigits || 'bill'}.xlsx`,
    fileBase64: file.toString('base64'),
  });
}));

// POST /api/claims/tgtransco — the same two HIS Excel files; optional fields
// admissionDate, dischargeDate, surgeryDate (dd/mm/yyyy) and tariffType (as the
// template's list, "EHS SUPERSPECIALITY" by default) → TG Transco's bill file
// (base64, named "<IP> - TG TRANSCO.xlsx" as the team names it) and what is in it. Nothing is stored.
router.post('/tgtransco', upload.array('files', MAX_FILES), route(async (req, res) => {
  const admissionDate = dateField(req, res, 'admissionDate', 'Admission date');
  if (admissionDate === undefined) return;
  const dischargeDate = dateField(req, res, 'dischargeDate', 'Date of discharge');
  if (dischargeDate === undefined) return;
  const surgeryDate = dateField(req, res, 'surgeryDate', 'Date of surgery');
  if (surgeryDate === undefined) return;
  const tariffType = String(req.body?.tariffType || tgtransco.DEFAULT_TARIFF);
  if (!tgtransco.TARIFF_TYPES.includes(tariffType)) return res.status(400).json({ error: `Tariff type must be one of ${tgtransco.TARIFF_TYPES.join(', ')}` });

  const bills = readHisExcels(req, res);
  if (!bills) return;
  const sheet = tgtransco.buildTgTranscoSheet({ final: bills.final, pharmacy: bills.pharmacy, admissionDate, dischargeDate, surgeryDate, tariffType });
  const mixed = mixedPatients(sheet);
  if (mixed) return res.status(422).json({ error: mixed });
  const ipDigits = String(sheet.patient.ipNo || '').replace(/[^0-9A-Za-z]/g, '');
  const file = writeTgTranscoWorkbook(sheet);
  await logRead(req, req.files.map(() => ({ pageCount: 0 })), 'tgtransco');
  res.json({
    documents: bills.documents,
    ...sheet,
    fileName: ipDigits ? `${ipDigits} - TG TRANSCO.xlsx` : 'TG TRANSCO.xlsx',
    fileBase64: file.toString('base64'),
  });
}));

module.exports = router;
