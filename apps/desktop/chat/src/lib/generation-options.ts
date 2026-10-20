import type { ElevenLabsVoice } from 'openfilm/studio-ui/lib/providers.ts';
import { DEFAULT_VOICE_SETTINGS, type ElevenLabsVoiceSettings } from 'openfilm/studio-ui/lib/providers.ts';
export type { ElevenLabsVoice } from 'openfilm/studio-ui/lib/providers.ts';

export const GENERATION_KINDS = ['subtitles', 'emphasis', 'voiceover', 'music'] as const;
export type GenerationKind = typeof GENERATION_KINDS[number];

export type GenerationOptions = Record<GenerationKind, boolean> & { voice: ElevenLabsVoice | null; voiceSettings: ElevenLabsVoiceSettings | null; prompts: Partial<Record<GenerationKind, string>> };
/** null leaves the configured provider in use until a voice or advanced settings are chosen. */
export const EMPTY_GENERATION: GenerationOptions = { subtitles: false, emphasis: false, voiceover: false, music: false, voice: null, voiceSettings: null, prompts: {} };

export function generationText(options: GenerationOptions, kind: GenerationKind, t: (key: string) => string): string {
  return options.prompts[kind] ?? t(`generation.${kind}Prompt`);
}

export function generationSummary(options: GenerationOptions, t: (key: string) => string): string {
  const lines = GENERATION_KINDS.filter((kind) => options[kind]).map((kind) => generationText(options, kind, t));
  const settings = options.voiceSettings ?? DEFAULT_VOICE_SETTINGS;
  if (options.voiceover && options.voice) lines.push(t('generation.voiceSummary').replace('{voice}', options.voice.name),
    t('generation.voiceSettingsSummary').replace('{stability}', String(Math.round(settings.stability * 100))).replace('{similarity}', String(Math.round(settings.similarity * 100))));
  return lines.join('\n\n');
}

export function selectedVoicePrompt(options: GenerationOptions, t: (key: string) => string): string {
  if (!options.voiceover || !options.voice) return '';
  return [t('generation.voiceoverWithVoice'), t('generation.selectedVoice').replace('{voice}', JSON.stringify({ provider: 'elevenlabs', voiceId: options.voice.voiceId, name: options.voice.name, ...(options.voiceSettings ?? DEFAULT_VOICE_SETTINGS) })), t('generation.voiceSettingsInstruction')].join('\n');
}

export function generationPrompt(options: GenerationOptions, t: (key: string) => string): string {
  const lines = GENERATION_KINDS.map((kind) => t(`generation.${kind}${options[kind] ? 'On' : 'Off'}`));
  if (options.voiceover && options.voice) {
    lines.push(selectedVoicePrompt(options, t));
  } else if (options.voiceover && options.voiceSettings) {
    lines.push(t('generation.voiceSettingsOnly').replace('{settings}', JSON.stringify({ provider: 'elevenlabs', ...options.voiceSettings })), t('generation.voiceSettingsInstruction'));
  }
  return [`[OpenFilm: ${t('generation.title')}]`, t('generation.rules'), ...lines, '[/OpenFilm]'].join('\n');
}

/** The checkboxes remain authoritative even if their generated text was edited or deleted. */
export function withGenerationPrompt(text: string, prompt: string): string {
  const draft = text.replace(/\n*\[OpenFilm: [^\n]*\]\n[\s\S]*?\n\[\/OpenFilm\]/g, '').trim();
  return draft ? `${draft}\n\n${prompt}` : prompt;
}
