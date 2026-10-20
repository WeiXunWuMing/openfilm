/** Translate provider metadata while preserving names and unfamiliar terms verbatim. */
export function voiceLabel(value: string | null | undefined, t: (key: string) => string): string {
  if (!value) return '';
  const key = `voices.labels.${value.trim().toLowerCase().replace(/[\s-]+/g, '_')}`;
  const translated = t(key);
  return translated === key ? value : translated;
}

export function voiceError(message: string, t: (key: string) => string): string {
  if (message.includes('Connect ElevenLabs in Settings') || message === 'ElevenLabs is not connected.') return t('voices.connectFirst');
  if (message.includes('ElevenLabs did not respond within')) return t('voices.timeout');
  if (message.includes("ElevenLabs doesn't have enough balance")) return t('voices.notEnoughCredits');
  if (message.includes('ElevenLabs did not accept your key')) return t('voices.keyPermission');
  if (message.startsWith('Could not verify your ElevenLabs subscription.')) return t('voices.subscriptionFailed');
  if (message.includes('ElevenLabs did not return') || message.includes('ElevenLabs returned an invalid voice')) return t('voices.invalidResponse');
  return message;
}
