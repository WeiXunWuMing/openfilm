/** Real chat and Studio, with only the agent IPC stubbed: no model calls or personal projects. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { filmHtml } from 'openfilm/film-doc';
import { DESKTOP, buildShell, prepare } from './app.mjs';
import { launcherEnvironment, loginShellEnvironment } from '../src/environment.mjs';

buildShell();
const dir = join(DESKTOP, '.dev', `media-summary-${Date.now()}`);
prepare(dir);
const project = join(dir, 'projects', 'film');
const source = join(dir, 'footage');
mkdirSync(join(project, 'assets'), { recursive: true });
mkdirSync(source);
const deep = join(source, ...Array.from({ length: 9 }, (_, i) => `level-${i + 1}`));
mkdirSync(deep, { recursive: true });
writeFileSync(join(deep, 'unscanned.mp4'), 'metadata only');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=', 'base64');
writeFileSync(join(source, 'first.png'), png);
writeFileSync(join(project, 'film.html'), filmHtml({ stage: { w: 1920, h: 1080 }, tracks: [] }));
symlinkSync(source, join(project, 'assets', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
writeFileSync(join(dir, 'home', 'links.json'), JSON.stringify({ places: [source] }));
const { PATH } = await loginShellEnvironment();
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'), args: [DESKTOP], cwd: DESKTOP,
  env: { ...launcherEnvironment(process.env, PATH), OPENFILM_DESKTOP_FLAVOR: 'bench', OPENFILM_BENCH_DIR: dir },
});

async function until(check, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  await until(async () => app.context().pages().find((page) => page.url().startsWith('http://127.0.0.1:')), 'Studio page');
  await app.evaluate(({ ipcMain }) => {
    globalThis.mediaMessages = [];
    globalThis.mediaAutoFinish = false;
    globalThis.mediaCancels = 0;
    const info = { sessionId: 'media-test', resumed: false, steering: true, agentInfo: { name: 'stub' }, authMethods: [], mcp: false, models: null, modes: null, configOptions: [] };
    const handlers = {
      'desktop:agents:list': () => [{ id: 'codex', name: 'Codex', status: 'ready', shown: true }],
      'desktop:local-agents:probe': () => ({ ok: true, info }),
      'desktop:local-agents:start': () => ({ ok: true, key: 'media-test', info }),
      'desktop:local-agents:prompt': (_event, opts) => {
        globalThis.mediaMessages.push({ kind: 'prompt', text: opts.text });
        if (globalThis.mediaAutoFinish) return { ok: true, stopReason: 'end_turn' };
        return new Promise((resolve) => { globalThis.mediaFinish = (stopReason = 'end_turn') => resolve({ ok: true, stopReason }); });
      },
      'desktop:local-agents:cancel': () => {
        globalThis.mediaCancels++;
        globalThis.mediaFinish?.('cancelled');
        return { ok: true };
      },
      'desktop:local-agents:steer': (_event, opts) => {
        globalThis.mediaMessages.push({ kind: 'steer', text: opts.text });
        return { ok: true, outcome: 'injected' };
      },
    };
    for (const [channel, handler] of Object.entries(handlers)) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler); }
  });
  const run = JSON.parse(readFileSync(join(dir, 'home', 'run.json'), 'utf8'));
  const opened = await fetch(`${run.origin}/api/open`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-key': run.key },
    body: JSON.stringify({ path: project, fallback: 0 }),
  });
  assert.equal(opened.status, 200);
  const page = await until(async () => app.context().pages().find((candidate) => candidate.url().includes('/projects/')), 'project page');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('[data-prompt-editor]');
  await app.evaluate(({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) contents.send('desktop:agents', [{ id: 'codex', name: 'Codex', status: 'ready', shown: true }]);
  });
  const submit = async (text) => {
    await page.locator('[data-prompt-editor]').click();
    await page.keyboard.insertText(text);
    await page.keyboard.press('Enter');
  };
  const send = async (text, count) => {
    await submit(text);
    await until(async () => (await app.evaluate(() => globalThis.mediaMessages.length)) >= count, `message ${count}`);
    await new Promise((done) => setTimeout(done, 350));
    return app.evaluate((_electron, index) => globalThis.mediaMessages[index], count - 1);
  };
  const first = await send('Check my footage', 1);
  assert.equal(first.kind, 'prompt');
  assert.match(first.text, /Listed files: 0 videos, 1 images/);
  assert.match(first.text, /Partial listing: 1 folders reached the depth limit/);
  assert.match(first.text, /"assets\/linked": available/);
  assert.doesNotMatch(first.text, /revision="unavailable"/);
  const unchanged = await send('Keep working', 2);
  assert.equal(unchanged.kind, 'steer');
  assert.equal(unchanged.text, 'Keep working');
  writeFileSync(join(source, 'second.png'), png);
  const changed = await send('I added an image', 3);
  assert.equal(changed.kind, 'steer');
  assert.match(changed.text, /0 videos, 2 images/);
  const offline = join(dir, 'offline');
  assert.equal(dirname(source), dir);
  assert.equal(dirname(offline), dir);
  renameSync(source, offline);
  const missing = await send('Check the links', 4);
  assert.match(missing.text, /0 available, 1 unavailable/);
  await app.evaluate(() => { globalThis.mediaAutoFinish = true; globalThis.mediaFinish(); });
  await new Promise((done) => setTimeout(done, 500));
  const next = await send('Anything else?', 5);
  assert.equal(next.kind, 'prompt');
  assert.equal(next.text, 'Anything else?');
  renameSync(offline, source);
  const recovered = await send('The disk is back', 6);
  assert.equal(recovered.kind, 'prompt');
  assert.match(recovered.text, /0 videos, 2 images/);
  assert.match(recovered.text, /1 available, 0 unavailable/);

  await page.evaluate(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      if (typeof input === 'string' && input.endsWith('/files') && options?.signal && globalThis.mediaBlockNextRead) {
        globalThis.mediaBlockNextRead = false;
        globalThis.mediaReadPending = true;
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
          globalThis.mediaReadAborted = true;
          reject(options.signal.reason);
        }, { once: true }));
      }
      return nativeFetch(input, options);
    };
  });
  const cancelRead = async (text, expectedCancels, expectedMessages) => {
    await page.evaluate(() => {
      globalThis.mediaBlockNextRead = true;
      globalThis.mediaReadPending = false;
      globalThis.mediaReadAborted = false;
    });
    await submit(text);
    await until(() => page.evaluate(() => globalThis.mediaReadPending), 'pending metadata');
    await page.keyboard.press('Escape');
    await until(() => page.evaluate(() => globalThis.mediaReadAborted), 'aborted metadata');
    await until(async () => (await app.evaluate(() => globalThis.mediaCancels)) === expectedCancels, 'agent cancelled');
    await new Promise((done) => setTimeout(done, 500));
    assert.equal(await app.evaluate(() => globalThis.mediaMessages.length), expectedMessages, 'no prompt or steering after cancellation');
  };
  await cancelRead('Stop before starting', 1, 6);
  const resumed = await send('Continue after stopping', 7);
  assert.equal(resumed.kind, 'prompt');
  assert.match(resumed.text, /<media_summary/, 'an unsent summary is retried on the next message');
  await app.evaluate(() => { globalThis.mediaAutoFinish = false; });
  await send('Keep editing', 8);
  await cancelRead('Stop before steering', 2, 8);
  await app.evaluate(() => { globalThis.mediaAutoFinish = true; });
  const afterSteerStop = await send('Continue after steering stop', 9);
  assert.equal(afterSteerStop.kind, 'prompt');
  assert.equal(afterSteerStop.text, 'Continue after steering stop');
  assert.deepEqual(errors, []);
  console.log('Media summary passed in the real chat: initial snapshot, unchanged steering, additions, offline link, recovery, depth limits, cancellation before prompt and steering, and normal conversation afterwards. No model was called.');
} finally {
  await app.close();
}
