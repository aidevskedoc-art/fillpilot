// The Team report: per person, how many bills they read and filled with
// FillPilot in a period. Counts only — built from what is already recorded
// (audit_logs BILLS_READ / DOCUMENT_UPLOADED, fill_sessions), which holds no
// patient names, amounts or values. Used by GET /api/reports/team and by
// scripts/team-report.js (the same report as a CSV file, without the dashboard).
const db = require('./db');

/**
 * [from, to) → { from, to, rows }: every active user (so the ones not using
 * FillPilot show with zeros), and anyone since deactivated who did something
 * in the period.
 */
async function teamReport(from, to) {
  const { rows } = await db.query(
    `WITH bills AS (
       SELECT actor_user_id AS user_id,
              COUNT(*) FILTER (WHERE details->>'site' = 'tgnpdcl')::int AS tgnpdcl,
              COUNT(*) FILTER (WHERE details->>'site' = 'pmjay')::int AS pmjay,
              COUNT(*) FILTER (WHERE details->>'site' = 'cil')::int AS cil,
              COALESCE(SUM((details->>'files')::int), 0)::int AS pdfs,
              COALESCE(SUM((details->>'pages')::int), 0)::int AS pages
         FROM audit_logs
        WHERE action = 'BILLS_READ' AND created_at >= $1 AND created_at < $2
        GROUP BY actor_user_id
     ), uploads AS (
       SELECT actor_user_id AS user_id, COUNT(*)::int AS uploads
         FROM audit_logs
        WHERE action = 'DOCUMENT_UPLOADED' AND created_at >= $1 AND created_at < $2
        GROUP BY actor_user_id
     ), fills AS (
       SELECT user_id, COUNT(*)::int AS fills,
              COALESCE(SUM(filled), 0)::int AS steps_done, COALESCE(SUM(failed), 0)::int AS steps_failed
         FROM fill_sessions
        WHERE created_at >= $1 AND created_at < $2
        GROUP BY user_id
     ), seen AS (
       SELECT actor_user_id AS user_id, MAX(created_at) AS last_active
         FROM audit_logs
        WHERE action IN ('LOGIN', 'BILLS_READ', 'FORM_FILLED', 'DOCUMENT_UPLOADED')
        GROUP BY actor_user_id
     )
     SELECT u.id, u.username, u.full_name, u.role, u.is_active,
            b.tgnpdcl, b.pmjay, b.cil, b.pdfs, b.pages, up.uploads,
            f.fills, f.steps_done, f.steps_failed, s.last_active
       FROM users u
       LEFT JOIN bills b ON b.user_id = u.id
       LEFT JOIN uploads up ON up.user_id = u.id
       LEFT JOIN fills f ON f.user_id = u.id
       LEFT JOIN seen s ON s.user_id = u.id
      WHERE u.is_active OR b.user_id IS NOT NULL OR up.user_id IS NOT NULL OR f.user_id IS NOT NULL
      ORDER BY COALESCE(b.tgnpdcl + b.pmjay + b.cil, 0) DESC, COALESCE(f.fills, 0) DESC, u.full_name`,
    [from, to],
  );
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    rows: rows.map((r) => {
      const bills = { tgnpdcl: r.tgnpdcl || 0, pmjay: r.pmjay || 0, cil: r.cil || 0 };
      return {
        userId: r.id,
        username: r.username,
        fullName: r.full_name,
        role: r.role,
        isActive: r.is_active,
        bills: { ...bills, total: bills.tgnpdcl + bills.pmjay + bills.cil },
        pdfs: r.pdfs || 0,
        pages: r.pages || 0,
        uploads: r.uploads || 0,
        fills: r.fills || 0,
        stepsDone: r.steps_done || 0,
        stepsFailed: r.steps_failed || 0,
        lastActive: r.last_active,
      };
    }),
  };
}

module.exports = { teamReport };
