// Builds the unpacked extension into dist/:
//   service-worker.js, content.js   (esbuild bundles of src/)
//   panel/panel.js                  (React side panel, src/panel/index.tsx)
//   panel/index.html, panel.css     (copied from src/panel/)
//   icons/icon-*.png                (copied from icons/; redraw them with icons/make-icons.cjs)
//   panel/config.json               ({ apiBase } read by the panel at startup)
//   manifest.json                   (__API_ORIGIN__ filled from API_BASE)
//
//   API_BASE=https://forms-api.example.com node build.mjs   (default http://localhost:4100)
//   node build.mjs --watch                                  (rebuild on change, unminified)
//
//   MODE=reader OUT_DIR=dist-reader node build.mjs
//     The build for PCs that run FillPilot from a folder (package/): no
//     server-side accounts or database. The sign-in and the activity log live
//     in the extension's own storage, and the approved websites are fixed
//     here (SITES='[{"origin":"https://…","displayName":"…"}]' to change them;
//     DEFAULT_LOGIN=user:password for the first sign-in).
import { context, build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, 'src');
const dist = path.join(root, process.env.OUT_DIR || 'dist');
const apiBase = (process.env.API_BASE || 'http://localhost:4100').replace(/\/+$/, '');
const apiOrigin = new URL(apiBase).origin;
const watch = process.argv.includes('--watch');

const mode = process.env.MODE === 'reader' ? 'reader' : 'server';
const [loginName, ...loginRest] = (process.env.DEFAULT_LOGIN || 'admin:admin').split(':');
const config = mode === 'reader'
  ? {
      apiBase,
      mode,
      sites: JSON.parse(process.env.SITES || '[{"origin":"https://essp.tgnpdcl.com","displayName":"TGNPDCL bill entry"}]'),
      defaultLogin: { username: loginName, password: loginRest.join(':') },
    }
  : { apiBase, mode };

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'panel'), { recursive: true });

const common = {
  bundle: true,
  target: 'chrome116',
  format: 'iife',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  // Extra package folders, as with Node's NODE_PATH (e.g. building before `npm install`).
  nodePaths: (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean),
};
const entries = [
  { entryPoints: [path.join(src, 'service-worker.ts')], outfile: path.join(dist, 'service-worker.js') },
  { entryPoints: [path.join(src, 'content', 'content.ts')], outfile: path.join(dist, 'content.js') },
  { entryPoints: [path.join(src, 'panel', 'index.tsx')], outfile: path.join(dist, 'panel', 'panel.js') },
];

function copyStatic() {
  for (const file of ['index.html', 'panel.css']) fs.copyFileSync(path.join(src, 'panel', file), path.join(dist, 'panel', file));
  fs.cpSync(path.join(root, 'icons'), path.join(dist, 'icons'), { recursive: true, filter: (file) => !file.endsWith('.cjs') });
  fs.writeFileSync(path.join(dist, 'panel', 'config.json'), JSON.stringify(config, null, 2));
  const manifest = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8').replaceAll('__API_ORIGIN__', apiOrigin);
  fs.writeFileSync(path.join(dist, 'manifest.json'), manifest);
}

copyStatic();
if (watch) {
  for (const e of entries) await (await context({ ...common, ...e })).watch();
  fs.watch(path.join(src, 'panel'), (_, file) => {
    if (file === 'index.html' || file === 'panel.css') copyStatic();
  });
  console.log(`Watching… (API ${apiBase}). Reload the extension in chrome://extensions after changes.`);
} else {
  for (const e of entries) await build({ ...common, ...e });
  console.log(`Extension built in ${dist} (API ${apiBase}, ${mode} mode). Load it via chrome://extensions → Developer mode → Load unpacked.`);
}
