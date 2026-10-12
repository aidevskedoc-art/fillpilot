// Document data is temporary: it is needed between reading a PDF and filling
// the form, not afterwards. A document goes when the person removes it
// ("Finished" in the panel, Delete in the dashboard) or when its retention
// date passes — checked at startup and then every hour.
// RETENTION_DAYS=0 disables expiry for new uploads.

const db = require('./db');
const { deleteFile } = require('./storage');
const { logAction } = require('./audit-log');

const HOUR_MS = 60 * 60 * 1000;

/**
 * Removes a document for good: the row (its extracted fields and tables go
 * with it), the PDF if it is still on disk, and its file name from the
 * activity log — file names often carry a patient's name or number.
 */
async function removeDocument(doc) {
  await db.query('DELETE FROM documents WHERE id = $1', [doc.id]);
  await deleteFile(doc.storage_path).catch((err) => console.error('[retention] could not delete file:', err.message));
  await db.query(
    `UPDATE audit_logs SET details = details - 'fileName'
      WHERE entity_type = 'document' AND entity_id = $1 AND details ? 'fileName'`,
    [String(doc.id)],
  );
}

async function sweepExpired() {
  const { rows } = await db.query(
    `SELECT id, user_id, storage_path FROM documents
      WHERE retention_expires_at IS NOT NULL AND retention_expires_at < now()`,
  );
  for (const doc of rows) {
    await removeDocument(doc);
    await logAction({ targetUserId: doc.user_id, entityType: 'document', entityId: doc.id, action: 'DOCUMENT_EXPIRED' });
  }
  if (rows.length) console.log(`[retention] deleted ${rows.length} expired document(s).`);
  return rows.length;
}

function armRetention() {
  const run = () => sweepExpired().catch((err) => console.error('[retention] sweep failed:', err.message));
  run();
  setInterval(run, HOUR_MS).unref();
}

module.exports = { removeDocument, sweepExpired, armRetention };
