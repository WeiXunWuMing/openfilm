import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudio } from '../server.mjs';
import { changeSettings } from '../keys.mjs';
import { voicePreviewUrl } from './elevenlabs-voices.mjs';

let KEY = '', accountNumber = 0;
let studio, service, calls = [], reply, subscriptionReply;
const raw = (id, fields = {}) => ({ voice_id: id, name: id, labels: { gender: 'female', language: 'zh' }, preview_url: 'https://storage.googleapis.com/eleven-public-prod/sample.mp3', ...fields });

before(async () => {
  process.env.OPENFILM_HOME = mkdtempSync(join(tmpdir(), 'of-voice-picker-'));
  process.env.OPENFILM_LIBRARY = join(process.env.OPENFILM_HOME, 'projects');
  delete process.env.ELEVENLABS_API_KEY;
  service = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { url: new URL(req.url, 'http://test'), method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() };
    calls.push(call);
    const [status, body] = await (call.url.pathname === '/v1/user/subscription' ? subscriptionReply : reply)(call);
    res.writeHead(status, { 'content-type': Buffer.isBuffer(body) ? 'audio/mpeg' : 'application/json' }).end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
  await new Promise((done) => service.listen(0, '127.0.0.1', done));
  process.env.OPENFILM_ELEVENLABS_URL = `http://127.0.0.1:${service.address().port}`;
  studio = await startStudio({ port: 0 });
});
beforeEach(async () => {
  calls = [];
  KEY = `eleven-test-key-0123456789-${++accountNumber}`;
  subscriptionReply = () => [200, { tier: 'starter', status: 'active', can_use_professional_voice_cloning: false, open_invoices: ['private-billing'] }];
  reply = () => [200, { voices: [raw('Ada')], has_more: false, total_count: 1 }];
  await changeSettings((settings) => { settings.keys.elevenlabs = KEY; settings.off = []; });
});
after(async () => { await studio.close(); await new Promise((done) => service.close(done)); });
const api = (query = '', init = {}) => fetch(`${studio.origin}/api/providers/elevenlabs/voices${query}`, { ...init, headers: { 'x-studio-key': studio.key, 'content-type': 'application/json', ...init.headers } });

test('account voices can be paged beyond 100, with the key kept only on upstream requests', async () => {
  reply = ({ url }) => {
    const page = Number(url.searchParams.get('next_page_token') || 0);
    assert.equal(url.searchParams.get('include_total_count'), 'false');
    return [200, { voices: Array.from({ length: page === 4 ? 1 : 30 }, (_, index) => raw(`voice-${page * 30 + index}`)), has_more: page < 4, next_page_token: String(page + 1) }];
  };
  let cursor = null;
  const voices = [];
  do {
    const response = await api(cursor ? `?cursor=${cursor}` : '');
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.ok(!JSON.stringify(page).includes(KEY));
    assert.ok(!JSON.stringify(page).includes('private-billing'));
    assert.equal(page.tier, 'starter');
    assert.equal(page.total, null);
    voices.push(...page.voices);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(voices.length, 121);
  assert.equal(new Set(voices.map((v) => v.voiceId)).size, 121);
  assert.ok(calls.every((call) => call.headers['xi-api-key'] === KEY && ['/v2/voices', '/v1/user/subscription'].includes(call.url.pathname)));
});

test('account filters reach ElevenLabs and a language-specific sample is preferred', async () => {
  reply = () => [200, { voices: [raw('Ada', { verified_languages: [
    { language: 'zh', accent: 'taiwan mandarin', preview_url: 'https://storage.googleapis.com/eleven-public-prod/taiwan.mp3' },
    { language: 'zh', accent: 'beijing mandarin', preview_url: 'https://storage.googleapis.com/eleven-public-prod/zh.mp3' },
  ] })], has_more: false }];
  const result = await (await api('?search=calm&language=zh&gender=female&accent=beijing%20mandarin')).json();
  assert.equal(result.voices[0].previewUrl, 'https://storage.googleapis.com/eleven-public-prod/zh.mp3');
  assert.equal(calls[1].url.searchParams.get('search'), 'calm');
  assert.equal(calls[1].url.searchParams.get('language'), 'zh');
  assert.equal(calls[1].url.searchParams.get('gender'), 'female');
  assert.equal(calls[1].url.searchParams.get('accent'), 'beijing mandarin');
  assert.equal(result.voices[0].accent, 'beijing mandarin');
});

test('the public library uses numbered pages and preserves ownership and sample metadata', async () => {
  reply = () => [200, { voices: [raw('public-1', { public_owner_id: 'owner-1', gender: 'Female', language: 'en', free_users_allowed: false, age: 'young', use_case: 'narration', descriptive: 'calm' })], has_more: true, total_count: 300 }];
  const response = await api('?source=library&cursor=3&search=narrator&gender=female&accent=american');
  const result = await response.json();
  assert.equal(calls[1].url.pathname, '/v1/shared-voices');
  assert.equal(calls[1].url.searchParams.get('page'), '3');
  assert.equal(calls[1].url.searchParams.get('accent'), 'american');
  assert.equal(result.nextCursor, '4');
  assert.equal(result.total, 300);
  assert.equal(result.voices[0].publicOwnerId, 'owner-1');
  assert.equal(result.voices[0].gender, 'female');
  assert.equal(result.voices[0].freeUsersAllowed, false);
  assert.equal(result.voices[0].age, 'young');
  assert.equal(result.voices[0].useCase, 'narration');
  assert.equal(result.voices[0].style, 'calm');
  assert.equal(result.tier, 'starter');
  assert.equal(result.unavailableReason, null);
});

test('account voices exclude plan restrictions, pending verification, bans and expired shared copies', async () => {
  reply = () => [200, { voices: [
    raw('unrestricted', { available_for_tiers: [] }),
    raw('starter', { available_for_tiers: ['starter', 'creator'] }),
    raw('creator-only', { available_for_tiers: ['creator'] }),
    raw('pending', { voice_verification: { requires_verification: true, is_verified: false } }),
    raw('verified', { voice_verification: { requires_verification: true, is_verified: true } }),
    raw('banned', { safety_control: 'BAN' }),
    raw('expired-copy', { sharing: { status: 'copied', disable_at_unix: 1 } }),
    raw('notice-period', { category: 'professional', sharing: { status: 'copied', disable_at_unix: Date.now() / 1000 + 86_400, free_users_allowed: false } }),
    raw('owner', { is_owner: true, sharing: { status: 'disabled', disable_at_unix: 1 } }),
  ], has_more: false, total_count: 9 }];
  const result = await (await api()).json();
  assert.deepEqual(result.voices.map((voice) => voice.voiceId), ['unrestricted', 'starter', 'verified', 'notice-period', 'owner']);
  assert.equal(result.total, null, 'the unfiltered upstream count is not presented as available voices');
});

test('Free accounts keep their own voices but cannot use saved library voices through the API', async () => {
  subscriptionReply = () => [200, { tier: 'free', status: 'free' }];
  reply = () => [200, { voices: [
    raw('premade'), raw('own-generated', { category: 'generated', is_owner: true }),
    raw('paid-only', { available_for_tiers: ['starter'] }),
    raw('free-copy', { sharing: { status: 'copied', free_users_allowed: true } }),
    raw('paid-copy', { sharing: { status: 'copied', free_users_allowed: false } }),
  ], has_more: false }];
  const result = await (await api()).json();
  assert.deepEqual(result.voices.map((voice) => voice.voiceId), ['premade', 'own-generated']);
  calls = [];
  assert.deepEqual(await (await api('?source=library')).json(), { voices: [], total: 0, nextCursor: null, tier: 'free', unavailableReason: 'paid_required' });
  assert.deepEqual(calls, [], 'the already verified Free subscription is reused');
});

test('disabled and incomplete accounts show no selectable voices', async () => {
  for (const status of ['free_disabled', 'incomplete']) {
    subscriptionReply = () => [200, { tier: status === 'incomplete' ? 'starter' : 'free', status }];
    const result = await (await api('?refresh=1')).json();
    assert.deepEqual(result.voices, []);
    assert.equal(result.unavailableReason, 'account_unavailable');
  }
  assert.ok(calls.every((call) => call.url.pathname === '/v1/user/subscription'));
});

test('a filtered empty page preserves continuation to later available voices', async () => {
  reply = ({ url }) => [200, url.searchParams.has('next_page_token')
    ? { voices: [raw('available')], has_more: false, total_count: 31 }
    : { voices: [raw('restricted', { available_for_tiers: ['creator'] })], has_more: true, next_page_token: 'next', total_count: 31 }];
  const first = await (await api()).json();
  assert.deepEqual(first.voices, []);
  assert.equal(first.nextCursor, 'next');
  assert.equal(first.total, null);
  const second = await (await api('?cursor=next')).json();
  assert.deepEqual(second.voices.map((voice) => voice.voiceId), ['available']);
});

test('subscription read failure cannot silently present unverified voices as available', async () => {
  subscriptionReply = () => [403, { detail: { message: `user_read missing ${KEY}` } }];
  const response = await api();
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.match(result.error, /Could not verify.*User read permission/);
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.deepEqual(calls.map((call) => call.url.pathname), ['/v1/user/subscription']);
  subscriptionReply = () => [200, {}];
  assert.equal((await api()).status, 502);
});

test('changing the configured key immediately changes the plan used for filtering', async () => {
  subscriptionReply = ({ headers }) => [200, { tier: headers['xi-api-key'] === KEY ? 'starter' : 'free', status: 'active' }];
  reply = () => [200, { voices: [raw('starter-only', { available_for_tiers: ['starter'] })], has_more: false }];
  assert.equal((await (await api()).json()).voices.length, 1);
  await changeSettings((settings) => { settings.keys.elevenlabs = 'replacement-key-0123456789'; });
  const result = await (await api()).json();
  assert.deepEqual(result.voices, []);
  assert.equal(result.tier, 'free');
});

test('accent metadata is language-specific, authenticated and validated', async () => {
  const accents = [{ accent: 'beijing mandarin', language: 'zh', code: 'zh-beijing-mandarin', name: 'Mandarin (Beijing)' }];
  reply = () => [200, { accents }];
  assert.deepEqual(await (await api('/accents?language=zh')).json(), { accents });
  assert.equal(calls[0].url.pathname, '/v1/voices/accents');
  assert.equal(calls[0].url.searchParams.get('language'), 'zh');
  assert.equal(calls[0].headers['xi-api-key'], KEY);
  const count = calls.length;
  assert.equal((await api('/accents?language=../bad')).status, 400);
  assert.equal((await api('/accents', { headers: { 'x-studio-key': 'wrong' } })).status, 401);
  assert.equal(calls.length, count);
  reply = () => [200, {}];
  assert.equal((await api('/accents?refresh=1')).status, 502);
});

test('adding a shared voice returns the actual account voice id', async () => {
  reply = () => [200, { voice_id: 'account-copy' }];
  const response = await api('/add', { method: 'POST', body: JSON.stringify({ voiceId: 'public-1', publicOwnerId: 'owner-1', name: 'Ada' }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { voiceId: 'account-copy' });
  assert.equal(calls[0].url.pathname, '/v1/voices/add/owner-1/public-1');
  assert.deepEqual(JSON.parse(calls[0].body), { new_name: 'Ada' });
});

test('the picker requires Studio authorization and a connected ElevenLabs account', async () => {
  assert.equal((await api('', { headers: { 'x-studio-key': 'wrong' } })).status, 401);
  await changeSettings((settings) => { delete settings.keys.elevenlabs; });
  assert.equal((await api()).status, 409);
  assert.equal(calls.length, 0);
});

test('invalid filters and public voice ids are rejected before calling a service', async () => {
  for (const query of ['?source=other', '?language=../../x', '?gender=other', '?source=library&cursor=-1', `?search=${'x'.repeat(201)}`, `?accent=${'x'.repeat(101)}`, '?accent=bad%00accent', '?refresh=invalid']) assert.equal((await api(query)).status, 400);
  assert.equal((await api('/add', { method: 'POST', body: JSON.stringify({ voiceId: '../bad', publicOwnerId: 'owner', name: 'Ada' }) })).status, 400);
  assert.equal(calls.length, 0);
});

test('failed and malformed upstream responses cannot become silent empty or truncated lists', async () => {
  reply = () => [200, { voices: [], has_more: true }];
  assert.equal((await api()).status, 502);
  reply = () => [200, {}];
  assert.equal((await api()).status, 502);
  reply = () => [422, { detail: { message: `Account error ${KEY}` } }];
  const result = await (await api()).json();
  assert.ok(result.error.includes('Account error'));
  assert.ok(!result.error.includes(KEY));
  reply = () => [200, Buffer.from(`Invalid JSON containing ${KEY}`)];
  const invalid = await api();
  assert.equal(invalid.status, 502);
  assert.ok(!JSON.stringify(await invalid.json()).includes(KEY));
});

test('sample URLs reject executable, local-file and credential-bearing schemes', () => {
  for (const url of ['javascript:alert(1)', 'file:///secret', 'http://127.0.0.1/private', 'https://key:secret@example.com/sample.mp3', null]) assert.equal(voicePreviewUrl(url), null);
  assert.equal(voicePreviewUrl('https://storage.googleapis.com/eleven-public-prod/sample.mp3'), 'https://storage.googleapis.com/eleven-public-prod/sample.mp3');
});

test('repeated filters and pages are cached while new filters reuse the verified subscription', async () => {
  const first = await (await api('?search=calm')).json();
  assert.deepEqual(await (await api('?search=calm')).json(), first);
  assert.equal(calls.length, 2);
  for (const query of ['?search=bright', '?search=calm&language=zh', '?search=calm&gender=female', '?search=calm&accent=american', '?search=calm&cursor=next', '?source=library&search=calm']) {
    const before = calls.length;
    assert.equal((await api(query)).status, 200);
    assert.equal(calls.length, before + 1);
    assert.equal((await api(query)).status, 200);
    assert.equal(calls.length, before + 1);
  }
  assert.equal(calls.filter((call) => call.url.pathname === '/v1/user/subscription').length, 1);
});

test('refresh fetches new data, invalidates other query pages, and preserves cached accent choices', async () => {
  reply = ({ url }) => url.pathname.endsWith('/accents') ? [200, { accents: [{ accent: 'standard', language: 'zh' }] }]
    : [200, { voices: [raw(url.searchParams.get('search') || 'old')], has_more: false }];
  await api('/accents?language=zh');
  await api('?search=one');
  await api('?search=two');
  const before = calls.length;
  await api('?search=one&refresh=1');
  assert.equal(calls.length, before + 2);
  await api('?search=two');
  assert.equal(calls.length, before + 3, 'the other query must also be fetched again');
  await api('/accents?language=zh');
  assert.equal(calls.length, before + 3);
  await api('/accents?language=zh&refresh=1');
  assert.equal(calls.length, before + 4);
  assert.ok(calls.every((call) => !call.url.searchParams.has('refresh')));
});

test('subscription expiry rechecks eligibility even when the voice page is still cached', async (context) => {
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  reply = () => [200, { voices: [raw('starter-only', { available_for_tiers: ['starter'] })], has_more: false }];
  assert.equal((await (await api()).json()).voices.length, 1);
  const before = calls.length;
  now += 61_000;
  subscriptionReply = () => [200, { tier: 'free', status: 'free' }];
  assert.deepEqual((await (await api()).json()).voices, []);
  assert.equal(calls.length, before + 1, 'only the expired subscription is fetched again');
  now += 61_000;
  await api();
  assert.equal(calls.length, before + 3, 'the expired voice page is also fetched again');
});

test('a cached shared voice stops being shown as soon as its withdrawal time passes', async (context) => {
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  reply = () => [200, { voices: [raw('withdrawn', { sharing: { status: 'copied', disable_at_unix: now / 1000 + 10 } })], has_more: false }];
  assert.equal((await (await api()).json()).voices.length, 1);
  const before = calls.length;
  now += 11_000;
  assert.deepEqual((await (await api()).json()).voices, []);
  assert.equal(calls.length, before);
});

test('errors do not become cached results or silently fall back to old data', async () => {
  await api();
  reply = () => [500, { detail: { message: 'Temporary outage' } }];
  assert.equal((await api('?refresh=1')).status, 502);
  reply = () => [200, { voices: [raw('recovered')], has_more: false }];
  assert.equal((await (await api()).json()).voices[0].voiceId, 'recovered');
  const before = calls.length;
  assert.equal((await (await api()).json()).voices[0].voiceId, 'recovered');
  assert.equal(calls.length, before);
});

test('adding a public voice invalidates the cached account and library pages', async () => {
  let added = false;
  reply = ({ url }) => {
    if (url.pathname.startsWith('/v1/voices/add/')) { added = true; return [200, { voice_id: 'new-copy' }]; }
    return [200, { voices: [raw(added ? 'new-copy' : 'old')], has_more: false }];
  };
  await api();
  await api('?source=library');
  await api('/add', { method: 'POST', body: JSON.stringify({ voiceId: 'public', publicOwnerId: 'owner', name: 'Ada' }) });
  const before = calls.length;
  assert.equal((await (await api()).json()).voices[0].voiceId, 'new-copy');
  assert.equal((await (await api('?source=library')).json()).voices[0].voiceId, 'new-copy');
  assert.equal(calls.length, before + 3);
});

test('an older response cannot replace the cache after a manual refresh', async () => {
  const waiting = Promise.withResolvers(), release = Promise.withResolvers();
  let requests = 0;
  reply = () => {
    if (++requests === 1) { waiting.resolve(); return release.promise; }
    return [200, { voices: [raw('fresh')], has_more: false }];
  };
  const old = api();
  await waiting.promise;
  assert.equal((await (await api('?refresh=1')).json()).voices[0].voiceId, 'fresh');
  release.resolve([200, { voices: [raw('old')], has_more: false }]);
  await old;
  const before = calls.length;
  assert.equal((await (await api()).json()).voices[0].voiceId, 'fresh');
  assert.equal(calls.length, before);
});

test('the cache stays bounded when searching many different queries', async () => {
  for (let index = 0; index < 66; index++) await api(`?search=query-${index}`);
  const before = calls.length;
  await api('?search=query-65');
  assert.equal(calls.length, before);
  await api('?search=query-0');
  assert.ok(calls.length > before, 'the oldest query was evicted');
});

test('generated previews pass the current model and per-request settings, without caching paid requests', async () => {
  await changeSettings((settings) => { settings.model.tts = 'eleven_v4'; });
  const audio = Buffer.alloc(1600, 1);
  reply = () => [200, audio];
  const init = { method: 'POST', body: JSON.stringify({ voiceId: 'chosen', text: '这是一段试听。', stability: 0.3, similarity: 0.85 }) };
  for (let count = 0; count < 2; count++) {
    const response = await api('/preview', init);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.ok(!JSON.stringify(result).includes(KEY));
    assert.deepEqual(Buffer.from(result.audioBase64, 'base64'), audio);
  }
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.method, 'POST');
    assert.equal(call.url.pathname, '/v1/text-to-speech/chosen');
    assert.equal(call.url.searchParams.get('output_format'), 'mp3_44100_128');
    assert.equal(call.headers['xi-api-key'], KEY);
    assert.deepEqual(JSON.parse(call.body), { text: '这是一段试听。', model_id: 'eleven_v4', voice_settings: { stability: 0.3, similarity_boost: 0.85 } });
  }
  assert.equal((await api('/preview')).status, 404);
});

test('preview validation rejects bad voices, long text and invalid settings before paid calls', async () => {
  const valid = { voiceId: 'chosen', text: '试听', stability: 0.5, similarity: 0.75 };
  for (const fields of [{ voiceId: '../bad' }, { text: '' }, { text: '字'.repeat(201) }, { stability: -1 }, { similarity: 2 }, { stability: null }, { similarity: true }, { stability: 'oops' }]) {
    assert.equal((await api('/preview', { method: 'POST', body: JSON.stringify({ ...valid, ...fields }) })).status, 400);
  }
  assert.equal((await api('/preview', { method: 'POST', body: 'x'.repeat(5000) })).status, 413);
  assert.equal((await api('/preview', { method: 'POST', body: JSON.stringify(valid), headers: { 'x-studio-key': 'wrong' } })).status, 401);
  await changeSettings((settings) => { delete settings.keys.elevenlabs; });
  assert.equal((await api('/preview', { method: 'POST', body: JSON.stringify(valid) })).status, 409);
  assert.equal(calls.length, 0);
});

test('preview defaults and failures do not edit stored voice settings or expose credentials', async () => {
  const init = { method: 'POST', body: JSON.stringify({ voiceId: 'chosen', text: '试听' }) };
  reply = () => [200, Buffer.alloc(10)];
  assert.equal((await api('/preview', init)).status, 200);
  assert.deepEqual(JSON.parse(calls[0].body).voice_settings, { stability: 0.5, similarity_boost: 0.75 });
  reply = () => [200, {}];
  assert.equal((await api('/preview', init)).status, 502);
  reply = () => [200, Buffer.alloc(0)];
  assert.equal((await api('/preview', init)).status, 502);
  reply = () => [422, { detail: { message: `Bad preview ${KEY}` } }];
  const response = await api('/preview', init);
  assert.equal(response.status, 502);
  assert.ok(!JSON.stringify(await response.json()).includes(KEY));
  assert.ok(calls.every((call) => call.url.pathname === '/v1/text-to-speech/chosen'));
});
