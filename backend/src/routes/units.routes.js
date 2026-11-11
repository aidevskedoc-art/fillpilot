// GET /api/units — the hospital's units (code and name), for any signed-in user:
// the dashboard's unit lists and labels. Units are added in sql/schema.sql.
const express = require('express');
const db = require('../db');
const { route } = require('./helpers');

const router = express.Router();

router.get('/', route(async (req, res) => {
  const { rows } = await db.query('SELECT code, name FROM units ORDER BY name');
  res.json(rows);
}));

module.exports = router;
