// Units (2026-11-11): who may see and manage whom — src/user-scope.js. No database.
//   npm.cmd run test-user-scope
const { scopeOf, canSee, checkNewUser, checkUserUpdate, unitFilter } = require('../src/user-scope');
const { check, checkTrue, done } = require('./lib/check');

const UNITS = ['HTC', 'MLK', 'SEC', 'SMJ'];
const main = { all: true, unit: null };
const smjAdmin = { all: false, unit: 'SMJ' };
const user = (id, role, unit, isActive = true) => ({ id, role, unit_code: unit, is_active: isActive });

// Scopes, as the database has the caller now.
check('scope: Main Admin sees every unit', scopeOf(user(1, 'Admin', null)), main);
check('scope: Unit Admin sees their unit', scopeOf(user(2, 'UnitAdmin', 'SMJ')), smjAdmin);
check('scope: a User, an inactive admin, a Unit Admin without a unit — no manager scope',
  [scopeOf(user(3, 'User', 'SMJ')), scopeOf(user(1, 'Admin', null, false)), scopeOf(user(4, 'UnitAdmin', null)), scopeOf(null)], [null, null, null, null]);
check('canSee: own unit yes, other unit and no unit no; Main Admin all',
  [canSee(smjAdmin, user(5, 'User', 'SMJ')), canSee(smjAdmin, user(6, 'User', 'HTC')), canSee(smjAdmin, user(7, 'User', null)), canSee(main, user(6, 'User', 'HTC'))],
  [true, false, false, true]);

// New users.
check('new: Main Admin adds a User to a unit (any case)', checkNewUser(main, { role: 'User', unit: 'smj' }, UNITS), { role: 'User', unit: 'SMJ' });
check('new: Main Admin adds a Unit Admin', checkNewUser(main, { role: 'UnitAdmin', unit: 'MLK' }, UNITS), { role: 'UnitAdmin', unit: 'MLK' });
check('new: Main Admin adds another Main Admin, no unit needed', checkNewUser(main, { role: 'Admin' }, UNITS), { role: 'Admin', unit: null });
check('new: a User needs a unit', checkNewUser(main, { role: 'User' }, UNITS).error, 'Choose the user\'s unit');
check('new: unknown unit refused', checkNewUser(main, { role: 'User', unit: 'XYZ' }, UNITS).error, 'Unknown unit "XYZ"');
check('new: unknown role refused', checkNewUser(main, { role: 'Boss', unit: 'SMJ' }, UNITS).error, 'Role must be one of Admin, UnitAdmin, User');
check('new: Unit Admin adds a User — always to their own unit', checkNewUser(smjAdmin, { role: 'User', unit: 'HTC' }, UNITS), { role: 'User', unit: 'SMJ' });
checkTrue('new: Unit Admin cannot add an admin', /Users only/.test(checkNewUser(smjAdmin, { role: 'UnitAdmin' }, UNITS).error || ''));
checkTrue('new: Unit Admin cannot add a Main Admin', /Users only/.test(checkNewUser(smjAdmin, { role: 'Admin' }, UNITS).error || ''));

// Changes.
const ravi = user(10, 'User', 'SMJ');
const htcUser = user(11, 'User', 'HTC');
const smjAdminRow = user(2, 'UnitAdmin', 'SMJ');
const otherSmjAdmin = user(12, 'UnitAdmin', 'SMJ');
const legacy = user(13, 'User', null);
check('update: Unit Admin renames their unit\'s User', checkUserUpdate(smjAdmin, 2, ravi, { fullName: 'Ravi K' }, UNITS), {});
check('update: Unit Admin cannot see another unit\'s User (404)', checkUserUpdate(smjAdmin, 2, htcUser, { fullName: 'X' }, UNITS), { error: 'User not found', status: 404 });
check('update: Unit Admin cannot edit another Unit Admin of the same unit (404)', checkUserUpdate(smjAdmin, 2, otherSmjAdmin, { isActive: false }, UNITS).status, 404);
check('update: Unit Admin changes their own password', checkUserUpdate(smjAdmin, 2, smjAdminRow, { password: 'new-secret-1' }, UNITS), {});
check('update: Unit Admin cannot move a User to another unit (403)', checkUserUpdate(smjAdmin, 2, ravi, { unit: 'HTC' }, UNITS).status, 403);
check('update: Unit Admin cannot make a User an admin (403)', checkUserUpdate(smjAdmin, 2, ravi, { role: 'UnitAdmin' }, UNITS).status, 403);
check('update: sending the same role and unit back is no change', checkUserUpdate(smjAdmin, 2, ravi, { role: 'User', unit: 'smj', fullName: 'Ravi' }, UNITS), {});
check('update: no one deactivates themselves', checkUserUpdate(main, 1, user(1, 'Admin', null), { isActive: false }, UNITS).status, 400);
check('update: no one changes their own role', checkUserUpdate(smjAdmin, 2, smjAdminRow, { role: 'User' }, UNITS).status, 400);
check('update: Main Admin moves a User to HTC', checkUserUpdate(main, 1, ravi, { unit: 'HTC' }, UNITS), { unit: 'HTC' });
check('update: Main Admin makes a User the Unit Admin', checkUserUpdate(main, 1, ravi, { role: 'UnitAdmin' }, UNITS), { role: 'UnitAdmin' });
check('update: Main Admin cannot take the unit off a User', checkUserUpdate(main, 1, ravi, { unit: null }, UNITS).status, 400);
check('update: Main Admin makes a User a Main Admin and clears the unit', checkUserUpdate(main, 1, ravi, { role: 'Admin', unit: '' }, UNITS), { unit: null, role: 'Admin' });
check('update: a user from before units can still get a new password', checkUserUpdate(main, 1, legacy, { password: 'new-secret-1' }, UNITS), {});
check('update: …and is given a unit', checkUserUpdate(main, 1, legacy, { unit: 'SEC' }, UNITS), { unit: 'SEC' });
check('update: unknown unit refused', checkUserUpdate(main, 1, ravi, { unit: 'XYZ' }, UNITS).status, 400);

// Report / list filters.
check('filter: Unit Admin always gets their own unit', [unitFilter(smjAdmin, 'HTC'), unitFilter(smjAdmin, undefined)], ['SMJ', 'SMJ']);
check('filter: Main Admin — the unit asked for, or all', [unitFilter(main, 'htc'), unitFilter(main, ''), unitFilter(main, undefined)], ['HTC', null, null]);

done('user-scope');
