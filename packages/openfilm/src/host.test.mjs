import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, windowsGpuFirst } from './host.mjs';
import { locate } from './shared.mjs';

test('cancelled media requests close their files so the project can be renamed', { timeout: 10000 }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'of-host-cancel-'));
  const root = join(scratch, 'film');
  mkdirSync(root);
  const data = Buffer.alloc(16 * 1024 * 1024);
  data.write('0123456789');
  writeFileSync(join(root, 'video.mp4'), data);
  const streams = [];
  const create = fs.createReadStream;
  const mocked = t.mock.method(fs, 'createReadStream', (...args) => {
    const stream = create(...args);
    streams.push(stream);
    return stream;
  });
  syncBuiltinESMExports();
  const site = await serve(root);
  try {
    const head = await fetch(`${site.url}/video.mp4`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(streams.length, 0, 'HEAD opens no file stream');
    const part = await fetch(`${site.url}/video.mp4`, { headers: { range: 'bytes=0-7' } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), '01234567');
    for (const range of [undefined, 'bytes=0-']) {
      await new Promise((done, fail) => {
        const req = get(`${site.url}/video.mp4`, { headers: range ? { range } : {} }, (res) => {
          res.on('error', () => {});
          res.once('data', () => { res.destroy(); done(); });
        });
        req.on('error', fail);
      });
      const stream = streams.at(-1);
      if (!stream.closed) await new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error('cancelled request left its file open')), 1500);
        stream.once('close', () => { clearTimeout(timer); done(); });
      });
      assert.equal(stream.closed, true, `${range ?? 'full'} request releases its file`);
    }
    await fs.promises.rename(root, join(scratch, 'renamed'));
    assert.equal(fs.existsSync(join(scratch, 'renamed', 'video.mp4')), true);
  } finally {
    for (const stream of streams) {
      stream.destroy();
      if (!stream.closed) await once(stream, 'close');
    }
    await site.close();
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('the served folder is all a page reads: no way out through .., a link or a malformed address', { skip: process.platform === 'win32' && 'links need Developer Mode on Windows' }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'of-host-'));
  const root = join(scratch, 'film');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets', 'a.txt'), 'mine');
  writeFileSync(join(scratch, 'secret.txt'), 'secret');
  /* a film from elsewhere can bring links to anywhere: to a file, and to a folder above it */
  symlinkSync(join(scratch, 'secret.txt'), join(root, 'assets', 'notes.txt'));
  symlinkSync(scratch, join(root, 'assets', 'up'));
  /* a link that stays inside is followed */
  symlinkSync(join(root, 'assets', 'a.txt'), join(root, 'same.txt'));
  const site = await serve(root);
  try {
    const get = async (path) => { const r = await fetch(site.url + path); return [r.status, await r.text()]; };
    assert.deepEqual(await get('/assets/a.txt'), [200, 'mine']);
    assert.deepEqual(await get('/same.txt'), [200, 'mine']);
    assert.equal((await get('/assets/notes.txt'))[0], 403);
    assert.equal((await get('/assets/up/secret.txt'))[0], 403);
    assert.notEqual((await get('/%2e%2e/secret.txt'))[1], 'secret');
    assert.notEqual((await get('/assets/..%2f..%2fsecret.txt'))[1], 'secret');
    assert.equal((await get('/%E0%A4%A'))[0], 400);
    assert.deepEqual(await get('/assets/a.txt'), [200, 'mine'], 'and it still serves');
  } finally {
    await site.close();
  }
});

test('look and render serve the film\'s project, never the folders around it', () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'of-work-')));
  const film = join(work, 'forked');
  mkdirSync(join(film, 'scenes'), { recursive: true });
  writeFileSync(join(film, 'film.html'), '{"stage":{"w":16,"h":9},"tracks":[]}');
  writeFileSync(join(film, 'scenes', 'title.html'), '<!doctype html>');
  mkdirSync(join(work, 'page'));
  writeFileSync(join(work, 'page', 'index.html'), '<!doctype html>');
  writeFileSync(join(work, '.env'), 'SECRET=1');
  const was = process.cwd();
  process.chdir(work);
  try {
    /* run from a folder that holds other things (a workspace, a home folder) */
    assert.equal(locate('forked').root, film);
    assert.equal(locate('forked/scenes/title.html').root, film, 'a scene page still reaches ../ inside its project');
    assert.equal(locate('page').root, join(work, 'page'), 'a page on its own is served from its own folder');
    /* a host that names the project serves it */
    assert.equal(locate(join(film, 'scenes', 'title.html'), film).root, film);
  } finally {
    process.chdir(was);
  }
});

const VULKAN = '--use-angle=vulkan', D3D11 = '--use-angle=d3d11';
const NVIDIA_VK = 'ANGLE (NVIDIA, Vulkan 1.4.351 (NVIDIA NVIDIA GeForce RTX 3060 Ti (0x00002489)), NVIDIA)';
const NVIDIA_D3D = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti (0x00002489) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const WARP = 'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)';
function gpuLauncher(vulkan = NVIDIA_VK, d3d11 = NVIDIA_D3D, failed = []) {
  const opened = [], closed = [], reads = [];
  const open = async (angle) => {
    const backend = angle[0] ?? 'default';
    opened.push(backend);
    if (failed.includes(backend)) throw new Error('no graphics driver');
    return { backend, close: async () => { closed.push(backend); } };
  };
  const pick = windowsGpuFirst(async (browser) => {
    reads.push(browser.backend);
    const value = browser.backend === VULKAN ? vulkan : d3d11;
    if (value instanceof Error) throw value;
    return value;
  });
  return { open, pick, opened, closed, reads };
}

test('Windows: D3D11 must report Vulkan’s GPU; selection is shared by concurrent and later launches', async () => {
  for (const reference of [NVIDIA_VK, NVIDIA_VK.replace('NVIDIA NVIDIA', 'NVIDIA')]) {
    for (const description of [NVIDIA_D3D, NVIDIA_D3D.replace(' (0x00002489)', ''), NVIDIA_D3D.replace('0x00002489', '0x2489'), NVIDIA_D3D.replace('RTX 3060', 'rtx  3060')]) {
      const l = gpuLauncher(reference, description);
      const browsers = await Promise.all([l.pick(l.open), l.pick(l.open), l.pick(l.open)]);
      assert.deepEqual(browsers.map(b => b.backend), [D3D11, D3D11, D3D11]);
      assert.deepEqual(l.opened, [VULKAN, D3D11, D3D11, D3D11]);
      assert.deepEqual(l.reads, [VULKAN, D3D11]);
      assert.deepEqual(l.closed, [VULKAN], 'the unused probe browser is closed');
    }
  }
});

test('Windows: a different hardware GPU or an unidentified D3D11 device retains Vulkan', async () => {
  for (const description of [
    'ANGLE (Intel, Intel(R) UHD Graphics 770 (0x00004680) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    NVIDIA_D3D.replace('3060 Ti', '5070 Laptop GPU'),
    NVIDIA_D3D.replace('0x00002489', '0x00002D58'),
    'ANGLE (NVIDIA, unknown device, D3D11)',
  ]) {
    const l = gpuLauncher(NVIDIA_VK, description);
    const browsers = await Promise.all([l.pick(l.open), l.pick(l.open)]);
    assert.deepEqual(browsers.map(b => b.backend), [VULKAN, VULKAN]);
    assert.deepEqual(l.opened, [VULKAN, D3D11, VULKAN]);
    assert.deepEqual(l.closed, [D3D11]);
    assert.deepEqual(l.reads, [VULKAN, D3D11]);
  }
});

test('Windows: unavailable or software D3D11 retains the working Vulkan browser', async () => {
  for (const [description, failed] of [[WARP, []], ['none', []], [new Error('page crashed'), []], [NVIDIA_D3D, [D3D11]]]) {
    const l = gpuLauncher(NVIDIA_VK, description, failed);
    assert.equal((await l.pick(l.open)).backend, VULKAN);
    assert.equal((await l.pick(l.open)).backend, VULKAN);
    assert.deepEqual(l.closed, failed.length ? [] : [D3D11]);
    assert.deepEqual(l.reads, failed.length ? [VULKAN] : [VULKAN, D3D11]);
  }
});

test('Windows: without hardware Vulkan no GPU match is assumed; fall back to Chromium’s default', async () => {
  for (const [description, failed] of [
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', []],
    [WARP, []], ['none', []], ['', []], [new Error('page crashed'), []], [NVIDIA_VK, [VULKAN]],
  ]) {
    const l = gpuLauncher(description, NVIDIA_D3D, failed);
    const browsers = await Promise.all([l.pick(l.open), l.pick(l.open)]);
    assert.deepEqual(browsers.map(b => b.backend), ['default', 'default']);
    assert.deepEqual(l.opened, [VULKAN, 'default', 'default']);
    assert.deepEqual(l.closed, failed.length ? [] : [VULKAN]);
    assert.deepEqual(l.reads, failed.length ? [] : [VULKAN]);
  }
  for (const description of ['ANGLE (NVIDIA, an unknown Vulkan description, NVIDIA)', 'ANGLE (NVIDIA, Vulkan 1.4.351 ( ), NVIDIA)']) {
    const l = gpuLauncher(description);
    assert.equal((await l.pick(l.open)).backend, VULKAN);
    assert.deepEqual(l.opened, [VULKAN], 'an unknown device keeps the existing hardware choice');
  }
});
