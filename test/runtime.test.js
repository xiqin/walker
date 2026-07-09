const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { WindowsRuntime } = require('../src/runtime/windows-runtime');
const { WslRuntime } = require('../src/runtime/wsl-runtime');
const { createRuntime } = require('../src/runtime/runtime-factory');

class FakeChildProcess {
  constructor(opts) {
    this.pid = opts.pid || 12345;
    this.killed = false;
    this._opts = opts;
  }
  kill(sig) { this.killed = true; return true; }
  unref() {}
}

function makeMockSpawn(results) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const key = cmd + ' ' + (args || []).join(' ');
    const result = results[key] || results[cmd] || { pid: 12345 };
    if (result.error) throw result.error;
    const proc = new FakeChildProcess(result);
    return proc;
  };
  return { spawn, calls };
}

describe('WindowsRuntime', () => {
  it('spawn 传递命令和参数', () => {
    const mock = makeMockSpawn({});
    const rt = new WindowsRuntime({ spawn: mock.spawn });
    rt.spawn('node', ['--check', 'src/index.js']);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].cmd, 'node');
    assert.deepEqual(mock.calls[0].args, ['--check', 'src/index.js']);
  });

  it('spawn 传递 options.cwd', () => {
    const mock = makeMockSpawn({});
    const rt = new WindowsRuntime({ spawn: mock.spawn });
    rt.spawn('opencode', ['serve'], { cwd: 'H:\\walker' });
    assert.equal(mock.calls[0].opts.cwd, 'H:\\walker');
  });

  it('spawn 传递 options.env', () => {
    const mock = makeMockSpawn({});
    const rt = new WindowsRuntime({ spawn: mock.spawn });
    rt.spawn('opencode', ['serve'], { env: { PATH: '/usr/bin' } });
    assert.deepEqual(mock.calls[0].opts.env, { PATH: '/usr/bin' });
  });

  it('spawn 不加 wsl 前缀', () => {
    const mock = makeMockSpawn({});
    const rt = new WindowsRuntime({ spawn: mock.spawn });
    rt.spawn('opencode', ['serve']);
    assert.equal(mock.calls[0].cmd, 'opencode');
  });
});

describe('WslRuntime', () => {
  it('spawn 加 wsl.exe -d <distro> -- 前缀', () => {
    const mock = makeMockSpawn({});
    const rt = new WslRuntime({ spawn: mock.spawn, distro: 'Ubuntu-24.04' });
    rt.spawn('opencode', ['serve']);
    assert.equal(mock.calls[0].cmd, 'wsl.exe');
    assert.deepEqual(mock.calls[0].args.slice(0, 3), ['-d', 'Ubuntu-24.04', '--']);
    assert.equal(mock.calls[0].args[3], 'opencode');
    assert.deepEqual(mock.calls[0].args.slice(4), ['serve']);
  });

  it('spawn 传递 cwd 和 env', () => {
    const mock = makeMockSpawn({});
    const rt = new WslRuntime({ spawn: mock.spawn, distro: 'Ubuntu-24.04' });
    rt.spawn('opencode', ['serve'], { cwd: '/home/user/project', env: { HOME: '/home/user' } });
    assert.equal(mock.calls[0].opts.cwd, '/home/user/project');
    assert.deepEqual(mock.calls[0].opts.env, { HOME: '/home/user' });
  });

  it('缺少 distro 时抛错', () => {
    const mock = makeMockSpawn({});
    assert.throws(() => new WslRuntime({ spawn: mock.spawn }), /distro/);
  });
});

describe('WslRuntime resolveServerUrl', () => {
  it('优先使用配置的 serverUrl', async () => {
    const rt = new WslRuntime({ spawn: makeMockSpawn({}).spawn, distro: 'Ubuntu-24.04' });
    const url = await rt.resolveServerUrl({ configuredUrl: 'http://172.19.112.14:4096' });
    assert.equal(url, 'http://172.19.112.14:4096');
  });

  it('无配置时通过 hostname -I 探测 WSL IP', async () => {
    const mock = makeMockSpawn({});
    const rt = new WslRuntime({
      spawn: mock.spawn,
      distro: 'Ubuntu-24.04',
      exec: (cmd, args) => {
        if (cmd === 'wsl.exe' && args.includes('hostname')) {
          return '172.19.112.14  ';
        }
        throw new Error('unexpected exec');
      },
    });
    const url = await rt.resolveServerUrl({ configuredUrl: '', port: 4096 });
    assert.equal(url, 'http://172.19.112.14:4096');
  });

  it('探测失败时抛错包含 runtime 信息', async () => {
    const rt = new WslRuntime({
      spawn: makeMockSpawn({}).spawn,
      distro: 'Ubuntu-24.04',
      exec: () => { throw new Error('WSL not running'); },
    });
    await assert.rejects(
      () => rt.resolveServerUrl({ configuredUrl: '', port: 4096 }),
      { message: /WSL|runtime/i },
    );
  });
});

describe('createRuntime factory', () => {
  it('windows 类型返回 WindowsRuntime', () => {
    const rt = createRuntime('windows', { spawn: makeMockSpawn({}).spawn });
    assert.ok(rt instanceof WindowsRuntime);
  });

  it('wsl 类型返回 WslRuntime', () => {
    const rt = createRuntime('wsl', { spawn: makeMockSpawn({}).spawn, distro: 'Ubuntu-24.04' });
    assert.ok(rt instanceof WslRuntime);
  });

  it('未知类型抛错', () => {
    assert.throws(() => createRuntime('macos', {}), /unknown runtime/i);
  });
});
