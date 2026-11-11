// Who may see and manage whom, by hospital unit (the client, 2026-11-11). Pure:
// the routes load the rows (middleware/scope.js) and act on the answers.
//
//   Admin      the Main Admin: every unit — users of any role, all activity,
//              the team report of any unit or all of them; approved websites
//   UnitAdmin  one unit: adds and edits that unit's Users, sees that unit's
//              activity, audit log and team report
//   User       their own work only
//
// Every User and Unit Admin belongs to one unit; the Main Admin may have one.
// Users from before units existed have none until the Main Admin gives them one.

const ROLES = ['Admin', 'UnitAdmin', 'User'];

/** The caller as the database has them now → { all, unit } for a manager, else null. */
function scopeOf(user) {
  if (!user || !user.is_active) return null;
  if (user.role === 'Admin') return { all: true, unit: null };
  if (user.role === 'UnitAdmin' && user.unit_code) return { all: false, unit: user.unit_code };
  return null;
}

/** May this manager see that user (and their activity)? */
function canSee(scope, target) {
  return Boolean(scope && target && (scope.all || target.unit_code === scope.unit));
}

/** "smj" → "SMJ"; null / "" → null; undefined stays undefined (not sent). */
function unitArg(unit) {
  if (unit === undefined) return undefined;
  if (unit === null || String(unit).trim() === '') return null;
  return String(unit).trim().toUpperCase();
}

const needsUnit = (role) => role === 'User' || role === 'UnitAdmin';

/**
 * A new user as a manager asks for it → { role, unit } to insert, or { error }.
 * units: the unit codes that exist.
 */
function checkNewUser(scope, body, units) {
  const role = body?.role ?? 'User';
  if (!ROLES.includes(role)) return { error: `Role must be one of ${ROLES.join(', ')}` };
  if (!scope.all) {
    // A Unit Admin adds Users to their own unit, whatever unit was sent.
    if (role !== 'User') return { error: 'A Unit Admin can add Users only — ask the Main Admin for another admin' };
    return { role, unit: scope.unit };
  }
  const unit = unitArg(body?.unit) ?? null;
  if (unit && !units.includes(unit)) return { error: `Unknown unit "${unit}"` };
  if (!unit && needsUnit(role)) return { error: 'Choose the user\'s unit' };
  return { role, unit };
}

/**
 * A change to an existing user → { role?, unit? } to set (only what changes), or
 * { error, status }. 404 when the manager may not see the user at all, so another
 * unit's user ids are never confirmed.
 */
function checkUserUpdate(scope, actorId, target, body, units) {
  const role = body?.role;
  const unit = unitArg(body?.unit);
  if (role !== undefined && !ROLES.includes(role)) return { error: `Role must be one of ${ROLES.join(', ')}`, status: 400 };
  const self = target.id === actorId;
  if (self && (body?.isActive === false || (role !== undefined && role !== target.role))) {
    return { error: 'You cannot deactivate your own account or change your own role', status: 400 };
  }

  if (!scope.all) {
    // A Unit Admin: their unit's Users, and their own name and password.
    if (!canSee(scope, target) || (target.role !== 'User' && !self)) return { error: 'User not found', status: 404 };
    if ((role !== undefined && role !== target.role) || (unit !== undefined && unit !== target.unit_code)) {
      return { error: 'Only the Main Admin can change a user\'s role or unit', status: 403 };
    }
    return {};
  }

  const out = {};
  if (unit !== undefined && unit !== target.unit_code) {
    if (unit && !units.includes(unit)) return { error: `Unknown unit "${unit}"`, status: 400 };
    out.unit = unit;
  }
  if (role !== undefined && role !== target.role) out.role = role;
  // A User or Unit Admin needs a unit — checked when the role or unit changes, so a
  // user from before units existed can still be renamed or given a new password.
  if ((out.role !== undefined || out.unit !== undefined) && needsUnit(out.role ?? target.role) && !(out.unit !== undefined ? out.unit : target.unit_code)) {
    return { error: 'A User or Unit Admin must belong to a unit — choose one', status: 400 };
  }
  return out;
}

/**
 * The unit a report or list is for: a Unit Admin's own, whatever was asked;
 * the Main Admin's choice (?unit=SMJ), or every unit (null).
 */
function unitFilter(scope, asked) {
  if (!scope.all) return scope.unit;
  const unit = unitArg(asked);
  return unit || null;
}

module.exports = { ROLES, scopeOf, canSee, checkNewUser, checkUserUpdate, unitFilter };
