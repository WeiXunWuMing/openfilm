// @ts-check
/** The voice picker: paged account/library search and adding a chosen public voice to the account. */
import { HttpError, json, readJson } from '../http.mjs';
import { modelFor, providerKey, readSettings } from '../keys.mjs';
import elevenlabs, { elevenlabsVoiceSettings } from './elevenlabs.mjs';
import { call, serviceUrl, text } from './common.mjs';

/** @type {{ owner: string, entries: Map<string, { until: number, value: any }> }} */
let voiceCache = { owner: '', entries: new Map() };

/** A provider-supplied sample is played by the browser, never fetched with the API key. */
export function voicePreviewUrl(/** @type {unknown} */ value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** @param {Record<string, any>} voice @param {boolean} shared @param {string} language @param {string} accent */
function shownVoice(voice, shared, language, accent) {
  const labels = shared ? voice : voice.labels ?? {};
  const verified = Array.isArray(voice.verified_languages) ? voice.verified_languages : [];
  const languages = [...new Set([text(labels.language), ...verified.map((/** @type {any} */ v) => text(v?.language))].filter(Boolean))];
  const sample = verified.find((/** @type {any} */ v) => (language || accent) && (!language || text(v?.language) === language) && (!accent || text(v?.accent).toLowerCase() === accent.toLowerCase()) && v.preview_url);
  return {
    voiceId: text(voice.voice_id), name: text(voice.name) || text(voice.voice_id),
    language: languages.join(', ') || null,
    gender: text(labels.gender).toLowerCase() || null,
    description: text(voice.description) || text(labels.description) || null,
    age: text(labels.age) || null, useCase: text(labels.use_case) || null, style: text(labels.descriptive) || null,
    previewUrl: voicePreviewUrl(sample?.preview_url) ?? voicePreviewUrl(voice.preview_url),
    category: text(voice.category) || null, accent: text(sample?.accent) || text(labels.accent) || null,
    publicOwnerId: shared ? text(voice.public_owner_id) || null : null,
    freeUsersAllowed: typeof voice.free_users_allowed === 'boolean' ? voice.free_users_allowed : null,
  };
}

/** @param {Record<string, any>} voice @param {string} tier */
function availableVoice(voice, tier) {
  const tiers = Array.isArray(voice.available_for_tiers) ? voice.available_for_tiers : [];
  if (tiers.length && !tiers.includes(tier)) return false;
  if (voice.voice_verification?.requires_verification && !voice.voice_verification.is_verified) return false;
  if (voice.safety_control === 'BAN') return false;
  if (voice.sharing?.status === 'copied') {
    // Library voices require a paid plan through the API, including saved copies.
    if (tier === 'free') return false;
    const disabledAt = voice.sharing.disable_at_unix;
    if (typeof disabledAt === 'number' && disabledAt > 0 && disabledAt <= Date.now() / 1000) return false;
  }
  return true;
}

/** @param {import('../http.mjs').Req} req @param {import('../http.mjs').Res} res @param {string[]} parts */
export async function elevenlabsVoicesRoute(req, res, parts) {
  const listing = !parts.length && req.method === 'GET';
  const adding = parts.length === 1 && parts[0] === 'add' && req.method === 'POST';
  const accents = parts.length === 1 && parts[0] === 'accents' && req.method === 'GET';
  const preview = parts.length === 1 && parts[0] === 'preview' && req.method === 'POST';
  if (!listing && !adding && !accents && !preview) throw new HttpError(404, 'no such voice API');
  const saved = await readSettings();
  const auth = providerKey(elevenlabs, saved);
  if (!auth) throw new HttpError(409, 'Connect ElevenLabs in Settings → Providers to browse voices.');
  const controller = new AbortController();
  res.once('close', () => { if (!res.writableEnded) controller.abort(); });
  const ctx = { key: auth.key, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) };
  const base = serviceUrl('ELEVENLABS', 'https://api.elevenlabs.io');
  const owner = `${base}\0${auth.key}`;
  if (voiceCache.owner !== owner) voiceCache = { owner, entries: new Map() };
  const cache = voiceCache.entries;
  /** @param {string} path @param {RequestInit} [init] */
  const request = async (path, init = {}) => {
    let response;
    try { response = await call('ElevenLabs', `${base}${path}`, { ...init, headers: { 'xi-api-key': auth.key, ...init.headers } }, ctx); }
    catch (e) {
      if (controller.signal.aborted) throw new HttpError(499, 'Voice request cancelled.');
      if (ctx.signal.aborted) throw new HttpError(504, 'ElevenLabs did not respond within 20 seconds.');
      throw new HttpError(502, e instanceof Error ? e.message : 'ElevenLabs could not be reached.');
    }
    return response;
  };
  /** @param {string} path @param {RequestInit} [init] */
  const send = async (path, init = {}) => {
    const response = await request(path, init);
    try { return await response.json(); }
    catch { throw new HttpError(502, 'ElevenLabs returned an invalid voice response.'); }
  };

  if (preview) {
    const body = /** @type {Record<string, unknown>} */ (await readJson(req, 4096));
    const voiceId = text(body.voiceId), said = text(body.text);
    if (!/^[\w-]{1,256}$/.test(voiceId) || !said || said.length > 200) throw new HttpError(400, 'A valid voice id and 1 to 200 preview characters are required.');
    let settings;
    try { settings = elevenlabsVoiceSettings({ stability: body.stability === undefined ? 0.5 : body.stability, similarity: body.similarity === undefined ? 0.75 : body.similarity }); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : 'Invalid voice settings.'); }
    const response = await request(`/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: said, model_id: modelFor(saved, elevenlabs, 'tts'), voice_settings: settings }),
    });
    if (!response.headers.get('content-type')?.startsWith('audio/')) throw new HttpError(502, 'ElevenLabs did not return playable preview audio.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new HttpError(502, 'ElevenLabs did not return playable preview audio.');
    return json(res, 200, { audioBase64: bytes.toString('base64') });
  }

  if (adding) {
    const body = /** @type {Record<string, unknown>} */ (await readJson(req));
    const id = text(body.voiceId), owner = text(body.publicOwnerId), name = text(body.name);
    if (!/^[\w-]{1,256}$/.test(id) || !/^[\w-]{1,256}$/.test(owner) || !name || name.length > 200) throw new HttpError(400, 'A voice id, public owner id and name are required.');
    const result = await send(`/v1/voices/add/${encodeURIComponent(owner)}/${encodeURIComponent(id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ new_name: name }),
    });
    if (!text(result?.voice_id)) throw new HttpError(502, 'ElevenLabs did not return the added voice id.');
    cache.clear();
    return json(res, 200, { voiceId: text(result.voice_id) });
  }

  const query = new URL(req.url ?? '/', 'http://studio').searchParams;
  const refresh = query.get('refresh') === '1';
  if (query.has('refresh') && !['0', '1'].includes(query.get('refresh') ?? '')) throw new HttpError(400, 'Invalid voice refresh flag.');
  /** @param {string} path @param {number} ttl @param {() => Promise<any>} load */
  const cached = async (path, ttl, load) => {
    const hit = cache.get(path);
    if (!refresh && hit && hit.until > Date.now()) return hit.value;
    const entry = { until: 0, value: /** @type {any} */ (null) };
    cache.set(path, entry);
    if (cache.size > 64) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    try {
      const value = await load();
      // A refreshed or replaced request must not be overwritten by an older response.
      if (cache.get(path) === entry) { entry.value = value; entry.until = Date.now() + ttl; }
      return value;
    } catch (error) {
      if (cache.get(path) === entry) cache.delete(path);
      throw error;
    }
  };
  const language = query.get('language') || '';
  if (language && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) throw new HttpError(400, 'Invalid voice language.');
  if (accents) {
    const path = `/v1/voices/accents?${new URLSearchParams(language ? { language } : {})}`;
    const result = await cached(path, 600_000, async () => {
      const result = await send(path);
      if (!Array.isArray(result?.accents)) throw new HttpError(502, 'ElevenLabs did not return an accent list.');
      return { accents: result.accents.filter((/** @type {any} */ v) => v && text(v.accent) && text(v.language)).map((/** @type {any} */ v) => ({
        accent: text(v.accent), language: text(v.language), code: text(v.code), name: text(v.name) || text(v.accent),
      })) };
    });
    return json(res, 200, result);
  }
  const source = query.get('source') || 'account';
  const search = query.get('search')?.trim() || '';
  const accent = query.get('accent') || '';
  const gender = query.get('gender') || '';
  const cursor = query.get('cursor') || '';
  if (!['account', 'library'].includes(source) || search.length > 200 || cursor.length > 2048
    || accent.length > 100 || /[\u0000-\u001f\u007f]/.test(accent)
    || (gender && !['male', 'female'].includes(gender))) throw new HttpError(400, 'Invalid voice search filters.');
  const shared = source === 'library';
  if (shared && cursor && !/^\d{1,6}$/.test(cursor)) throw new HttpError(400, 'Invalid voice library page.');
  if (refresh) for (const path of cache.keys()) if (!path.startsWith('/v1/voices/accents?')) cache.delete(path);
  let subscription;
  try {
    subscription = await cached('/v1/user/subscription', 60_000, async () => {
      const result = await send('/v1/user/subscription');
      const tier = text(result?.tier).toLowerCase();
      if (!tier) throw new HttpError(502, 'ElevenLabs did not return subscription information.');
      return { tier, status: text(result.status) };
    });
  }
  catch (e) {
    if (e instanceof HttpError && [499, 504].includes(e.status)) throw e;
    throw new HttpError(502, 'Could not verify your ElevenLabs subscription. Check connectivity and the API key User read permission, then retry.');
  }
  const tier = subscription.tier;
  const unavailableReason = ['free_disabled', 'incomplete'].includes(subscription.status) ? 'account_unavailable' : shared && tier === 'free' ? 'paid_required' : null;
  if (unavailableReason) return json(res, 200, { voices: [], nextCursor: null, total: 0, tier, unavailableReason });
  const params = new URLSearchParams({ page_size: '30', ...(search ? { search } : {}), ...(language ? { language } : {}), ...(accent ? { accent } : {}), ...(gender ? { gender } : {}) });
  if (shared) params.set('page', cursor || '0');
  else {
    params.set('sort', 'name');
    params.set('sort_direction', 'asc');
    params.set('include_total_count', 'false');
    if (cursor) params.set('next_page_token', cursor);
  }
  const path = `${shared ? '/v1/shared-voices' : '/v2/voices'}?${params}`;
  const result = await cached(path, 120_000, async () => {
    const result = await send(path);
    if (!Array.isArray(result?.voices)) throw new HttpError(502, 'ElevenLabs did not return a voice list.');
    const more = result.has_more === true;
    const next = shared ? String(Number(cursor || '0') + 1) : text(result.next_page_token);
    if (more && (!next || next === cursor)) throw new HttpError(502, 'ElevenLabs did not return the next voice page.');
    return { voices: result.voices, more, next, total: Number.isInteger(result.total_count) && result.total_count >= 0 ? result.total_count : null };
  });
  const voices = result.voices.filter((/** @type {any} */ v) => v && text(v.voice_id) && availableVoice(v, tier)).map((/** @type {any} */ v) => shownVoice(v, shared, language, accent));
  const total = shared && voices.length === result.voices.length ? result.total : null;
  return json(res, 200, { voices, nextCursor: result.more ? result.next : null, total, tier, unavailableReason: null });
}
