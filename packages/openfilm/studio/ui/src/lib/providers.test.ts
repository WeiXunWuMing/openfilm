import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSharedElevenLabsVoice, couldMake, generateElevenLabsPreview, loadElevenLabsAccents, loadElevenLabsVoices, offered, type OwnProvider, type ProviderVerb, type ProvidersState } from './providers.ts';

const own = (id: string, name: string, verbs: ProviderVerb[], source: OwnProvider['source'] = null): OwnProvider =>
  ({ id, name, verbs, models: {}, keysUrl: '', env: '', envKey: false, source, last4: null });
const state: ProvidersState = {
  providers: [own('elevenlabs', 'ElevenLabs', ['tts', 'sfx']), own('openai', 'OpenAI', ['tts', 'image']), own('fal', 'fal.ai', ['image', 'video']), own('google', 'Google', ['image'], 'file')],
  use: {}, model: {}, custom: [],
};

test('the providers that would make a kind, once connected, by name', () => {
  assert.deepEqual(couldMake(state, 'tts'), ['ElevenLabs', 'OpenAI']);
  assert.deepEqual(couldMake(state, 'image'), ['fal.ai', 'OpenAI'], 'one connected already is not asked for');
  assert.deepEqual(couldMake(state, 'image-search'), [], 'nothing here finds pictures');
  assert.deepEqual(couldMake(state, 'translate'), []);
});

test('a kind is offered when any provider makes it, connected or not', () => {
  assert.equal(offered(state, 'video'), true);
  assert.equal(offered(state, 'web-search'), false);
});

test('voice filters and continuation tokens go to Studio without a provider key', async (context) => {
  const result = { voices: [], nextCursor: 'next', total: 140, tier: 'starter', unavailableReason: null };
  const fetch = context.mock.method(globalThis, 'fetch', async () => Response.json(result));
  assert.deepEqual(await loadElevenLabsVoices({ source: 'library', search: 'calm', language: 'zh', gender: 'female', accent: 'beijing mandarin' }, '2', new AbortController().signal), result);
  const [url, init] = fetch.mock.calls[0].arguments as [string, RequestInit];
  const query = new URL(url, 'http://studio');
  assert.equal(query.pathname, '/api/providers/elevenlabs/voices');
  assert.equal(query.searchParams.get('cursor'), '2');
  assert.equal(query.searchParams.get('language'), 'zh');
  assert.equal(query.searchParams.get('search'), 'calm');
  assert.equal(query.searchParams.get('accent'), 'beijing mandarin');
  assert.equal(init.headers, undefined);
});

test('accent choices come from the provider for the selected language', async (context) => {
  const result = { accents: [{ accent: 'beijing mandarin', language: 'zh', code: 'zh-beijing-mandarin', name: 'Mandarin (Beijing)' }] };
  const fetch = context.mock.method(globalThis, 'fetch', async () => Response.json(result));
  assert.deepEqual(await loadElevenLabsAccents('zh', new AbortController().signal), result);
  const [url, init] = fetch.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, '/api/providers/elevenlabs/voices/accents?language=zh');
  assert.equal(init.headers, undefined);
  assert.ok(init.signal);
});

test('explicit reload bypasses the server cache for voices and accent choices', async (context) => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => Response.json({}));
  const signal = new AbortController().signal;
  await loadElevenLabsVoices({ source: 'account', search: '', language: 'zh', gender: '', accent: '' }, null, signal, true);
  await loadElevenLabsAccents('zh', signal, true);
  for (const call of fetch.mock.calls) assert.equal(new URL(String(call.arguments[0]), 'http://studio').searchParams.get('refresh'), '1');
});

test('using a shared voice keeps the returned account id and reports failed requests', async (context) => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => Response.json({ voiceId: 'account-copy' }));
  const voice = { voiceId: 'public-1', publicOwnerId: 'owner-1', name: 'Ada', language: 'zh', description: null };
  assert.deepEqual(await addSharedElevenLabsVoice(voice), { voiceId: 'account-copy' });
  const [url, init] = fetch.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, '/api/providers/elevenlabs/voices/add');
  assert.deepEqual(JSON.parse(String(init.body)), { voiceId: 'public-1', publicOwnerId: 'owner-1', name: 'Ada' });
  fetch.mock.mockImplementation(async () => Response.json({ error: 'Voice slots exhausted' }, { status: 409 }));
  await assert.rejects(addSharedElevenLabsVoice(voice), /slots exhausted/);
});

test('generated previews send the selected settings and can be cancelled without provider keys in the browser', async (context) => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => Response.json({ audioBase64: 'YXVkaW8=' }));
  const controller = new AbortController();
  assert.deepEqual(await generateElevenLabsPreview('chosen', '试听', { stability: 0.4, similarity: 0.8 }, controller.signal), { audioBase64: 'YXVkaW8=' });
  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(url, '/api/providers/elevenlabs/voices/preview');
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), { voiceId: 'chosen', text: '试听', stability: 0.4, similarity: 0.8 });
  assert.deepEqual(init.headers, { 'content-type': 'application/json' });
  controller.abort();
  assert.equal(init.signal.aborted, true);
});
