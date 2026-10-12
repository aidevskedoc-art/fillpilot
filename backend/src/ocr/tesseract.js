// OCR through the Tesseract command-line program — for servers that are not
// Windows (Ubuntu: `sudo apt install tesseract-ocr`). Local only. The page
// image is written to a temp file for the program and deleted straight
// after — it contains patient data.
//
// Not measured against real bills yet: the bill readers (formats/yashoda.js)
// were tuned on the Windows engine's reading mistakes, and Tesseract makes
// different ones. Check a server with `node scripts/read-bills.js` before
// relying on it.
//
//   TESSERACT_CMD   the program (default "tesseract")
//   TESSERACT_LANG  language data to use (default "eng")
//   TESSERACT_PSM   page segmentation mode (default 6: one block of text —
//                   keeps the columns of a bill on their lines)

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CMD = process.env.TESSERACT_CMD || 'tesseract';
const LANG = process.env.TESSERACT_LANG || 'eng';
const PSM = process.env.TESSERACT_PSM || '6';
const TIMEOUT_MS = 120000;
/** Words Tesseract itself is this unsure of are noise more often than text. */
const MIN_CONFIDENCE = 20;

/**
 * Tesseract's TSV → words. One row per element; level 5 is a word:
 * level page block par line word left top width height conf text
 */
function parseTsv(tsv) {
  const words = [];
  const lines = new Map();
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    const text = c.slice(11).join('\t').trim();
    if (!text || Number(c[10]) < MIN_CONFIDENCE) continue;
    const lineKey = `${c[1]}.${c[2]}.${c[3]}.${c[4]}`;
    if (!lines.has(lineKey)) lines.set(lineKey, lines.size + 1);
    words.push({ t: text, x: Number(c[6]), y: Number(c[7]), w: Number(c[8]), h: Number(c[9]), line: lines.get(lineKey) });
  }
  return words;
}

/** Width and height from a PNG's header (IHDR is always the first chunk). */
function pngSize(png) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** png: Buffer → { width, height, words: [{ t, x, y, w, h, line }] } in image pixels. */
function recognizePng(png) {
  const imagePath = path.join(os.tmpdir(), `pfa-ocr-${crypto.randomUUID()}.png`);
  fs.writeFileSync(imagePath, png);
  return new Promise((resolve, reject) => {
    execFile(
      CMD,
      [imagePath, 'stdout', '-l', LANG, '--psm', PSM, '--dpi', '300', '-c', 'preserve_interword_spaces=1', 'tsv'],
      { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        fs.promises.unlink(imagePath).catch(() => {});
        if (err) {
          reject(new Error(err.code === 'ENOENT'
            ? 'Tesseract is not installed on this server (Ubuntu: sudo apt install tesseract-ocr).'
            : `Tesseract failed: ${err.message.split('\n')[0]}`));
          return;
        }
        resolve({ ...pngSize(png), words: parseTsv(stdout) });
      },
    );
  });
}

/** → the version line, or throws the same "not installed" message recognizePng gives. */
function version() {
  return new Promise((resolve, reject) => {
    execFile(CMD, ['--version'], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.code === 'ENOENT' ? 'Tesseract is not installed on this server (Ubuntu: sudo apt install tesseract-ocr).' : err.message));
      else resolve(String(stdout || stderr).split(/\r?\n/)[0]);
    });
  });
}

module.exports = { recognizePng, parseTsv, version };
