// PDF -> positioned text items, per page. pdfjs-dist only: pdf-parse's bundled
// pdf.js (2018) throws "bad XRef entry" on PDFs from modern writers.
//
// Pages whose content is mostly a picture (Yashoda's bills are printed as
// images) are rendered at 300 dpi and read with OCR. Real text always wins:
// OCR words that overlap a native text item are dropped.

const { ocrAvailable, recognize, OCR_SCALE } = require('../ocr');
const { ocrToItems } = require('../ocr/merge');

let pdfjsPromise = null;
function loadPdfjs() {
  // pdfjs-dist v4 is ESM-only; a dynamic import works from CommonJS.
  pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/** A page with less text than this is treated as scanned (image only). */
const SCANNED_PAGE_CHARS = 20;
/**
 * OCR a page when images cover at least this share of it (logos and stamps
 * stay well below)…
 */
const OCR_IMAGE_SHARE = 0.25;
/**
 * …and its real text is sparse. Some insurers print every page over a
 * full-page background image with 1,000+ characters of real text on top —
 * those must not be OCR'd. Yashoda's bills have 11–400 characters (a header).
 */
const OCR_MAX_NATIVE_CHARS = 800;
/**
 * Longest side of the image sent to OCR. A4 at 300 dpi is 3508 px; scans
 * saved with oversized pages would otherwise exceed the OCR engine's limit
 * ("Image dimensions are too large").
 */
const OCR_MAX_PIXELS = 4200;
/**
 * Some PDFs map a glyph (often the hyphen) to U+0000. PostgreSQL rejects NUL
 * in text, and no control character belongs in a label or value.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

class PdfReadError extends Error {}

/**
 * Share of the page area painted with images, from the operator list. Only
 * the scale of the current transform matters for area, so its determinant is
 * tracked rather than the full matrix.
 */
async function imageShare(page, OPS, pageArea) {
  const { fnArray, argsArray } = await page.getOperatorList();
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat]);
  let det = 1;
  const stack = [];
  let area = 0;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) {
      stack.push(det);
      const m = fn === OPS.paintFormXObjectBegin ? args?.[0] : null;
      if (m) det *= m[0] * m[3] - m[1] * m[2];
    } else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) {
      det = stack.length ? stack.pop() : 1;
    } else if (fn === OPS.transform) {
      det *= args[0] * args[3] - args[1] * args[2];
    } else if (imageOps.has(fn)) {
      area += Math.abs(det);
    }
  }
  return Math.min(1, area / pageArea);
}

async function renderPng(page, scale) {
  const { createCanvas } = require('@napi-rs/canvas');
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toBuffer('image/png');
}

/**
 * → { pageCount, pages: [{ page, width, height, items, charCount, scanned, ocr, ocrError? }] }
 * items: [{ str, x, y, w, h, ocr? }] in PDF points, y = baseline from the bottom.
 * options.ocr = false skips OCR (fast tests on text PDFs).
 */
async function readPdf(buffer, { ocr = true } = {}) {
  const pdfjs = await loadPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      verbosity: 0,
      isEvalSupported: false,
      disableFontFace: true,
    }).promise;
  } catch (err) {
    if (err?.name === 'PasswordException') throw new PdfReadError('The PDF is password-protected. Upload an unprotected copy.');
    throw new PdfReadError(`The file could not be read as a PDF (${err.message}).`);
  }

  try {
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items
        .map((it) => ({ ...it, str: typeof it.str === 'string' ? it.str.replace(CONTROL_CHARS, ' ') : '' }))
        .filter((it) => it.str.trim())
        .map((it) => ({
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          w: it.width,
          h: it.height || Math.abs(it.transform[3]) || 8,
        }));

      let ocrUsed = false;
      let ocrError;
      const nativeChars = items.reduce((n, it) => n + it.str.trim().length, 0);
      if (ocr && ocrAvailable() && nativeChars < OCR_MAX_NATIVE_CHARS) {
        const share = await imageShare(page, pdfjs.OPS, viewport.width * viewport.height);
        if (share >= OCR_IMAGE_SHARE) {
          try {
            const scale = Math.min(OCR_SCALE, OCR_MAX_PIXELS / Math.max(viewport.width, viewport.height));
            const result = await recognize(await renderPng(page, scale));
            items.push(...ocrToItems(result, { scale, pageHeight: viewport.height, nativeItems: items }));
            ocrUsed = true;
          } catch (err) {
            ocrError = err.message;
          }
        }
      }

      const charCount = items.reduce((n, it) => n + it.str.trim().length, 0);
      pages.push({
        page: p,
        width: viewport.width,
        height: viewport.height,
        items,
        charCount,
        scanned: charCount < SCANNED_PAGE_CHARS,
        ocr: ocrUsed,
        ...(ocrError ? { ocrError } : {}),
      });
      page.cleanup();
    }
    return { pageCount: doc.numPages, pages };
  } finally {
    await doc.destroy();
  }
}

module.exports = { readPdf, PdfReadError, SCANNED_PAGE_CHARS };
