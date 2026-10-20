import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_GENERATION, GENERATION_KINDS, generationPrompt, generationSummary, generationText, selectedVoicePrompt, withGenerationPrompt } from '../chat/src/lib/generation-options.ts';
import { zhCN } from '../chat/src/i18n/locales/zh-CN.ts';
import { lookup } from '../chat/src/i18n/lookup.ts';
import { chooseProvider } from '../../../packages/openfilm/studio/server/providers/index.mjs';

const t = (key) => key;
const voice = { voiceId: 'voice-1', name: 'Ada', language: 'zh', description: 'Warm narrator' };

test('every turn explicitly forbids each unchecked type, including when all options are off', () => {
  const prompt = generationPrompt(EMPTY_GENERATION, t);
  for (const kind of GENERATION_KINDS) assert.ok(prompt.includes(`generation.${kind}Off`));
  assert.ok(prompt.includes('generation.rules'));
  assert.ok(!prompt.includes('voiceId'));
  const mixed = generationPrompt({ ...EMPTY_GENERATION, subtitles: true, music: true }, t);
  assert.ok(mixed.includes('generation.subtitlesOn'));
  assert.ok(mixed.includes('generation.musicOn'));
  assert.ok(mixed.includes('generation.emphasisOff'));
  assert.ok(mixed.includes('generation.voiceoverOff'));
});

test('voice-over includes the exact ElevenLabs voice, and ignores a stale voice when unchecked', () => {
  const words = (key) => key === 'generation.selectedVoice' ? 'Voice: {voice}' : key;
  const prompt = generationPrompt({ ...EMPTY_GENERATION, voiceover: true, voice }, words);
  assert.ok(prompt.includes(JSON.stringify({ provider: 'elevenlabs', voiceId: voice.voiceId, name: voice.name, stability: 0.5, similarity: 0.75 })));
  assert.ok(!generationPrompt({ ...EMPTY_GENERATION, voice }, words).includes('voice-1'));
});

test('toggling replaces the managed prompt without duplicating it or removing the draft and reference markers', () => {
  const first = generationPrompt({ ...EMPTY_GENERATION, subtitles: true }, t);
  const next = generationPrompt(EMPTY_GENERATION, t);
  const draft = 'Make a film with {{reference}}.';
  const combined = withGenerationPrompt(`${draft}\n\n${first}\n\nKeep my extra instruction.`, next);
  assert.equal(combined, `${draft}\n\nKeep my extra instruction.\n\n${next}`);
  assert.equal(withGenerationPrompt(combined, next), combined);
});

test('sending restores the current restrictions when the generated text was edited or deleted', () => {
  const prompt = generationPrompt(EMPTY_GENERATION, t);
  const edited = prompt.replace('generation.musicOff', 'Please add music.');
  assert.equal(withGenerationPrompt(`My request\n\n${edited}`, prompt), `My request\n\n${prompt}`);
  assert.equal(withGenerationPrompt('My request', prompt), `My request\n\n${prompt}`);
  assert.equal(withGenerationPrompt('', prompt), prompt);
});

test('the four editable defaults do not require a chosen voice', () => {
  const words = (key) => lookup(zhCN, key);
  const options = { ...EMPTY_GENERATION, subtitles: true, emphasis: true, voiceover: true, music: true };
  const text = generationSummary(options, words);
  for (const [index, name] of ['字幕', '花字', '配音', '音乐'].entries()) {
    assert.equal(generationText(options, GENERATION_KINDS[index], words), `需要生成贴合影片内容的${name}，其他需求：`);
    assert.ok(text.includes(`需要生成贴合影片内容的${name}，其他需求：`));
  }
  assert.ok(!text.includes('voiceId') && !text.includes('[/OpenFilm]'));
  assert.equal(selectedVoicePrompt(options, words), '');
  assert.ok(!generationPrompt(options, words).includes('voiceId'));
  assert.ok(!generationPrompt(options, words).includes('"stability"'));
  assert.ok(selectedVoicePrompt({ ...options, voice }, words).includes('voice-1'));
});

test('basic voice-over leaves the configured provider in use until ElevenLabs is explicitly selected', async () => {
  const words = (key) => lookup(zhCN, key);
  const options = { ...EMPTY_GENERATION, voiceover: true };
  const settings = { keys: { azure: 'eastus:mock-key-0123456789' }, use: { tts: 'azure' }, model: {}, off: ['elevenlabs'], custom: [] };
  assert.equal((await chooseProvider('tts', { settings })).id, 'azure');
  assert.doesNotMatch(generationPrompt(options, words), /ElevenLabs|--via|--stability|"provider"/);
  const chosen = generationPrompt({ ...options, voice }, words);
  assert.ok(chosen.includes('"provider":"elevenlabs"') && chosen.includes('"stability":0.5,"similarity":0.75'));
});

test('editing or restoring advanced settings opts into ElevenLabs for this turn without requiring a voice', () => {
  const words = (key) => lookup(zhCN, key);
  for (const voiceSettings of [{ stability: 0.3, similarity: 0.8 }, { stability: 0.5, similarity: 0.75 }]) {
    const options = { ...EMPTY_GENERATION, voiceover: true, voiceSettings };
    const prompt = generationPrompt(options, words);
    assert.ok(prompt.includes(JSON.stringify({ provider: 'elevenlabs', ...voiceSettings })));
    assert.ok(prompt.includes('--via elevenlabs'));
    assert.ok(!prompt.includes('voiceId'));
    assert.ok(!generationPrompt({ ...options, voiceover: false }, words).includes('"stability"'));
  }
  assert.equal(EMPTY_GENERATION.voiceSettings, null);
});

test('voice settings use API units, apply only to the checked turn, and reset with the other options', () => {
  const words = (key) => lookup(zhCN, key);
  const options = { ...EMPTY_GENERATION, voiceover: true, voice, voiceSettings: { stability: 0.31, similarity: 0.89 } };
  assert.ok(generationSummary(options, words).includes('稳定性 31% · 相似度 89%'));
  const prompt = generationPrompt(options, words);
  assert.ok(prompt.includes('"stability":0.31,"similarity":0.89'));
  assert.ok(prompt.includes('--stability') && prompt.includes('--similarity'));
  assert.ok(!generationPrompt({ ...options, voiceover: false }, words).includes('"stability"'));
  assert.equal(EMPTY_GENERATION.voiceSettings, null);
});

test('custom requirements are retained while hidden and sent only for checked types', () => {
  const words = (key) => lookup(zhCN, key);
  const prompts = { subtitles: '只要英文字幕，白色。', music: '音乐轻快，降低音量。' };
  const options = { ...EMPTY_GENERATION, subtitles: true, prompts };
  assert.equal(generationSummary(options, words), prompts.subtitles);
  assert.ok(!generationSummary(options, words).includes(prompts.music));
  assert.ok(generationPrompt(options, words).includes('音乐：严格禁止'));
  assert.ok(generationSummary({ ...options, music: true }, words).includes(prompts.music));
  assert.equal(generationText({ ...options, prompts: { subtitles: '' } }, 'subtitles', words), '');
  assert.deepEqual(EMPTY_GENERATION.prompts, {});
});

test('the visible requirements include the selected voice name while technical ids stay in the hidden rules', () => {
  const words = (key) => lookup(zhCN, key);
  const options = { ...EMPTY_GENERATION, voiceover: true, voice, prompts: { voiceover: '使用中文，25秒以内。' } };
  const visible = generationSummary(options, words);
  assert.ok(visible.includes('使用中文，25秒以内。') && visible.includes('Ada'));
  assert.ok(!visible.includes('voice-1') && !visible.includes('provider'));
  assert.ok(generationPrompt(options, words).includes('voice-1'));
  assert.equal(generationSummary({ ...options, voiceover: false }, words), '');
  assert.equal(generationSummary(EMPTY_GENERATION, words), '');
});
