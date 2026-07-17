'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PID_FILE = path.join(PROJECT_ROOT, 'walker.pid');
const LOG_DIR = path.join(PROJECT_ROOT, 'logs');
const OUT_LOG = path.join(LOG_DIR, 'walker.out.log');
const ERR_LOG = path.join(LOG_DIR, 'walker.err.log');

function readPidFile() {
  if (!fs.existsSync(PID_FILE)) return null;
  const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
  if (!raw) return null;
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function writePidFile(pid) {
  fs.writeFileSync(PID_FILE, String(pid), 'utf8');
}

function removePidFile() {
  try { fs.unlinkSync(PID_FILE); } catch (_) {}
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function start() {
  const existing = readPidFile();
  if (existing && isAlive(existing)) {
    console.log('walker is already running. PID=' + existing);
    return 0;
  }
  if (existing) removePidFile();

  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  const outFd = fs.openSync(OUT_LOG, 'a');
  const errFd = fs.openSync(ERR_LOG, 'a');
  const entry = path.join(PROJECT_ROOT, 'src', 'index.js');
  const child = spawn(process.execPath, [entry], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', outFd, errFd],
  });
  child.unref();
  writePidFile(child.pid);

  return new Promise((resolve) => {
    setTimeout(() => {
      if (isAlive(child.pid)) {
        console.log('walker started. PID=' + child.pid);
        console.log('stdout: ' + OUT_LOG);
        console.log('stderr: ' + ERR_LOG);
        resolve(0);
      } else {
        console.error('walker failed to stay running. See logs:');
        console.error('  ' + OUT_LOG);
        console.error('  ' + ERR_LOG);
        removePidFile();
        resolve(1);
      }
    }, 3000);
  });
}

function stop() {
  const pid = readPidFile();
  if (!pid) {
    console.log('walker is not running: walker.pid not found.');
    return Promise.resolve(0);
  }
  if (!isAlive(pid)) {
    removePidFile();
    console.log('walker was not running. Stale PID=' + pid);
    return Promise.resolve(0);
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log('walker stop signal sent. PID=' + pid);
  } catch (err) {
    console.error('failed to stop walker: ' + err.message);
    return Promise.resolve(1);
  }
  return new Promise((resolve) => {
    let waited = 0;
    const tick = () => {
      if (!isAlive(pid)) {
        removePidFile();
        console.log('walker stopped. PID=' + pid);
        resolve(0);
        return;
      }
      waited += 500;
      if (waited >= 10000) {
        console.log('walker did not exit within 10s, leaving pid file. PID=' + pid);
        resolve(1);
        return;
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

function status() {
  const pid = readPidFile();
  if (pid && isAlive(pid)) {
    console.log('status: running');
    console.log('pid: ' + pid);
  } else if (pid) {
    console.log('status: stopped');
    console.log('stale_pid: ' + pid);
  } else {
    console.log('status: stopped');
  }
  if (fs.existsSync(OUT_LOG)) {
    console.log('--- recent stdout ---');
    const lines = fs.readFileSync(OUT_LOG, 'utf8').split(/\r?\n/);
    console.log(lines.slice(-20).join('\n').trim());
  }
  if (fs.existsSync(ERR_LOG)) {
    console.log('--- recent stderr ---');
    const lines = fs.readFileSync(ERR_LOG, 'utf8').split(/\r?\n/);
    console.log(lines.slice(-20).join('\n').trim());
  }
  return Promise.resolve(0);
}

module.exports = { start, stop, status, isAlive, readPidFile, PID_FILE, OUT_LOG, ERR_LOG };
