import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceLabel, voiceError } from '../chat/src/lib/voice-labels.ts';
import { zhCN } from '../chat/src/i18n/locales/zh-CN.ts';
import { enUS } from '../chat/src/i18n/locales/en-US.ts';
import { lookup } from '../chat/src/i18n/lookup.ts';

const zh = (key) => lookup(zhCN, key);
const en = (key) => lookup(enUS, key);

test('common voice metadata and accents are translated without changing provider values', () => {
  for (const [original, translated] of [['American', '美式'], ['beijing mandarin', '普通话（北京）'], ['middle-aged', '中年'], ['social_media', '社交媒体'], ['warm', '温暖'], ['female', '女声'], ['casual', '随和'], ['chill', '松弛'], ['classy', '优雅']]) {
    assert.equal(voiceLabel(original, zh), translated);
  }
  assert.equal(voiceLabel('american', en), 'American');
  assert.equal(voiceLabel(null, zh), '');
});

test('names, unknown technical terms and creator-written descriptions are preserved', () => {
  for (const original of ['ElevenLabs', 'Starter', 'Sophia - Warm Narrator', 'A warm and calm narrator.', 'custom_unknown']) assert.equal(voiceLabel(original, zh), original);
});

test('app-owned voice errors are localized and unfamiliar provider details are retained', () => {
  assert.equal(voiceError('ElevenLabs is not connected.', zh), zh('voices.connectFirst'));
  assert.equal(voiceError('ElevenLabs did not respond within 20 seconds.', zh), zh('voices.timeout'));
  assert.equal(voiceError('Could not verify your ElevenLabs subscription. Check connectivity and the API key User read permission, then retry.', zh), zh('voices.subscriptionFailed'));
  assert.equal(voiceError('ElevenLabs did not return a voice list.', zh), zh('voices.invalidResponse'));
  assert.equal(voiceError("ElevenLabs doesn't have enough balance for this.", zh), zh('voices.notEnoughCredits'));
  assert.equal(voiceError('ElevenLabs did not accept your key (403).', zh), zh('voices.keyPermission'));
  assert.equal(voiceError('Upstream specific error: custom_rate', zh), 'Upstream specific error: custom_rate');
});
