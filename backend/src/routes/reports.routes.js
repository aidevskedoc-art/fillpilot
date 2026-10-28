// Reports for the Admin. Counts only — see src/team-report.js.
const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { teamReport } = require('../team-report');
const { route, httpError } = require('./helpers');

const router = express.Router();
router.use(requireAdmin);

const DAY = 24 * 60 * 60 * 1000;

/** ?from=&to= (ISO times, `to` exclusive) → Dates; the last 7 days when absent. */
function period(query) {
  const to = query.to ? new Date(String(query.to)) : new Date();
  const from = query.from ? new Date(String(query.from)) : new Date(to.getTime() - 7 * DAY);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw httpError(400, 'from and to must be dates');
  if (from >= to) throw httpError(400, '"from" must be before "to"');
  return { from, to };
}

// GET /api/reports/team?from=&to=
router.get('/team', route(async (req, res) => {
  const { from, to } = period(req.query);
  res.json(await teamReport(from, to));
}));

module.exports = router;
