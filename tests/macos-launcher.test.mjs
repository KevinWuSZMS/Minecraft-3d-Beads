import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

// This suite simulates macOS command-line tools on Git Bash/Unix. It does not
// execute a Darwin binary or establish real macOS/Terminal compatibility.
const exec = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = await fs.readFile(path.join(project, '启动.command'), 'utf8');
const serverSource = await fs.readFile(path.join(project, 'scripts/server.mjs'), 'utf8');
const version = 'v24.22.1';
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const shellPath = value => process.platform === 'win32'
  ? value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
  : value;
const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
let tools;
try {
  const {stdout} = await exec(bash, ['--noprofile', '--norc', '-c', 'command -v curl; command -v tar; command -v sha256sum || command -v shasum']);
  const [curl, tar, checksum] = stdout.trim().split(/\r?\n/);
  if (curl && tar && checksum) tools = {curl, tar, checksum};
} catch {}
const requiresBash = {skip: !tools && 'Requires Bash, curl, tar and SHA-256 tools for offline simulation'};

async function write(file, data, mode) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, data, {mode});
}
async function availablePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fixture(t, {arch = 'arm64', runtimeArch = arch === 'x86_64' ? 'x64' : arch, badChecksum = false, fallback = false, brokenServer = false} = {}) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.realpath(await fs.mkdtemp(path.join(temporaryRoot, 'MC3DBeads 中文 空格 ')));
  const root = path.join(directory, '项目 有空格');
  const bin = path.join(directory, '模拟 工具');
  const cwd = path.join(directory, '其他 目录');
  const events = path.join(directory, 'commands.log');
  const nativePid = path.join(root, '.cache', 'test-native.pid');
  await fs.mkdir(cwd, {recursive: true});
  t.after(async () => {
    // Only terminate the fixture's own process, never a port owner's process.
    try { process.kill(Number(await fs.readFile(nativePid, 'utf8'))); } catch {}
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot, 'Cleanup must stay within the fixture temporary directory');
    assert.ok(path.basename(directory).startsWith('MC3DBeads 中文 空格 '));
    await fs.rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  });
  await write(path.join(root, '启动.command'), launcher, 0o755);
  const recordPid = "import {writeFileSync as recordNativePid} from 'node:fs'; recordNativePid(new URL('../.cache/test-native.pid', import.meta.url), String(process.pid));\n";
  await write(path.join(root, 'scripts/server.mjs'), recordPid + (brokenServer ? "throw new Error('fixture startup failure');\n" : serverSource));
  for (const [file, data] of Object.entries({
    'public/index.html': '<!doctype html><title>Portable fixture</title>',
    'public/data/catalog.json': '[]',
    'public/data/palette.json': '[]',
    'public/vendor/three.module.js': '// fixture only',
    'runtime/node-version.txt': `${version}\n`,
  })) await write(path.join(root, file), data);
  await write(path.join(bin, 'uname'), `#!/bin/bash\ncase "$1" in -s) echo Darwin ;; -m) echo ${quote(arch)} ;; *) exit 1 ;; esac\n`, 0o755);
  for (const name of ['curl', 'tar']) await write(path.join(bin, name),
    `#!/bin/bash\nprintf '%s\\n' ${quote(name)}\" $*\" >> ${quote(shellPath(events))}\nexec ${quote(tools[name])} "$@"\n`, 0o755);
  await write(path.join(bin, 'open'), `#!/bin/bash\nprintf 'open %s\\n' "$*" >> ${quote(shellPath(events))}\n`, 0o755);
  await write(path.join(bin, 'node'), '#!/bin/bash\necho "System Node must not be used" >&2\nexit 99\n', 0o755);
  await write(path.join(bin, 'shasum'), tools.checksum.endsWith('sha256sum')
    ? `#!/bin/bash\n[ "$1" = -a ] && [ "$2" = 256 ] || exit 2\nshift 2\nexec ${quote(tools.checksum)} "$@"\n`
    : `#!/bin/bash\nexec ${quote(tools.checksum)} "$@"\n`, 0o755);
  // The archive contains a test shim which announces the bundled version then
  // delegates JS execution to the host Node. No network or runtime install.
  const shim = `#!/bin/bash\nif [ "\${1:-}" = --version ]; then printf '%s\\n' ${quote(version)}; else exec ${quote(shellPath(process.execPath))} "$@"; fi\n`;
  const runtimeName = `node-${version}-darwin-${runtimeArch}`;
  if (fallback) {
    await write(path.join(root, 'runtime/bin/node'), shim, 0o755);
  } else {
    const stage = path.join(directory, 'archive source');
    await write(path.join(stage, runtimeName, 'bin/node'), shim, 0o755);
    const archive = path.join(root, 'runtime', `${runtimeName}.tar.gz`);
    await exec(bash, ['--noprofile', '--norc', '-c', `${quote(tools.tar)} -czf ${quote(shellPath(archive))} -C ${quote(shellPath(stage))} ${quote(runtimeName)}`]);
    const checksum = badChecksum ? '0'.repeat(64) : createHash('sha256').update(await fs.readFile(archive)).digest('hex');
    await write(path.join(root, 'runtime/SHASUMS256.txt'), `${checksum}  ${runtimeName}.tar.gz\n`);
  }
  async function run(args = [], {timeout = 15000} = {}) {
    const command = `export PATH=${quote(shellPath(bin))}:$PATH; exec /bin/bash ${quote(shellPath(path.join(root, '启动.command')))} ${args.map(quote).join(' ')}`;
    try {
      const result = await exec(bash, ['--noprofile', '--norc', '-c', command], {cwd, timeout, encoding: 'utf8', maxBuffer: 1024 * 1024});
      return {...result, code: 0};
    } catch (error) {
      return {stdout: error.stdout || '', stderr: error.stderr || '', code: error.code, killed: error.killed};
    }
  }
  return {root, directory, events, nativePid, runtimeName, run};
}
const health = async port => (await fetch(`http://127.0.0.1:${port}/__mc3dbeads_health`)).json();

test('macOS launcher has LF endings and parses as Bash', requiresBash, async () => {
  assert.ok(!launcher.includes('\r'), 'The .command file must retain LF endings');
  await exec(bash, ['-n', shellPath(path.join(project, '启动.command'))]);
});

for (const arch of ['arm64', 'x86_64']) test(`offline ${arch} archive starts from a different cwd and reuses the exact project`, requiresBash, async t => {
  const fixtureData = await fixture(t, {arch});
  const {root, events, nativePid, runtimeName, run} = fixtureData;
  const port = await availablePort();
  const first = await run(['--port', String(port), '--no-browser']);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.deepEqual(await health(port), {app: 'MC3DBeads', root, port});
  const pid = await fs.readFile(nativePid, 'utf8');
  assert.ok(await fs.stat(path.join(root, '.cache/runtime', runtimeName, 'bin/node')));
  const firstEvents = await fs.readFile(events, 'utf8');
  assert.match(firstEvents, /tar -xzf /);
  assert.doesNotMatch(firstEvents, /^open /m);
  for (const line of firstEvents.split('\n').filter(line => line.startsWith('curl '))) {
    assert.match(line, new RegExp(`http://127\\.0\\.0\\.1:${port}/__mc3dbeads_health$`));
    assert.match(line, /--noproxy \*/);
  }
  const again = await run([`--port=${port}`]);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /已复用/);
  assert.equal(await fs.readFile(nativePid, 'utf8'), pid, 'Reuse must not launch a new server');
  const nextEvents = await fs.readFile(events, 'utf8');
  assert.equal(nextEvents.match(/^tar -xzf /gm)?.length, 1, 'Cache reuse must not extract again');
  assert.match(nextEvents, new RegExp(`^open http://127\\.0\\.0\\.1:${port}$`, 'm'));
});

test('runtime/bin/node works offline when an archive is absent', requiresBash, async t => {
  const {run} = await fixture(t, {fallback: true});
  const port = await availablePort();
  const result = await run(['--port', String(port), '--no-browser']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal((await health(port)).port, port);
});

test('invalid archive checksum stops before extraction or server launch', requiresBash, async t => {
  const {run, events, nativePid} = await fixture(t, {badChecksum: true});
  const result = await run(['--port', String(await availablePort()), '--no-browser']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /归档校验失败/);
  await assert.rejects(fs.stat(nativePid), {code: 'ENOENT'});
  assert.doesNotMatch(await fs.readFile(events, 'utf8').catch(() => ''), /tar -xzf/);
});

test('wrong app, root or port never reuses or terminates the port owner', requiresBash, async t => {
  const {root, run, nativePid} = await fixture(t);
  let response;
  const owner = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response)); });
  await new Promise(resolve => owner.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => owner.close(resolve)));
  const port = owner.address().port;
  for (const wrong of [
    {app: 'another-app', root, port},
    {app: 'MC3DBeads', root: path.join(root, 'other'), port},
    {app: 'MC3DBeads', root, port: port + 1},
  ]) {
    response = wrong;
    const result = await run(['--port', String(port), '--no-browser']);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /端口 .*已被其他程序或其他项目占用/);
    assert.equal(owner.listening, true);
    assert.deepEqual(await health(port), wrong);
  }
  await assert.rejects(fs.stat(nativePid), {code: 'ENOENT'});
});

test('invalid port and unsupported architecture give explicit errors', requiresBash, async t => {
  const {run} = await fixture(t, {arch: 'ppc', runtimeArch: 'arm64'});
  for (const port of ['0', '65536', '42x', '-1', '']) {
    const result = await run(['--port', port]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /端口必须/);
  }
  const result = await run(['--no-browser']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /不支持当前 Mac 处理器架构/);
});

test('server startup failures surface a project log instead of a success message', requiresBash, async t => {
  const {root, run} = await fixture(t, {brokenServer: true});
  const port = await availablePort();
  const result = await run(['--port', String(port), '--no-browser']);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /进程已退出/);
  assert.match(result.stderr, /server-\d+\.log/);
  assert.match(await fs.readFile(path.join(root, '.cache', `server-${port}.log`), 'utf8'), /fixture startup failure/);
  assert.doesNotMatch(result.stdout, /网站已启动/);
});
