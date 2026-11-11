// requireManager: the Main Admin or a Unit Admin, as the database has them now —
// not as the sign-in token said, so a role or unit changed since sign-in counts
// at once. Sets req.scope = { all, unit } (src/user-scope.js).
const db = require('../db');
const { scopeOf } = require('../user-scope');

/** The caller's current row. */
async function currentUser(req) {
  const { rows } = await db.query('SELECT id, role, unit_code, is_active FROM users WHERE id = $1', [req.user.sub]);
  return rows[0] ?? null;
}

function requireManager(req, res, next) {
  currentUser(req)
    .then((user) => {
      const scope = scopeOf(user);
      if (!scope) return res.status(403).json({ error: 'Admin or Unit Admin access required' });
      req.scope = scope;
      return next();
    })
    .catch(next);
}

/** The codes of the units that exist. */
async function unitCodes() {
  const { rows } = await db.query('SELECT code FROM units ORDER BY code');
  return rows.map((r) => r.code);
}

module.exports = { requireManager, currentUser, unitCodes };
