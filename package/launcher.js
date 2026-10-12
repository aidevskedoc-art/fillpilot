// FillPilot launcher — runs the FillPilot reader straight from this folder.
// Nothing is installed and no administrator rights are needed: it runs as the
// signed-in user with the Node.js in this folder, answers this PC only
// (127.0.0.1), and stores nothing — no database, no bills. The only thing it
// writes is its own log in data\logs. Deleting the FillPilot folder removes
// it completely.
//
//   node launcher.js start    starts the reader and keeps it running
//   node launcher.js stop     stops it
//   node launcher.js check    can this PC read scanned PDFs (Windows OCR)?
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(__dirname, 'backend');
const LOGS = path.join(ROOT, 'data', 'logs');
const PID_FILE = path.join(ROOT, 'data', 'server.pid');

/** The extension's fixed ID (the "key" in its manifest) — the only caller the reader answers. */
const EXTENSION_ORIGIN = 'chrome-extension://fjikihdjljokehgbcjdccbojpogdmadc';
/** The address the extension is built to call. */
const PORT = 4100;

const say = (line = '') => console.log(line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  say();
  say(`  PROBLEM: ${message}`);
  process.exitCode = 1;
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/** → 'reader' when this reader answers, 'other' when something else does, null when nothing does. */
async function running() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    const body = await res.json().catch(() => ({}));
    return res.ok && body.mode === 'reader' ? 'reader' : 'other';
  } catch {
    return null;
  }
}

/** Reads a small test image with the engine built into Windows — the one thing FillPilot cannot bring along. */
async function checkOcr() {
  try {
    const { createCanvas } = require(path.join(BACKEND, 'node_modules', '@napi-rs', 'canvas'));
    const canvas = createCanvas(900, 220);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 900, 220);
    ctx.fillStyle = '#000000';
    ctx.font = '72px Arial';
    ctx.fillText('BILL TOTAL 48215', 60, 135);
    const { recognize } = require(path.join(BACKEND, 'src', 'ocr'));
    const read = (await recognize(canvas.toBuffer('image/png'))).words.map((w) => w.t).join(' ');
    return /48215/.test(read.replace(/\s/g, '')) ? null : `it read "${read}" instead of the test text`;
  } catch (err) {
    return err.message;
  }
}

async function start() {
  say();
  say('  FillPilot');
  say('  =========');
  const already = await running();
  if (already === 'reader') {
    say('  FillPilot is already running on this PC. Nothing to do.');
    return;
  }
  if (already || !(await portFree(PORT))) {
    return fail(`Another program is using port ${PORT} on this PC. Close it, then start FillPilot again.`);
  }

  fs.mkdirSync(LOGS, { recursive: true });
  say('  Starting…');
  const log = fs.openSync(path.join(LOGS, 'server.log'), 'a');
  const server = spawn(process.execPath, ['src/reader-server.js'], {
    cwd: BACKEND,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CORS_ORIGIN: EXTENSION_ORIGIN, NODE_ENV: 'production' },
    windowsHide: true,
    stdio: ['ignore', log, log],
  });
  fs.writeFileSync(PID_FILE, `${server.pid}\n${process.pid}\n`);
  let exited = false;
  server.once('exit', () => { exited = true; });

  let stopping = false;
  const shutDown = (code = 0) => {
    if (stopping) return;
    stopping = true;
    say();
    say('  Stopping FillPilot…');
    try { server.kill(); } catch { /* already gone */ }
    fs.rmSync(PID_FILE, { force: true });
    process.exit(code);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(signal, () => shutDown(0));

  for (let i = 0; i < 60 && !exited && (await running()) !== 'reader'; i++) await sleep(500);
  if (exited || (await running()) !== 'reader') {
    try { server.kill(); } catch { /* already gone */ }
    fs.rmSync(PID_FILE, { force: true });
    return fail(`FillPilot did not start. Send the file ${path.join(LOGS, 'server.log')} to your support contact.`);
  }

  const ocrProblem = await checkOcr();
  say();
  say('  FillPilot is running.');
  say(ocrProblem
    ? `    Reading scanned bills: NOT WORKING on this PC — ${ocrProblem}`
    : '    Reading scanned bills: working');
  say('    Nothing is stored on this PC: no database, no bills.');
  say();
  say('  Keep this window open while you work. Close it to stop FillPilot.');

  server.once('exit', () => {
    if (stopping) return;
    say();
    say('  FillPilot stopped unexpectedly (see data\\logs\\server.log).');
    shutDown(1);
  });
}

function stop() {
  say();
  if (fs.existsSync(PID_FILE)) {
    for (const pid of fs.readFileSync(PID_FILE, 'utf8').split(/\s+/).filter(Boolean)) {
      spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
    fs.rmSync(PID_FILE, { force: true });
  }
  say('  FillPilot is stopped.');
}

const command = process.argv[2] || 'start';
if (command === 'start') start();
else if (command === 'stop') stop();
else if (command === 'check') {
  checkOcr().then((problem) => say(problem ? `  Reading scanned bills: NOT WORKING — ${problem}` : '  Reading scanned bills: working'));
} else say('  Usage: launcher.js start | stop | check');
