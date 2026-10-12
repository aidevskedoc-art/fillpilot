// Uploaded PDFs on disk. Paths in the DB are relative to STORAGE_DIR, so the
// folder can move without a data migration.
//
// KEEP_PDF=false: a PDF stays here only while it is being read, and is deleted
// as soon as its data is in the database (it cannot then be previewed or
// re-read — upload it again). A PDF whose reading failed is kept for Retry.

const fs = require('fs');
const path = require('path');

const STORAGE_DIR = path.resolve(__dirname, '..', process.env.STORAGE_DIR || './storage');

/** Read on each use, so a test can switch it. */
const keepPdf = () => !/^(false|0|no|off)$/i.test(String(process.env.KEEP_PDF ?? 'true').trim());

function ensureStorageDir() {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

function absolutePath(relative) {
  const full = path.resolve(STORAGE_DIR, relative);
  if (!full.startsWith(STORAGE_DIR + path.sep)) throw new Error('Invalid storage path');
  return full;
}

async function saveFile(name, buffer) {
  await fs.promises.writeFile(absolutePath(name), buffer, { flag: 'wx' });
  return name;
}

async function deleteFile(relative) {
  try {
    await fs.promises.unlink(absolutePath(relative));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = { STORAGE_DIR, keepPdf, ensureStorageDir, absolutePath, saveFile, deleteFile };
