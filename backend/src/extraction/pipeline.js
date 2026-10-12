// In-process processing queue: one document at a time, status advanced as it
// goes (uploaded → processing → extracting → validating → completed | failed).
// No Redis — documents left mid-way by a restart are re-queued at startup.

const fs = require('fs');
const db = require('../db');
const { absolutePath, deleteFile, keepPdf } = require('../storage');
const { getAliasIndex } = require('../aliases');
const { extractDocument, ExtractionError, PdfReadError } = require('./extract');

const queue = [];
let running = false;

function enqueue(documentId) {
  if (!queue.includes(documentId)) queue.push(documentId);
  setImmediate(drain);
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      try {
        await processDocument(id);
      } catch (err) {
        console.error(`[pipeline] document ${id} failed unexpectedly:`, err);
        await fail(id, 'Unexpected error while processing. Use Retry; if it keeps failing, contact support.').catch(() => {});
      }
    }
  } finally {
    running = false;
  }
}

function setStatus(id, status) {
  return db.query('UPDATE documents SET status = $2 WHERE id = $1', [id, status]);
}

function fail(id, reason) {
  return db.query(`UPDATE documents SET status = 'failed', failure_reason = $2, processed_at = now() WHERE id = $1`, [id, reason]);
}

async function processDocument(id) {
  const { rows } = await db.query('SELECT id, storage_path FROM documents WHERE id = $1', [id]);
  if (!rows[0]) return;

  await setStatus(id, 'processing');
  const buffer = await fs.promises.readFile(absolutePath(rows[0].storage_path));

  await setStatus(id, 'extracting');
  let result;
  try {
    result = await extractDocument(buffer, await getAliasIndex());
  } catch (err) {
    if (err instanceof ExtractionError || err instanceof PdfReadError) return fail(id, err.message);
    throw err;
  }

  await setStatus(id, 'validating');
  const keep = keepPdf();
  const { fields, tables, warnings, pageCount, docType, structured } = result;
  const avg = fields.length ? fields.reduce((s, f) => s + f.confidence, 0) / fields.length : null;

  await db.withTransaction(async (client) => {
    await client.query('DELETE FROM extracted_fields WHERE document_id = $1', [id]);
    await client.query('DELETE FROM extracted_tables WHERE document_id = $1', [id]);
    if (fields.length) {
      await client.query(
        `INSERT INTO extracted_fields
           (document_id, field_key, canonical_key, label, value_raw, value_normalized, value_type,
            confidence, method, page, bbox, validation, sort_order)
         SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                                  $8::numeric[], $9::text[], $10::int[], $11::jsonb[], $12::jsonb[], $13::int[])`,
        [
          id,
          fields.map((f) => f.fieldKey),
          fields.map((f) => f.canonicalKey),
          fields.map((f) => f.label),
          fields.map((f) => f.valueRaw),
          fields.map((f) => f.valueNormalized),
          fields.map((f) => f.valueType),
          fields.map((f) => f.confidence),
          fields.map((f) => f.method),
          fields.map((f) => f.page),
          fields.map((f) => JSON.stringify(f.bbox)),
          fields.map((f) => JSON.stringify(f.validation)),
          fields.map((f) => f.sortOrder),
        ],
      );
    }
    for (const t of tables) {
      await client.query('INSERT INTO extracted_tables (document_id, page, headers, rows) VALUES ($1, $2, $3, $4)', [
        id,
        t.page,
        JSON.stringify(t.headers),
        JSON.stringify(t.rows),
      ]);
    }
    await client.query(
      `UPDATE documents
          SET status = 'completed', failure_reason = NULL, page_count = $2, warnings = $3::jsonb,
              field_count = $4, avg_confidence = $5, doc_type = $6, structured = $7::jsonb, processed_at = now(),
              file_kept = $8
        WHERE id = $1`,
      [id, pageCount, JSON.stringify(warnings), fields.length, avg, docType || null, structured ? JSON.stringify(structured) : null, keep],
    );
  });

  // The data is saved — the PDF itself is no longer needed unless it is to be kept.
  if (!keep) {
    await deleteFile(rows[0].storage_path).catch((err) => console.error(`[pipeline] could not delete the PDF of document ${id}:`, err.message));
  }
}

/** Re-queues documents a restart interrupted. */
async function requeueUnfinished() {
  const { rows } = await db.query(
    `SELECT id FROM documents WHERE status IN ('uploaded', 'processing', 'extracting', 'validating') ORDER BY uploaded_at`,
  );
  rows.forEach((r) => enqueue(r.id));
  return rows.length;
}

module.exports = { enqueue, requeueUnfinished };
