// OCR for pages whose content is an image (e.g. Yashoda's final bill).
// Local only; nothing is sent anywhere.
//
// OCR_PROVIDER:
//   windows    the engine built into Windows 10/11 — nothing to install
//              (default on Windows)
//   tesseract  the Tesseract program — for Linux servers
//              (default everywhere else; Ubuntu: sudo apt install tesseract-ocr)
//   off        scanned pages are not read

const OCR_PROVIDER = (process.env.OCR_PROVIDER || (process.platform === 'win32' ? 'windows' : 'tesseract')).toLowerCase();

/** Render scale for OCR: 300 dpi (PDF units are 1/72 in). 216 dpi misread amounts in testing. */
const OCR_SCALE = 300 / 72;

function ocrAvailable() {
  return OCR_PROVIDER === 'tesseract' || (OCR_PROVIDER === 'windows' && process.platform === 'win32');
}

async function recognize(png) {
  if (!ocrAvailable()) throw new Error(`OCR is not available (OCR_PROVIDER=${OCR_PROVIDER}).`);
  return require(OCR_PROVIDER === 'tesseract' ? './tesseract' : './windows').recognizePng(png);
}

/** One line for a start-up log or a health check: which engine, and whether it is there. */
async function describe() {
  if (!ocrAvailable()) return `off (OCR_PROVIDER=${OCR_PROVIDER})`;
  if (OCR_PROVIDER === 'windows') return 'Windows built-in OCR';
  try {
    return await require('./tesseract').version();
  } catch (err) {
    return `NOT WORKING — ${err.message}`;
  }
}

module.exports = { ocrAvailable, recognize, describe, OCR_PROVIDER, OCR_SCALE };
