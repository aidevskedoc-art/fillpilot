// Assembles release/FillPilot — the folder a client PC runs FillPilot from
// without installing anything: Node.js, the reading service, the extension
// (built in "reader" mode) and the start/stop files. No database: the
// sign-in and the activity log live in the extension's own storage.
//
//   node package/build-package.js
//   node package/zip-package.js      (then: release/FillPilot.zip)
//
// The extension build needs React. If extension/node_modules has none yet,
// set NODE_PATH to a folder that does before running this.
//
// The package holds one program only — node.exe, which is digitally signed.
// That matters: PCs that stop unsigned programs outside trusted folders
// killed an earlier package that carried PostgreSQL.
//
// Only what is listed here is copied. Settings (.env), uploaded or sample
// PDFs, logs and tests never go into the package — the last step checks it.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'release', 'FillPilot');
const log = (line) => console.log(line);

function walk(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else found.push(full);
  }
  return found;
}
const megabytes = (files) => (files.reduce((n, f) => n + fs.statSync(f).size, 0) / 1048576).toFixed(0);

if (!fs.existsSync(path.join(REPO, 'backend', 'node_modules', 'express'))) throw new Error('backend/node_modules is missing — run npm install in backend first.');

// 1. The extension, built for an installation without a server-side database.
const built = spawnSync(process.execPath, ['build.mjs'], {
  cwd: path.join(REPO, 'extension'),
  env: { ...process.env, MODE: 'reader', OUT_DIR: 'dist-reader', API_BASE: 'http://localhost:4100' },
  encoding: 'utf8',
});
if (built.status !== 0) throw new Error(`The extension did not build:\n${built.stdout}\n${built.stderr}`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.cpSync(path.join(REPO, 'extension', 'dist-reader'), path.join(OUT, 'extension'), { recursive: true });

// 2. Node.js — the one running this script. It is a single, signed file.
fs.mkdirSync(path.join(OUT, 'runtime', 'node'), { recursive: true });
fs.copyFileSync(process.execPath, path.join(OUT, 'runtime', 'node', 'node.exe'));
log(`Node.js ${process.version}`);

// 3. The reading service: source and its packages. No schema, no seed data, no scripts.
const backend = path.join(OUT, 'app', 'backend');
for (const part of ['src', 'node_modules']) fs.cpSync(path.join(REPO, 'backend', part), path.join(backend, part), { recursive: true });
fs.copyFileSync(path.join(REPO, 'backend', 'package.json'), path.join(backend, 'package.json'));
fs.copyFileSync(path.join(__dirname, 'launcher.js'), path.join(OUT, 'app', 'launcher.js'));

// 4. The files the person double-clicks and reads. Windows line endings: cmd.exe and Notepad both expect them.
for (const file of ['FillPilot-Start.cmd', 'FillPilot-Stop.cmd', 'README.txt']) {
  fs.writeFileSync(path.join(OUT, file), fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/\r?\n/g, '\r\n'));
}

// 5. Nothing private may be in it, and nothing that is not a signed program may run from it.
const all = walk(OUT);
const ours = (f) => !/[\\/]node_modules[\\/]/.test(f);
const private_ = all.filter((f) => /\.pdf$/i.test(f) || /(^|[\\/])\.env(\.|$)/.test(f) || /\.pem$/i.test(f)
  || (ours(f) && (/[\\/](storage|storage-test|test-fixtures)[\\/]/.test(f) || /\.log$/i.test(f))));
if (private_.length) {
  for (const f of private_) log(`PRIVATE FILE IN PACKAGE: ${path.relative(OUT, f)}`);
  throw new Error('The package contains files that must not leave this PC — nothing was finished.');
}
const programs = all.filter((f) => /\.exe$/i.test(f)).map((f) => path.relative(OUT, f));
const config = JSON.parse(fs.readFileSync(path.join(OUT, 'extension', 'panel', 'config.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'extension', 'manifest.json'), 'utf8'));
if (config.mode !== 'reader') throw new Error('The packaged extension is not the reader build.');

log(`Programs in the package: ${programs.join(', ')}`);
log(`Extension: ${manifest.name} ${manifest.version}, ${config.mode} mode, calls ${config.apiBase}, sites ${config.sites.map((s) => s.origin).join(', ')}`);
log(`Size: ${megabytes(all)} MB in ${all.length} files — no PDFs, .env files, keys, logs or test data.`);
log(`Ready: ${OUT}`);
