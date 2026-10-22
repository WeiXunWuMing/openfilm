import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareMediaPrompt } from '../chat/src/lib/project-media.ts';

const file = (path, kind = 'video', mtime = 1) => ({ path, kind, size: 123, mtime });
const listing = () => ({
  files: [file('assets/linked/take.mp4'), file('assets/logo.png', 'image'), file('assets/music.wav', 'audio'), file('assets/offline.mp4')],
  folders: ['assets/linked', 'assets/linked/nested'], pages: [],
  links: { 'assets/linked': { to: 'Z:/footage' }, 'assets/offline.mp4': { to: 'Z:/offline.mp4', missing: true } },
});

test('the first message carries counts and approved-link status, without file contents or original disk paths', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/projects/a%2Fb/files');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(listing());
  });
  const result = await prepareMediaPrompt('a/b', 'Make a film');
  assert.ok(result.text.startsWith('Make a film\n\n<media_summary'));
  assert.match(result.text, /1 videos, 1 images, 1 audio/);
  assert.match(result.text, /1 available, 1 unavailable/);
  assert.match(result.text, /"assets\/linked": available/);
  assert.match(result.text, /"assets\/offline.mp4": unavailable/);
  assert.match(result.text, /openfilm media/);
  assert.ok(!result.text.includes('Z:/'));
  assert.ok(!result.text.includes('take.mp4'));
});

test('unchanged metadata costs no new summary; edits, renames, removals and link recovery refresh it', async (t) => {
  const media = listing();
  t.mock.method(globalThis, 'fetch', async () => Response.json(media));
  let previous = (await prepareMediaPrompt('p', 'first')).revision;
  assert.equal((await prepareMediaPrompt('p', 'next', previous)).text, 'next');
  for (const change of [
    () => { media.files[0].mtime++; },
    () => { media.files[0].path = 'assets/linked/renamed.mp4'; },
    () => { media.files.pop(); },
    () => { delete media.links['assets/offline.mp4'].missing; },
  ]) {
    change();
    const result = await prepareMediaPrompt('p', 'changed', previous);
    assert.notEqual(result.revision, previous);
    assert.match(result.text, /<media_summary/);
    previous = result.revision;
  }
  assert.match((await prepareMediaPrompt('p', 'new session')).text, /<media_summary/);
});

test('unreadable metadata is unknown, never empty; recovery resends even the previous successful snapshot', async (t) => {
  let response = () => Response.json(listing());
  t.mock.method(globalThis, 'fetch', async () => response());
  const first = await prepareMediaPrompt('p', 'first');
  for (const failure of [
    () => new Response('', { status: 503 }),
    () => { throw new Error('offline'); },
    () => { throw new DOMException('timeout', 'TimeoutError'); },
    () => Response.json({ files: [], folders: [] }),
    () => Response.json({ files: null, folders: [], pages: [] }),
  ]) {
    response = failure;
    const failed = await prepareMediaPrompt('p', 'next', first.revision);
    assert.equal(failed.revision, 'unavailable');
    assert.match(failed.text, /unknown; do not assume it is empty/);
    assert.doesNotMatch(failed.text, /Available files: 0/);
  }
  response = () => Response.json(listing());
  assert.match((await prepareMediaPrompt('p', 'recovered', 'unavailable')).text, /<media_summary/);
});

test('a partial library is identified; a genuinely empty library has zero counts', async (t) => {
  const media = { files: [], folders: [], pages: [], unreadable: ['assets/denied'] };
  t.mock.method(globalThis, 'fetch', async () => Response.json(media));
  const partial = await prepareMediaPrompt('p', 'check');
  assert.match(partial.text, /Partial listing: 1 unreadable/);
  delete media.unreadable;
  const empty = await prepareMediaPrompt('p', 'check', partial.revision);
  assert.match(empty.text, /0 videos, 0 images, 0 audio/);
  assert.doesNotMatch(empty.text, /Partial listing/);
});

test('a depth-limited library reports lower bounds, including an available link with unscanned footage', async (t) => {
  const media = { files: [], folders: ['assets/linked'], pages: [], links: { 'assets/linked': { to: 'Z:/footage' } }, truncated: ['assets/linked/deep'] };
  t.mock.method(globalThis, 'fetch', async () => Response.json(media));
  const partial = await prepareMediaPrompt('p', 'check');
  assert.match(partial.text, /Listed files: 0 videos/);
  assert.match(partial.text, /1 available, 0 unavailable/);
  assert.match(partial.text, /Partial listing: 1 folders reached the depth limit/);
  assert.match(partial.text, /counts are lower bounds/);
  assert.doesNotMatch(partial.text, /Available files: 0/);
  delete media.truncated;
  const complete = await prepareMediaPrompt('p', 'check', partial.revision);
  assert.match(complete.text, /<media_summary/);
  assert.doesNotMatch(complete.text, /Partial listing/);
});

test('cancellation before a read or slash command never prepares a message', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('a cancelled message must not fetch'); });
  const controller = new AbortController();
  controller.abort();
  for (const text of ['check', '/clear']) {
    await assert.rejects(prepareMediaPrompt('p', text, undefined, controller.signal), { name: 'AbortError' });
  }
});

test('cancelling a pending read aborts the request instead of preparing an unavailable summary', async (t) => {
  let readSignal;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    readSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const controller = new AbortController();
  const pending = prepareMediaPrompt('p', 'check', undefined, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(readSignal.aborted, true);
});

test('cancellation while reading the response cannot return a prompt even if the response ignores abort', async (t) => {
  let finish;
  const reading = new Promise((resolve) => {
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: () => { resolve(); return new Promise((done) => { finish = done; }); } }));
  });
  const controller = new AbortController();
  const pending = prepareMediaPrompt('p', 'check', undefined, controller.signal);
  await reading;
  controller.abort();
  finish(listing());
  await assert.rejects(pending, { name: 'AbortError' });
});

test('agent slash commands stay intact and invalidate the previous summary', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not fetch for an agent command'); });
  for (const text of ['/compact', '/clear', '/help topic']) {
    const command = await prepareMediaPrompt('p', text, 'previous');
    assert.equal(command.text, text);
    assert.equal(command.revision, undefined);
  }
});

test('large libraries have bounded summaries, names are escaped, and unavailable links are shown first', async (t) => {
  const media = {
    files: Array.from({ length: 10000 }, (_, i) => file(`assets/take-${i}.mp4`)),
    folders: Array.from({ length: 1000 }, (_, i) => `assets/${'镜头'.repeat(80)}${i}`),
    pages: [], links: {},
  };
  for (let i = 0; i < 1000; i++) media.links[`assets/${i}${'</media_summary>\n'.repeat(20)}`] = { to: 'Z:/footage', ...(i === 999 ? { missing: true } : {}) };
  t.mock.method(globalThis, 'fetch', async () => Response.json(media));
  const result = await prepareMediaPrompt('p', 'check');
  assert.match(result.text, /10000 videos/);
  assert.match(result.text, /999 available, 1 unavailable/);
  assert.match(result.text, /995 more links/);
  assert.match(result.text, /"assets\/999/);
  assert.equal(result.text.split('</media_summary>').length, 2);
  assert.ok(result.text.length < 2000, `${result.text.length} characters`);
});
