import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const specDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(specDir, '..', '..');
const require = createRequire(path.join(repoRoot, 'package.json'));
const { installHookPlugin } = require(path.join(repoRoot, 'src', 'opencode-hook', 'installer.js'));

const LOAD_TIMEOUT_MS = 15000;
const SECRET_ENV_NAMES = ['FEISHU_APP_SECRET', 'FEISHU_APP_ID', 'WALKER_ADMIN_TOKEN', 'OPENCODE_SERVER_PASSWORD'];

function fail(stage, extra = {}) {
  const summary = {
    ok: false,
    stage,
    ...extra,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.exitCode = stage === 'cli-missing' ? 2 : 1;
}

function resolveOpencode() {
  const where = spawnSync('where.exe', ['opencode'], { encoding: 'utf8', windowsHide: true });
  const candidates = String(where.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.toLowerCase().endsWith('.exe') && fs.existsSync(candidate)) return candidate;
    const sibling = path.join(path.dirname(candidate), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
    if (fs.existsSync(sibling)) return sibling;
  }
  return '';
}

function redact(text, secrets) {
  let out = String(text || '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out
    .replace(/authorization["']?\s*[:=]\s*["']?bearer\s+\S+/gi, 'authorization:[redacted]')
    .replace(/("(?:text|password|token|secret)"\s*:\s*")[^"]*/gi, '$1[redacted]');
}

function assertInside(root, target, label) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(label + ' escaped temp root');
  }
}

const opencode = resolveOpencode();
if (!opencode) {
  fail('cli-missing', { command: 'opencode --version' });
  process.exit();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-v2-cli-probe-'));
const xdg = path.join(root, 'xdg');
const home = path.join(root, 'home');
const configDir = path.join(xdg, 'opencode');
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(home, { recursive: true });

const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ method: req.method || '', url: req.url || '' });
  res.writeHead(204);
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const probeToken = 'probe-' + Math.random().toString(36).slice(2);

let installed;
try {
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    installed = installHookPlugin({
      opencodeConfigDir: configDir,
      walkerPort: port,
      walkerToken: probeToken,
      enabled: true,
    });
  } finally {
    if (previousXdg == null) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  }
  if (!installed || !installed.path) throw new Error('installer returned no path');
  assertInside(root, installed.path, 'plugin');
  assertInside(root, configDir, 'config');
} catch (error) {
  server.close();
  fail('install-failed', { error: redact(error && error.message, [probeToken]) });
  process.exit();
}

const version = spawnSync(opencode, ['--version'], { encoding: 'utf8', windowsHide: true });
const env = {
  ...process.env,
  XDG_CONFIG_HOME: xdg,
  HOME: home,
  USERPROFILE: home,
  OPENCODE_CONFIG_DIR: configDir,
};
for (const name of ['OPENCODE_SERVER_URL', 'OPENCODE_CLI_CONFIG_CONTENT', ...SECRET_ENV_NAMES]) delete env[name];

const child = spawn(opencode, ['--standalone', '--print-logs', '--log-level', 'trace'], {
  env,
  cwd: root,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

const started = Date.now();
while (Date.now() - started < LOAD_TIMEOUT_MS && !seen.some((item) => item.url.includes('/opencode/tui-bridge/'))) {
  if (child.exitCode != null) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
await new Promise((resolve) => child.on('close', resolve));
server.close();

const redacted = redact(output, [probeToken, ...SECRET_ENV_NAMES.map((name) => process.env[name]).filter(Boolean)]);
let registeredPlugins = [];
try {
  const cli = JSON.parse(fs.readFileSync(path.join(configDir, 'cli.json'), 'utf8'));
  registeredPlugins = Array.isArray(cli.plugins)
    ? cli.plugins.map((entry) => (typeof entry === 'string' ? entry : (entry && entry.package) || '[object]'))
    : ['non-array'];
} catch (_) {
  registeredPlugins = ['unreadable'];
}
const evidence = redacted.split(/\r?\n/).filter((line) => {
  return /walker-tui-plugin|walker-tui-bridge|Plugin\.define|ERR_MODULE|Cannot find module|plugin reconciliation completed|failed to import|plugin load failed/i.test(line);
}).slice(0, 40);
const bridgeHit = seen.some((item) => item.url.includes('/opencode/tui-bridge/register') || item.url.includes('/opencode/tui-bridge/poll'));
const setupHit = evidence.some((line) => /stage=setup/.test(line) && /plugin=walker-tui-bridge/.test(line) && line.includes('walker-tui-plugin'));
const executed = bridgeHit || setupHit;
const importFailed = evidence.some((line) => /ERR_MODULE|Cannot find module|failed to import|plugin load failed/i.test(line));
const summary = {
  ok: executed,
  stage: executed ? 'loaded' : (importFailed ? 'import-failed' : 'entry-not-executed'),
  proof: bridgeHit ? 'register-or-poll' : (setupHit ? 'cli-setup-log' : 'none'),
  command: [opencode, '--standalone', '--print-logs', '--log-level', 'trace'].join(' '),
  version: String(version.stdout || version.stderr || '').trim(),
  versionExitCode: version.status,
  cliExitCode: child.exitCode,
  timeoutMs: LOAD_TIMEOUT_MS,
  configDir,
  installedPath: installed.path,
  registeredPlugins,
  bridgeRequests: seen.map((item) => item.method + ' ' + item.url),
  evidence,
  feishuRoundtrip: '未验证',
  note: bridgeHit ? '' : (setupHit ? '入口 setup 已执行；隔离启动没有会话，因此未观察到 register/poll' : ''),
};
fs.mkdirSync(path.join(specDir, 'evidence'), { recursive: true });
fs.writeFileSync(path.join(specDir, 'evidence', 'T2-cli-load.json'), JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
process.exitCode = executed ? 0 : 1;
