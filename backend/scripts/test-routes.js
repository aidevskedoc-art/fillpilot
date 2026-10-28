// npm run test-routes — HTTP-level checks against a real PostgreSQL.
// Uses a separate database (<PGDATABASE>_test, created if missing) so the
// dev data is never touched. Needs a fixture PDF in test-fixtures/.
process.env.PGDATABASE = `${process.env.PGDATABASE || 'pdf_form_db'}_test`;
process.env.STORAGE_DIR = './storage-test';
process.env.RETENTION_DAYS = '0';
process.env.KEEP_PDF = 'true';

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const app = require('../src/server');
const { seedAliasTable } = require('../src/aliases');
const { signToken } = require('../src/middleware/auth');
const { ensureStorageDir } = require('../src/storage');
const { sweepExpired } = require('../src/retention');
const { check, checkTrue, done } = require('./lib/check');

const FIXTURE = fs.readdirSync(path.join(__dirname, '..', 'test-fixtures')).find((f) => f.endsWith('.pdf'));

async function main() {
  await db.ensureDatabase();
  await db.ensureSchema();
  ensureStorageDir();
  await seedAliasTable();

  const suffix = Date.now();
  const mkUser = async (name, role) => {
    const { rows } = await db.query(
      `INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, 'x', $1, $2) RETURNING id`,
      [`${name}_${suffix}`, role],
    );
    return signToken({ sub: rows[0].id, username: name, role });
  };
  const adminToken = await mkUser('admin', 'Admin');
  const userToken = await mkUser('other', 'User');

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, token, body) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    let payload = body;
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  try {
    check('health is public', (await call('GET', '/api/health')).status, 200);
    check('API needs a token', (await call('GET', '/api/documents')).status, 401);

    // Upload → background extraction → completed.
    const form = new FormData();
    form.append('files', new Blob([fs.readFileSync(path.join(__dirname, '..', 'test-fixtures', FIXTURE))], { type: 'application/pdf' }), FIXTURE);
    form.append('files', new Blob(['not a pdf']), 'fake.pdf');
    const up = await call('POST', '/api/documents', adminToken, form);
    check('upload accepted', up.status, 202);
    check('non-PDF rejected by content', up.body.rejected.map((r) => r.error), ['Not a PDF file']);
    const docId = up.body.documents[0].id;

    let doc;
    for (let i = 0; i < 60; i++) {
      doc = (await call('GET', `/api/documents/${docId}`, adminToken)).body;
      if (['completed', 'failed'].includes(doc.status)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    check('extraction completed', doc.status, 'completed');
    checkTrue('fields extracted', doc.fieldCount > 5, String(doc.fieldCount));

    // Per-user scoping: another user can't see it (404, not 403).
    check('other user gets 404', (await call('GET', `/api/documents/${docId}`, userToken)).status, 404);
    check('other user cannot match it', (await call('POST', '/api/match', userToken, {
      documentIds: [docId], page: { origin: 'https://x.test', path: '/' }, fields: [{ ref: 'a', tag: 'input', type: 'text', label: 'Policy No' }],
    })).status, 403); // site not allowed is checked first

    // Matching is refused until the site is approved.
    const matchBody = {
      documentIds: [docId],
      page: { origin: `https://demo-${suffix}.test`, path: '/claims/123/new', title: 'Claim' },
      fields: [{ ref: 'f1', tag: 'input', type: 'text', label: 'Policy Number' }],
    };
    check('unapproved site refused', (await call('POST', '/api/match', adminToken, matchBody)).status, 403);
    check('only admin adds sites', (await call('POST', '/api/allowed-sites', userToken, { origin: matchBody.page.origin, displayName: 'Demo' })).status, 403);
    check('admin adds site', (await call('POST', '/api/allowed-sites', adminToken, { origin: `${matchBody.page.origin}/any/path`, displayName: 'Demo' })).status, 201);

    const match = await call('POST', '/api/match', adminToken, matchBody);
    check('match ok', match.status, 200);
    check('form key strips ids', match.body.formKey, '/claims/:id/new');
    checkTrue('policy number proposed', Boolean(match.body.fields[0].selected?.fillValue), JSON.stringify(match.body.fields[0]));

    // Saved mapping round trip.
    const sig = match.body.fields[0].signature;
    check('save mapping', (await call('POST', '/api/form-mappings', adminToken, {
      origin: matchBody.page.origin, path: matchBody.page.path, signature: sig, webFieldLabel: 'Policy Number', fieldKey: match.body.fields[0].selected.fieldKey,
    })).status, 201);
    const again = await call('POST', '/api/match', adminToken, matchBody);
    check('saved mapping used', again.body.fields[0].selected.source, 'saved');

    // Fill session audit.
    const fill = await call('POST', '/api/fill-sessions', adminToken, {
      documentIds: [docId], origin: matchBody.page.origin, path: matchBody.page.path, formTitle: 'Claim',
      fields: [{ label: 'Policy Number', fieldKey: 'policyNumber', confidence: 1, source: 'saved', outcome: 'filled' }],
    });
    check('fill session recorded', [fill.status, fill.body.filled], [201, 1]);

    // A failed step keeps its reason and the page outline.
    const failedFill = await call('POST', '/api/fill-sessions', adminToken, {
      documentIds: [docId], origin: matchBody.page.origin, path: matchBody.page.path, formTitle: 'Claim',
      fields: [{ label: 'Open tab', fieldKey: 'room', confidence: null, source: 'profile', outcome: 'failed', message: 'Tab not found' }],
      pageOutline: { tabs: [], captions: [{ probe: 'Next', text: 'Next', path: 'div.btn', pointer: true }] },
    });
    const failedDetail = (await call('GET', `/api/fill-sessions/${failedFill.body.id}`, adminToken)).body;
    check('failed step keeps reason + outline',
      [failedFill.status, failedDetail.failed, failedDetail.fields[0].message, failedDetail.pageOutline.captions[0].path],
      [201, 1, 'Tab not found', 'div.btn']);

    // Field edit is audited and becomes confidence 1.
    const fields = (await call('GET', `/api/documents/${docId}/fields`, adminToken)).body;
    const edited = await call('PATCH', `/api/documents/${docId}/fields/${fields[0].id}`, adminToken, { value: 'CHANGED' });
    check('field edit', [edited.body.valueRaw, edited.body.confidence, edited.body.edited], ['CHANGED', 1, true]);

    check('kept PDF is served', [doc.fileKept, (await fetch(`${base}/api/documents/${docId}/file`, { headers: { Authorization: `Bearer ${adminToken}` } })).status], [true, 200]);
    check('delete document', (await call('DELETE', `/api/documents/${docId}`, adminToken)).status, 204);
    check('deleted is gone', (await call('GET', `/api/documents/${docId}`, adminToken)).status, 404);
    const left = await db.query(
      `SELECT (SELECT COUNT(*)::int FROM extracted_fields WHERE document_id = $1) AS fields,
              (SELECT COUNT(*)::int FROM audit_logs WHERE entity_id = $2 AND details ? 'fileName') AS named_logs,
              (SELECT COUNT(*)::int FROM audit_logs WHERE entity_id = $2) AS logs`,
      [docId, docId],
    );
    check('nothing of it remains but the log entries, without its name', [left.rows[0].fields, left.rows[0].named_logs, left.rows[0].logs > 0], [0, 0, true]);

    // Expired documents are removed by the sweep.
    const form3 = new FormData();
    form3.append('files', new Blob([fs.readFileSync(path.join(__dirname, '..', 'test-fixtures', FIXTURE))], { type: 'application/pdf' }), FIXTURE);
    const id3 = (await call('POST', '/api/documents', adminToken, form3)).body.documents[0].id;
    for (let i = 0; i < 80; i++) {
      if (['completed', 'failed'].includes((await call('GET', `/api/documents/${id3}`, adminToken)).body.status)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await db.query(`UPDATE documents SET retention_expires_at = now() - interval '1 minute' WHERE id = $1`, [id3]);
    const swept = await sweepExpired();
    check('expired document swept', [swept >= 1, (await call('GET', `/api/documents/${id3}`, adminToken)).status], [true, 404]);

    // Bills for a site profile are read and handed back — no document row, no file, and a fill can be logged without one.
    const stored = async () => [
      (await db.query('SELECT COUNT(*)::int AS n FROM documents')).rows[0].n,
      fs.readdirSync(path.join(__dirname, '..', 'storage-test')).length,
    ];
    const before = await stored();
    const notBill = new FormData();
    notBill.append('files', new Blob([fs.readFileSync(path.join(__dirname, '..', 'test-fixtures', FIXTURE))], { type: 'application/pdf' }), FIXTURE);
    const refused = await call('POST', '/api/claims/tgnpdcl', adminToken, notBill);
    check('a PDF that is not a hospital bill is refused, and named', [refused.status, refused.body.documents.length], [422, 1]);
    const bills = ['yashoda-final-bill.pdf', 'yashoda-summary-bill.pdf'].map((f) => path.join(__dirname, '..', 'test-fixtures', f));
    const tgnpdclRead = bills.every((f) => fs.existsSync(f)) ? 1 : 0;
    if (tgnpdclRead) {
      const form4 = new FormData();
      for (const f of bills) form4.append('files', new Blob([fs.readFileSync(f)], { type: 'application/pdf' }), path.basename(f));
      const claim = await call('POST', '/api/claims/tgnpdcl', adminToken, form4);
      check('bills read into a claim', [claim.status, claim.body.documents.map((d) => d.docType), Boolean(claim.body.patient?.ipNo), claim.body.tabs.investigations.items.length > 10],
        [200, ['yashoda-final-bill', 'yashoda-summary-bill'], true, true]);
    }
    check('reading bills stored nothing', await stored(), before);
    const unlinked = await call('POST', '/api/fill-sessions', adminToken, {
      documentIds: [], origin: matchBody.page.origin, path: '/bill', formTitle: 'Bill',
      fields: [{ label: 'ICU Days', fieldKey: 'room', confidence: null, source: 'profile', outcome: 'filled' }],
    });
    check('a fill is logged without a stored document', [unlinked.status, unlinked.body.documentIds], [201, []]);

    // Team report: per person, counts for a period — Admin only; a user who did nothing is listed with zeros.
    await db.query(
      `INSERT INTO audit_logs (actor_user_id, entity_type, action, details)
       SELECT u.id, 'claim', 'BILLS_READ', d::jsonb FROM users u, unnest($2::text[]) AS d WHERE u.username = $1`,
      [`admin_${suffix}`, ['{"site":"cil","files":2,"pages":9}', '{"site":"pmjay","files":1,"pages":4}']],
    );
    const lastHour = `from=${encodeURIComponent(new Date(Date.now() - 3600e3).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60e3).toISOString())}`;
    check('only an Admin gets the team report', (await call('GET', `/api/reports/team?${lastHour}`, userToken)).status, 403);
    check('team report refuses a bad period', (await call('GET', '/api/reports/team?from=2026-10-10&to=2026-10-01', adminToken)).status, 400);
    const report = await call('GET', `/api/reports/team?${lastHour}`, adminToken);
    const row = (name) => report.body.rows.find((r) => r.username === `${name}_${suffix}`);
    check('team report counts per person', [report.status, row('admin').bills, row('admin').pdfs >= 3, row('admin').pages >= 13, row('admin').fills, row('admin').stepsDone, row('admin').stepsFailed],
      [200, { tgnpdcl: tgnpdclRead, pmjay: 1, cil: 1, total: 2 + tgnpdclRead }, true, true, 3, 2, 1]);
    check('team report lists a user who did nothing, with zeros', [row('other').bills.total, row('other').fills, row('other').pdfs], [0, 0, 0]);

    // Dashboard: the caller's own bills (per site) and fills — not anyone else's.
    const mine = (await call('GET', '/api/dashboard/stats', adminToken)).body;
    check('dashboard counts my bills and fills', [mine.last30Days.bills, mine.today.bills, mine.last30Days.fills, mine.last30Days.stepsDone, mine.recentBills.map((b) => b.site).sort()],
      [{ tgnpdcl: tgnpdclRead, pmjay: 1, cil: 1, total: 2 + tgnpdclRead }, 2 + tgnpdclRead, 3, 2, ['cil', 'pmjay', ...(tgnpdclRead ? ['tgnpdcl'] : [])]]);
    const theirs = (await call('GET', '/api/dashboard/stats', userToken)).body;
    check('dashboard shows another user only their own (none)', [theirs.last30Days.bills.total, theirs.last30Days.fills, theirs.recentBills], [0, 0, []]);

    // KEEP_PDF=false: the file goes as soon as its data is read; the data stays.
    process.env.KEEP_PDF = 'false';
    const form2 = new FormData();
    form2.append('files', new Blob([fs.readFileSync(path.join(__dirname, '..', 'test-fixtures', FIXTURE))], { type: 'application/pdf' }), FIXTURE);
    const id2 = (await call('POST', '/api/documents', adminToken, form2)).body.documents[0].id;
    let doc2;
    for (let i = 0; i < 80; i++) {
      doc2 = (await call('GET', `/api/documents/${id2}`, adminToken)).body;
      if (doc2.status === 'failed' || (doc2.status === 'completed' && !doc2.fileKept)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    check('PDF not kept after reading', [doc2.status, doc2.fileKept, fs.existsSync(path.join(__dirname, '..', 'storage-test', `${id2}.pdf`))], ['completed', false, false]);
    checkTrue('its data is still there', doc2.fieldCount > 5, String(doc2.fieldCount));
    check('no file to serve, no retry', [
      (await call('GET', `/api/documents/${id2}/file`, adminToken)).status,
      (await call('POST', `/api/documents/${id2}/retry`, adminToken)).status,
    ], [404, 409]);
    await call('DELETE', `/api/documents/${id2}`, adminToken);
  } finally {
    server.close();
    await db.pool.end();
  }
  done('routes');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
