/** Native voice-option regressions with a fake agent and ElevenLabs; never sends a paid request. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { filmHtml } from 'openfilm/film-doc';
import { DESKTOP, buildShell, prepare } from './app.mjs';
import { launcherEnvironment, loginShellEnvironment } from '../src/environment.mjs';

buildShell();
const dir = join(DESKTOP, '.dev', `voice-options-${Date.now()}`);
prepare(dir);
const film = join(dir, 'projects', 'sample');
mkdirSync(film);
writeFileSync(join(film, 'film.html'), filmHtml({ stage: { w: 1920, h: 1080 }, tracks: [] }));
const sample = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=sample_rate=44100:channel_layout=mono', '-t', '3', '-f', 'mp3', 'pipe:1'], { windowsHide: true });
const voice = { voiceId: 'voice-1', name: '林晓', language: 'zh', description: null, previewUrl: null };
const { PATH } = await loginShellEnvironment();
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)('electron'), args: [DESKTOP], cwd: DESKTOP,
  env: { ...launcherEnvironment(process.env, PATH), OPENFILM_DESKTOP_FLAVOR: 'bench', OPENFILM_BENCH_DIR: dir },
});
let page;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    page = app.context().pages().find((p) => p.url().startsWith('http://127.0.0.1:'));
    if (page) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(page);
  const run = JSON.parse(readFileSync(join(dir, 'home/run.json'), 'utf8'));
  const response = await fetch(`${run.origin}/api/open`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-studio-key': run.key },
    body: JSON.stringify({ path: film, fallback: 0 }),
  });
  assert.equal(response.status, 200);
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = app.context().pages().find((p) => p.url().includes('/projects/'));
    if (candidate) { page = candidate; break; }
    await new Promise((done) => setTimeout(done, 100));
  }
  await page.waitForSelector('[data-prompt-editor]');
  await page.evaluate(() => localStorage.setItem('openfilm.language', 'zh-CN'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-prompt-editor]');
  const errors = [], previews = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/providers/elevenlabs/voices**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    assert.equal(route.request().headers()['xi-api-key'], undefined);
    if (path.endsWith('/preview')) {
      assert.equal(route.request().method(), 'POST');
      previews.push(route.request().postDataJSON());
      await new Promise((done) => setTimeout(done, 150));
      return route.fulfill({ json: { audioBase64: sample.toString('base64') } });
    }
    assert.equal(route.request().method(), 'GET');
    return route.fulfill({ json: path.endsWith('/accents') ? { accents: [] }
      : { voices: [voice], nextCursor: null, total: null, tier: 'starter', unavailableReason: null } });
  });
  await page.evaluate(() => {
    const bridge = window.openfilmDesktop;
    window.__sent = [];
    const info = { sessionId: 'voice-options-test', agentInfo: { name: 'Test agent' }, authMethods: [], mcp: false, models: null, modes: null, configOptions: [] };
    bridge.localAgents = {
      ...bridge.localAgents, probe: async () => ({ ok: true, info }), start: async () => ({ ok: true, key: 'test', info }),
      prompt: async (_key, text) => { window.__sent.push(text); return { ok: true, stopReason: 'end_turn' }; },
      onEvent: () => () => {}, running: async () => [],
    };
  });
  await app.evaluate(({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      contents.setAudioMuted(true);
      contents.send('desktop:agents', [{ id: 'codex', name: 'Test agent', shown: true, status: 'ready' }]);
    }
  });
  const dialog = page.getByRole('dialog', { name: '选择配音音色' });
  const check = () => page.getByRole('checkbox', { name: '配音', exact: true }).locator('..').click();
  const send = async (count) => {
    await page.getByRole('button', { name: '发送修改指令', exact: true }).click();
    await page.waitForFunction((count) => window.__sent.length === count, count);
    await page.waitForFunction(() => !document.querySelector('#of-chat button[aria-label="停止"]'));
    return page.evaluate(() => window.__sent.at(-1));
  };
  const openVoices = async () => {
    await page.getByRole('button', { name: 'ElevenLabs 音色', exact: true }).click();
    await dialog.getByRole('article', { name: voice.name, exact: true }).waitFor();
  };
  const advanced = dialog.locator('details[data-voice-advanced]');
  const expand = () => advanced.locator('summary').click();
  const close = async () => {
    await dialog.getByRole('button', { name: '关闭音色列表', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  };
  const paid = () => dialog.getByRole('button', { name: '生成试听（消耗积分）', exact: true });
  const playing = () => page.waitForFunction(() => {
    const audio = document.querySelector('dialog audio');
    return audio && !audio.paused && audio.currentTime > 0;
  }, null, { timeout: 5000 });
  await page.locator('[data-prompt-editor]').fill('检查本轮配音选项。');
  await check();
  await openVoices();
  assert.equal(await advanced.getAttribute('open'), null);
  await close();
  assert.doesNotMatch(await send(1), /ElevenLabs|--via|"stability"/);

  await check();
  await openVoices();
  await expand();
  for (const [name, value] of [['稳定性', '50'], ['相似度', '75']]) {
    assert.equal(await dialog.getByRole('slider', { name, exact: true }).inputValue(), value);
  }
  await dialog.getByRole('button', { name: '选择试听音色 林晓', exact: true }).click();
  for (let count = 1; count <= 2; count++) {
    await paid().click();
    await dialog.getByRole('button', { name: '正在生成试听…', exact: true }).waitFor();
    await paid().waitFor();
    await playing();
    assert.equal(previews.length, count);
    assert.deepEqual({ stability: previews.at(-1).stability, similarity: previews.at(-1).similarity }, { stability: 0.5, similarity: 0.75 });
  }
  await dialog.getByRole('button', { name: '停止试听', exact: true }).click();
  assert.equal(await dialog.locator('audio').evaluate((audio) => audio.paused), true);
  await dialog.getByRole('button', { name: '重播试听（不消耗积分）', exact: true }).click();
  await playing();
  assert.equal(previews.length, 2);
  await close();
  assert.doesNotMatch(await send(2), /ElevenLabs|--via|"stability"/);

  await check();
  await openVoices();
  await expand();
  await dialog.getByRole('button', { name: '恢复默认', exact: true }).click();
  await close();
  const tuned = await send(3);
  assert.ok(tuned.includes('"provider":"elevenlabs","stability":0.5,"similarity":0.75') && tuned.includes('--via elevenlabs'));
  assert.ok(!tuned.includes('voiceId'));
  await check();
  await openVoices();
  assert.equal(await advanced.getAttribute('open'), null);
  await dialog.getByRole('button', { name: '使用', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const chosen = await send(4);
  assert.ok(chosen.includes('"voiceId":"voice-1"') && chosen.includes('"stability":0.5,"similarity":0.75'));
  await check();
  assert.doesNotMatch(await send(5), /ElevenLabs|--via|"stability"/);
  assert.deepEqual(errors, []);
  console.log('Voice options passed: repeated generation autoplays, replay makes no request, browsing keeps the configured provider, explicit settings and voices use ElevenLabs, send resets all choices.');
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(dir, 'failed.png') }).catch(() => {});
  console.error(`Voice options artifacts: ${dir}`);
  throw error;
} finally {
  await app.close();
}
