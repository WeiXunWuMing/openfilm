import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addLinkedPlaces } from './media-links.mjs';
import { mediaCommand } from './media-cli.mjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'of-media-'));
  assert.equal(dirname(realpathSync(base)), realpathSync(tmpdir()));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, 'film');
  mkdirSync(join(project, 'assets', 'cuts'), { recursive: true });
  writeFileSync(join(project, 'film.html'), '<!doctype html>');
  writeFileSync(join(project, 'assets', 'cuts', 'take.mp4'), 'metadata only');
  writeFileSync(join(project, 'assets', 'logo.png'), 'not decoded');
  return { base, project };
}

test('media metadata can be read from a project or its subfolder and scoped to a folder or a file', async (t) => {
  const { project } = fixture(t);
  const all = await mediaCommand([], { cwd: project });
  assert.equal(all.ok, true);
  assert.deepEqual(JSON.parse(all.lines[0]).files.map((file) => file.path), ['assets/cuts/take.mp4', 'assets/logo.png']);
  for (const path of ['assets/cuts', 'assets/cuts/take.mp4', 'assets\\cuts']) {
    const scoped = await mediaCommand([path], { cwd: join(project, 'assets', 'cuts') });
    assert.deepEqual(JSON.parse(scoped.lines[0]).files.map((file) => file.path), ['assets/cuts/take.mp4']);
  }
  for (const args of [['../outside'], ['/etc'], ['assets/../../outside'], ['assets', 'extra']]) {
    assert.equal((await mediaCommand(args, { cwd: project })).usage, true);
  }
});

test('linked folders are followed only when approved and an offline folder is reported unavailable', async (t) => {
  const { base, project } = fixture(t);
  const previousHome = process.env.OPENFILM_HOME;
  process.env.OPENFILM_HOME = join(base, 'home');
  t.after(() => { if (previousHome === undefined) delete process.env.OPENFILM_HOME; else process.env.OPENFILM_HOME = previousHome; });
  const source = join(base, 'source');
  mkdirSync(join(source, 'nested'), { recursive: true });
  writeFileSync(join(source, 'nested', 'clip.mp4'), 'footage');
  symlinkSync(source, join(project, 'assets', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const unapproved = JSON.parse((await mediaCommand([], { cwd: project })).lines[0]);
  assert.equal(unapproved.links['assets/linked'].missing, true);
  assert.ok(!unapproved.files.some((file) => file.path.endsWith('clip.mp4')));
  addLinkedPlaces([source]);
  const approved = JSON.parse((await mediaCommand(['assets/linked/nested'], { cwd: project })).lines[0]);
  assert.equal(approved.links['assets/linked'].missing, undefined);
  assert.deepEqual(approved.files.map((file) => file.path), ['assets/linked/nested/clip.mp4']);
  const offline = join(base, 'offline');
  assert.equal(dirname(source), base);
  assert.equal(dirname(offline), base);
  renameSync(source, offline);
  assert.equal(JSON.parse((await mediaCommand([], { cwd: project })).lines[0]).links['assets/linked'].missing, true);
});

test('an absent assets folder is empty, while one that cannot be enumerated is explicitly incomplete', async (t) => {
  const { base } = fixture(t);
  const project = join(base, 'empty');
  mkdirSync(project);
  writeFileSync(join(project, 'film.html'), '<!doctype html>');
  const empty = JSON.parse((await mediaCommand([], { cwd: project })).lines[0]);
  assert.deepEqual(empty.files, []);
  assert.equal(empty.unreadable, undefined);
  writeFileSync(join(project, 'assets'), 'not a directory');
  const incomplete = JSON.parse((await mediaCommand([], { cwd: project })).lines[0]);
  assert.deepEqual(incomplete.files, []);
  assert.deepEqual(incomplete.unreadable, ['assets']);
});

test('the depth limit stays in place and both local and approved linked folders report unscanned descendants', async (t) => {
  const { base, project } = fixture(t);
  const previousHome = process.env.OPENFILM_HOME;
  process.env.OPENFILM_HOME = join(base, 'home');
  t.after(() => { if (previousHome === undefined) delete process.env.OPENFILM_HOME; else process.env.OPENFILM_HOME = previousHome; });
  const levels = Array.from({ length: 8 }, (_, i) => `level-${i + 1}`);
  const source = join(base, 'source');
  const local = join(project, 'assets', ...levels);
  mkdirSync(join(local, 'beyond'), { recursive: true });
  writeFileSync(join(local, 'visible.mp4'), 'at the limit');
  writeFileSync(join(local, 'beyond', 'hidden.mp4'), 'not enumerated');
  mkdirSync(join(source, ...levels, 'beyond'), { recursive: true });
  writeFileSync(join(source, ...levels, 'beyond', 'hidden.mp4'), 'linked, not enumerated');
  symlinkSync(source, join(project, 'assets', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  addLinkedPlaces([source]);
  const all = JSON.parse((await mediaCommand([], { cwd: project })).lines[0]);
  assert.ok(all.files.some((file) => file.path.endsWith('/visible.mp4')));
  assert.ok(!all.files.some((file) => file.path.endsWith('/hidden.mp4')));
  assert.equal(all.links['assets/linked'].missing, undefined);
  const stopped = [`assets/${levels.join('/')}/beyond`, `assets/linked/${levels.join('/')}`].sort();
  assert.deepEqual(all.truncated, stopped);
  for (const path of stopped) {
    const query = path.endsWith('/beyond') ? `${path}/hidden.mp4` : `${path}/beyond/hidden.mp4`;
    const scoped = JSON.parse((await mediaCommand([query], { cwd: project })).lines[0]);
    assert.deepEqual(scoped.files, []);
    assert.deepEqual(scoped.truncated, [path], 'a deeper query keeps the ancestor that was not scanned');
  }
});

test('the actual media CLI prints JSON without starting Studio and rejects a non-project', (t) => {
  const { base, project } = fixture(t);
  const cli = fileURLToPath(new URL('../bin/openfilm.mjs', import.meta.url));
  const env = { ...process.env, OPENFILM_HOME: join(base, 'home') };
  delete env.OPENFILM_SHARED_HOME;
  const run = (cwd, ...args) => spawnSync(process.execPath, [cli, 'media', ...args], { cwd, env, encoding: 'utf8', windowsHide: true });
  const result = run(project, 'assets/cuts');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).files.map((file) => file.path), ['assets/cuts/take.mp4']);
  assert.equal(existsSync(join(base, 'home', 'run.json')), false);
  assert.equal(run(base).status, 2);
  const help = run(base, '--help');
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /approved linked folders/);
});
