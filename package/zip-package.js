// Zips release/FillPilot into release/FillPilot.zip, ready to hand over.
// Uses Windows' own tar.exe, which writes a zip when the name ends in .zip (-a).
//
//   node package/zip-package.js      (after build-package.js)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RELEASE = path.resolve(__dirname, '..', 'release');
const folder = path.join(RELEASE, 'FillPilot');
const zip = path.join(RELEASE, 'FillPilot.zip');

if (!fs.existsSync(path.join(folder, 'FillPilot-Start.cmd'))) throw new Error('release/FillPilot is missing — run build-package.js first.');
// A package that was started here has this PC's passwords and database in it.
if (fs.existsSync(path.join(folder, 'data'))) throw new Error('release/FillPilot/data exists — this copy has been started. Stop it and delete the data folder (or rebuild) before zipping.');

fs.rmSync(zip, { force: true });
const tar = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
const made = spawnSync(tar, ['-a', '-c', '-f', zip, 'FillPilot'], { cwd: RELEASE, encoding: 'utf8' });
if (made.status !== 0 || !fs.existsSync(zip)) throw new Error(`tar.exe could not write the zip: ${(made.stderr || made.error?.message || '').trim()}`);
console.log(`${zip}  ${(fs.statSync(zip).size / 1048576).toFixed(0)} MB`);
