const express = require('express');
const db = require('../db');
const { route, documentToApi } = require('./helpers');

const router = express.Router();

// GET /api/dashboard/stats — the caller's own documents and form-filling activity.
router.get('/stats', route(async (req, res) => {
  const userId = req.user.sub;
  const [counts, recent, fills] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS processed,
              COUNT(*) FILTER (WHERE status IN ('uploaded', 'processing', 'extracting', 'validating'))::int AS pending,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
              ROUND(AVG(avg_confidence) FILTER (WHERE status = 'completed'), 3) AS avg_confidence
         FROM documents WHERE user_id = $1`,
      [userId],
    ),
    db.query('SELECT * FROM documents WHERE user_id = $1 ORDER BY uploaded_at DESC LIMIT 5', [userId]),
    db.query(
      `SELECT COUNT(*)::int AS sessions, COALESCE(SUM(filled), 0)::int AS fields_filled,
              COALESCE(SUM(detected), 0)::int AS fields_detected
         FROM fill_sessions WHERE user_id = $1 AND created_at > now() - INTERVAL '30 days'`,
      [userId],
    ),
  ]);
  const c = counts.rows[0];
  res.json({
    documents: {
      total: c.total,
      processed: c.processed,
      pending: c.pending,
      failed: c.failed,
      avgConfidence: c.avg_confidence === null ? null : Number(c.avg_confidence),
    },
    recent: recent.rows.map(documentToApi),
    last30Days: {
      fillSessions: fills.rows[0].sessions,
      fieldsFilled: fills.rows[0].fields_filled,
      fieldsDetected: fills.rows[0].fields_detected,
    },
  });
}));

module.exports = router;
