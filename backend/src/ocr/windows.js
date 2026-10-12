// OCR through Windows' built-in engine (Windows.Media.Ocr), driven by a
// PowerShell script. Local only. The page image is written to a temp file
// for the engine and deleted straight after — it contains patient data.

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, 'windows-ocr.ps1');
const TIMEOUT_MS = 120000;

function removeQuietly(file) {
  fs.promises.unlink(file).catch(() => {});
}

/** png: Buffer → { width, height, words: [{ t, x, y, w, h, line }] } in image pixels. */
function recognizePng(png) {
  const base = path.join(os.tmpdir(), `pfa-ocr-${crypto.randomUUID()}`);
  const imagePath = `${base}.png`;
  const outPath = `${base}.json`;
  fs.writeFileSync(imagePath, png);

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ImagePath', imagePath, '-OutPath', outPath],
      { windowsHide: true, timeout: TIMEOUT_MS },
      (err) => {
        try {
          if (!fs.existsSync(outPath)) {
            reject(new Error(`Windows OCR produced no result${err ? `: ${err.message}` : ''}`));
            return;
          }
          const data = JSON.parse(fs.readFileSync(outPath, 'utf8').replace(/^﻿/, ''));
          if (data.error) reject(new Error(`Windows OCR failed: ${data.error}`));
          else resolve({ width: data.width, height: data.height, words: [].concat(data.words || []) });
        } catch (parseErr) {
          reject(parseErr);
        } finally {
          removeQuietly(imagePath);
          removeQuietly(outPath);
        }
      },
    );
  });
}

module.exports = { recognizePng };
