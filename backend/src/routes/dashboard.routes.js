const express = require('express');
const db = require('../db');
const { route } = require('./helpers');

const router = express.Router();

const DAY = 24 * 60 * 60 * 1000;

// GET /api/dashboard/stats — the caller's own bills read (TGNPDCL, PM-JAY, Coal
// India) and fills. Counts only: the bills themselves are never stored.
router.get('/stats', route(async (req, res) => {
  const userId = req.user.sub;
  const since = new Date(Date.now() - 30 * DAY);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [bills, fills, recent] = await Promise.all([
    db.query(
      `SELECT COUNT(*) FILTER (WHERE details->>'site' = 'tgnpdcl')::int AS tgnpdcl,
              COUNT(*) FILTER (WHERE details->>'site' = 'pmjay')::int AS pmjay,
              COUNT(*) FILTER (WHERE details->>'site' = 'cil')::int AS cil,
              COALESCE(SUM((details->>'files')::int), 0)::int AS pdfs,
              COALESCE(SUM((details->>'pages')::int), 0)::int AS pages,
              COUNT(*) FILTER (WHERE created_at >= $3)::int AS today_bills,
              COALESCE(SUM((details->>'files')::int) FILTER (WHERE created_at >= $3), 0)::int AS today_pdfs
         FROM audit_logs
        WHERE action = 'BILLS_READ' AND actor_user_id = $1 AND created_at >= $2`,
      [userId, since, today],
    ),
    db.query(
      `SELECT COUNT(*)::int AS fills, COALESCE(SUM(filled), 0)::int AS steps_done, COALESCE(SUM(failed), 0)::int AS steps_failed
         FROM fill_sessions WHERE user_id = $1 AND created_at >= $2`,
      [userId, since],
    ),
    db.query(
      `SELECT details->>'site' AS site, (details->>'files')::int AS pdfs, (details->>'pages')::int AS pages, created_at
         FROM audit_logs
        WHERE action = 'BILLS_READ' AND actor_user_id = $1
        ORDER BY created_at DESC, id DESC LIMIT 8`,
      [userId],
    ),
  ]);
  const b = bills.rows[0];
  const f = fills.rows[0];
  res.json({
    today: { bills: b.today_bills, pdfs: b.today_pdfs },
    last30Days: {
      bills: { tgnpdcl: b.tgnpdcl, pmjay: b.pmjay, cil: b.cil, total: b.tgnpdcl + b.pmjay + b.cil },
      pdfs: b.pdfs,
      pages: b.pages,
      fills: f.fills,
      stepsDone: f.steps_done,
      stepsFailed: f.steps_failed,
    },
    recentBills: recent.rows.map((r) => ({ site: r.site, pdfs: r.pdfs ?? 0, pages: r.pages ?? 0, at: r.created_at })),
  });
}));

module.exports = router;
