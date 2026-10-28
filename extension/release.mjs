// npm run release -- http://<server>:4100
//
// The packed extension for the team's PCs, installed by hospital IT through
// Chrome's Group Policy "Configure the list of force-installed apps and
// extensions" — no Developer mode, and every PC updates by itself.
//
//   1. builds the extension for that server, with update_url pointing at it
//   2. packs it into fillpilot.crx with key.pem (Chrome's own packer), which
//      keeps the extension ID the server's CORS_ORIGIN already allows
//   3. writes updates.xml, the file Chrome reads to find new versions
//   4. puts both in backend/extension-release/, which the backend serves at
//      <server>/extension/ (restart the backend after the first release)
//
// For an update: raise "version" in manifest.json, run this again. Chrome on
// the PCs picks it up within a few hours (sooner after a restart).
//
// Needs Google Chrome on this PC and key.pem in this folder. Keep a copy of
// key.pem somewhere safe: without it, the installed extension can never be updated.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const fail = (message) => {
  console.error(`\nRelease failed: ${message}`);
  process.exit(1);
};

// "192.152.23.37", "192.152.23.37:4100" or "http://192.152.23.37:4100" → "http://192.152.23.37:4100" (the backend's port by default).
const given = (process.argv[2] || process.env.API_BASE || '').trim().replace(/\/+$/, '');
let server = /^https?:\/\//i.test(given) ? given : given && `http://${given}`;
if (server && !/:\d+$/.test(server) && /^http:/i.test(server)) server += ':4100';
if (!/^https?:\/\/[^/\s]+$/i.test(server)) {
  fail(`give the server address after "--", e.g.  npm.cmd run release -- http://192.152.23.37:4100${given ? `  (got "${given}")` : ''}`);
}

const pem = path.join(root, 'key.pem');
if (!fs.existsSync(pem)) fail(`${pem} is missing — it fixes the extension ID; copy it here from the PC that has it`);
if (!fs.existsSync(path.join(root, 'node_modules', 'react'))) fail('React is not installed — run  npm.cmd install  in the extension folder first');

const { version } = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

// The ID Chrome gives a packed extension: the first 16 bytes of the SHA-256 of
// its public key, each hex digit written as a letter a–p.
const publicKey = crypto.createPublicKey(fs.readFileSync(pem)).export({ type: 'spki', format: 'der' });
const id = [...crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16).toString('hex')]
  .map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
  .join('');

const updatesUrl = `${server}/extension/updates.xml`;
const crxUrl = `${server}/extension/fillpilot.crx`;

// 1. Build (build.mjs resolves OUT_DIR inside the extension folder).
const outRel = path.join('..', 'release', 'extension-pack', 'FillPilot');
const outDir = path.join(root, outRel);
const built = spawnSync(process.execPath, ['build.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, API_BASE: server, OUT_DIR: outRel, UPDATE_URL: updatesUrl, MODE: 'server' },
});
if (built.status !== 0) fail('the build did not finish (see above)');

// 2. Pack with Chrome. A throwaway profile keeps it from handing the job to a Chrome already open.
const chrome = [
  process.env.CHROME_PATH,
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
].find((p) => p && fs.existsSync(p));
if (!chrome) fail('Google Chrome was not found — set CHROME_PATH to chrome.exe');

const packed = `${outDir}.crx`;
fs.rmSync(packed, { force: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fillpilot-pack-'));
spawnSync(chrome, [`--pack-extension=${outDir}`, `--pack-extension-key=${pem}`, '--no-message-box', `--user-data-dir=${profile}`], { stdio: 'inherit' });
for (let i = 0; i < 60 && !fs.existsSync(packed); i++) await new Promise((r) => setTimeout(r, 500));
fs.rmSync(profile, { recursive: true, force: true });
if (!fs.existsSync(packed)) fail(`Chrome did not write ${packed}`);

// 3 + 4. The files the backend serves at /extension/.
const target = path.join(root, '..', 'backend', 'extension-release');
fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(packed, path.join(target, 'fillpilot.crx'));
fs.writeFileSync(path.join(target, 'updates.xml'), `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${crxUrl}' version='${version}' />
  </app>
</gupdate>
`);

console.log(`
FillPilot ${version} released for ${server}
  ${path.join(target, 'fillpilot.crx')}
  ${path.join(target, 'updates.xml')}

Check from another PC (after restarting the backend the first time):
  ${updatesUrl}

For hospital IT — Group Policy, Computer Configuration > Administrative Templates >
Google > Google Chrome > Extensions > "Configure the list of force-installed apps
and extensions", value:
  ${id};${updatesUrl}
`);
