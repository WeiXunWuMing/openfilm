import React from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Loader2, Mic, Pause, Play, RefreshCw, Search, X } from 'lucide-react';
import { MenuSelect } from 'openfilm/studio-ui/components/MenuSelect.tsx';
import { addSharedElevenLabsVoice, DEFAULT_VOICE_SETTINGS, generateElevenLabsPreview, loadElevenLabsAccents, loadElevenLabsVoices, type ElevenLabsVoice, type ElevenLabsVoiceSettings, type VoiceAccent, type VoiceFilters, type VoicePage } from 'openfilm/studio-ui/lib/providers.ts';
import { useT, useUiLocale } from '@/i18n';
import { chatLayer } from '@/lib/chat-layer';
import { desktopBridge } from '@/lib/desktop-bridge';
import { voiceError, voiceLabel } from '@/lib/voice-labels';

const LANGUAGES = 'zh en ja ko es fr de pt it ar hi ru vi th id tr pl nl sv uk fil ms ta te ro hu cs el fi no da bg sk hr he'.split(' ');
const BUTTON = 'rounded-lg px-3 py-1.5 text-[12px] transition hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40';

export function VoicePicker({ selected, settings, onSettingsChange, onPick, onClose }: {
  selected: ElevenLabsVoice | null;
  settings: ElevenLabsVoiceSettings;
  onSettingsChange: (settings: ElevenLabsVoiceSettings) => void;
  onPick: (voice: ElevenLabsVoice) => void;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useUiLocale();
  const [filters, setFilters] = React.useState<VoiceFilters>({ source: 'account', search: '', language: '', gender: '', accent: '' });
  const [accents, setAccents] = React.useState<VoiceAccent[]>([]);
  const [accentsLoading, setAccentsLoading] = React.useState(true);
  const [accentError, setAccentError] = React.useState<string | null>(null);
  const [page, setPage] = React.useState<VoicePage | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [moreLoading, setMoreLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);
  const [adding, setAdding] = React.useState<string | null>(null);
  const [playing, setPlaying] = React.useState<string | null>(null);
  const [audioError, setAudioError] = React.useState(false);
  const [auditionVoice, setAuditionVoice] = React.useState(selected);
  const [previewText, setPreviewText] = React.useState(() => t('voices.previewTextDefault'));
  const [generating, setGenerating] = React.useState(false);
  const [generatedAudio, setGeneratedAudio] = React.useState<string | null>(null);
  const [generationError, setGenerationError] = React.useState<string | null>(null);
  const generationRequest = React.useRef<AbortController | null>(null);
  const resolvedVoices = React.useRef(new Map<string, ElevenLabsVoice>());
  const busy = Boolean(adding) || generating;
  const audio = React.useRef<HTMLAudioElement>(null);
  const playback = React.useRef(0);
  const dialog = React.useRef<HTMLDialogElement>(null);
  const search = React.useRef<HTMLInputElement>(null);
  const currentRequest = React.useRef<AbortController | null>(null);
  const accentReload = React.useRef(0);
  const voiceReload = React.useRef(0);
  const previousSearch = React.useRef('');

  React.useEffect(() => {
    const controller = new AbortController();
    setAccents([]);
    setAccentsLoading(true);
    setAccentError(null);
    const refresh = reload !== accentReload.current;
    accentReload.current = reload;
    void loadElevenLabsAccents(filters.language, controller.signal, refresh).then((next) => {
      if (!controller.signal.aborted) setAccents(next.accents);
    }).catch((e: Error) => {
      if (!controller.signal.aborted) setAccentError(voiceError(e.message, t));
    }).finally(() => {
      if (!controller.signal.aborted) setAccentsLoading(false);
    });
    return () => controller.abort();
  }, [filters.language, reload]);

  React.useEffect(() => {
    const element = dialog.current!;
    const player = audio.current;
    element.showModal();
    search.current?.focus();
    return () => { element.close(); playback.current++; player?.pause(); player?.removeAttribute('src'); player?.load(); currentRequest.current?.abort(); generationRequest.current?.abort(); };
  }, []);

  React.useEffect(() => {
    currentRequest.current?.abort();
    const controller = new AbortController();
    currentRequest.current = controller;
    setLoading(true);
    setMoreLoading(false);
    setError(null);
    playback.current++;
    audio.current?.pause();
    setPlaying(null);
    setAudioError(false);
    const refresh = reload !== voiceReload.current;
    voiceReload.current = reload;
    const delay = filters.search && filters.search !== previousSearch.current ? 250 : 0;
    previousSearch.current = filters.search;
    const timer = window.setTimeout(() => {
      void loadElevenLabsVoices(filters, null, controller.signal, refresh).then((next) => {
        if (!controller.signal.aborted) setPage(next);
      }).catch((e: Error) => {
        if (!controller.signal.aborted) { setPage(null); setError(voiceError(e.message, t)); }
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }, delay);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [filters, reload]);

  const more = async () => {
    if (!page?.nextCursor || moreLoading) return;
    const controller = new AbortController();
    currentRequest.current = controller;
    setMoreLoading(true);
    setError(null);
    try {
      const next = await loadElevenLabsVoices(filters, page.nextCursor, controller.signal);
      if (!controller.signal.aborted) setPage({ ...next, voices: [...new Map([...page.voices, ...next.voices].map((voice) => [voice.voiceId, voice])).values()] });
    } catch (e) { if (!controller.signal.aborted) setError(voiceError((e as Error).message, t)); }
    finally { if (!controller.signal.aborted) setMoreLoading(false); }
  };

  const play = (src: string, id: string) => {
    const player = audio.current;
    if (!player) return;
    const attempt = ++playback.current;
    const stop = playing === id && !player.paused;
    player.pause();
    setAudioError(false);
    if (stop) { setPlaying(null); return; }
    player.src = src;
    setPlaying(id);
    void player.play().catch(() => {
      if (playback.current === attempt) { setAudioError(true); setPlaying(null); }
    });
  };

  const clearGenerated = () => {
    playback.current++;
    audio.current?.pause();
    setPlaying(null);
    setAudioError(false);
    setGeneratedAudio(null);
    setGenerationError(null);
  };

  const audition = (voice: ElevenLabsVoice) => {
    clearGenerated();
    setAuditionVoice(resolvedVoices.current.get(voice.voiceId) ?? voice);
  };

  const preview = (voice: ElevenLabsVoice) => {
    if (!voice.previewUrl || busy) return;
    setAuditionVoice(resolvedVoices.current.get(voice.voiceId) ?? voice);
    setGeneratedAudio(null);
    setGenerationError(null);
    play(voice.previewUrl, voice.voiceId);
  };

  const resolveVoice = async (voice: ElevenLabsVoice, signal?: AbortSignal): Promise<ElevenLabsVoice> => {
    const resolved = resolvedVoices.current.get(voice.voiceId);
    if (resolved) return resolved;
    if (!voice.publicOwnerId) return voice;
    const result = await addSharedElevenLabsVoice(voice, signal);
    const copy = { ...voice, voiceId: result.voiceId, publicOwnerId: null };
    resolvedVoices.current.set(voice.voiceId, copy);
    return copy;
  };

  const pick = async (voice: ElevenLabsVoice) => {
    if (busy) return;
    setAdding(voice.voiceId);
    setError(null);
    try {
      const resolved = await resolveVoice(voice);
      playback.current++;
      audio.current?.pause();
      onPick(resolved);
    } catch (e) { setError(voiceError((e as Error).message, t)); }
    finally { setAdding(null); }
  };

  const generatePreview = async () => {
    if (!auditionVoice || !previewText.trim() || busy || generationRequest.current) return;
    const controller = new AbortController();
    generationRequest.current = controller;
    clearGenerated();
    setGenerating(true);
    try {
      const voice = await resolveVoice(auditionVoice, controller.signal);
      if (controller.signal.aborted) return;
      setAuditionVoice(voice);
      const result = await generateElevenLabsPreview(voice.voiceId, previewText.trim(), settings, controller.signal);
      if (controller.signal.aborted) return;
      const src = `data:audio/mpeg;base64,${result.audioBase64}`;
      setGeneratedAudio(src);
      play(src, `generated:${voice.voiceId}`);
    } catch (error) { if (!controller.signal.aborted) setGenerationError(voiceError((error as Error).message, t)); }
    finally {
      if (generationRequest.current === controller) generationRequest.current = null;
      if (!controller.signal.aborted) setGenerating(false);
    }
  };

  const languageNames = React.useMemo(() => new Intl.DisplayNames([locale], { type: 'language' }), [locale]);
  const languageName = (code: string) => { try { return languageNames.of(code) ?? code; } catch { return code; } };
  const languages = [...new Set([...LANGUAGES, ...(filters.language ? [filters.language] : []), ...accents.map((accent) => accent.language), ...(page?.voices.flatMap((voice) => voice.language?.split(', ') ?? []) ?? [])])];
  const accentChoices = new Map(accents.map((accent) => {
    const key = `voices.accentNames.${accent.code}`;
    const translated = t(key);
    const label = voiceLabel(accent.accent, t);
    return [accent.accent, translated !== key ? translated : label !== accent.accent ? label : accent.name];
  }));
  for (const accent of [filters.accent, ...(page?.voices.map((voice) => voice.accent) ?? [])]) if (accent && !accentChoices.has(accent)) accentChoices.set(accent, voiceLabel(accent, t));
  const count = page?.total === null || page?.total === undefined ? String(page?.voices.length ?? 0) : `${page.voices.length} / ${page.total}`;
  const tierName = page?.tier === 'free' ? t('voices.freeTier') : page?.tier ? page.tier[0].toUpperCase() + page.tier.slice(1) : '';
  const emptyMessage = page?.unavailableReason === 'paid_required' ? t('voices.paidRequired')
    : page?.unavailableReason === 'account_unavailable' ? t('voices.accountUnavailable')
      : page?.nextCursor ? t('voices.emptyPage') : t('voices.empty');

  return createPortal(
    <dialog ref={dialog} aria-label={t('voices.title')} data-modal-layer
      className="m-auto h-[min(720px,calc(100dvh-64px))] max-h-none w-[min(820px,calc(100vw-32px))] max-w-none overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--text)] shadow-2xl backdrop:bg-black/55 backdrop:backdrop-blur-sm"
      onCancel={(event) => { event.preventDefault(); if (!adding) onClose(); }}
      onKeyDownCapture={(event) => { if (event.key === 'Escape') event.stopPropagation(); }}
      onClick={(event) => { if (event.target === event.currentTarget && !adding) onClose(); }}>
      <section className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] px-5 py-4">
          <Mic size={18} className="text-[var(--accent)]" />
          <div className="min-w-0 flex-1"><h2 className="text-[16px] font-semibold">{t('voices.title')}</h2><p className="mt-0.5 text-[12px] text-[var(--text-muted)]">{t('voices.subtitle')}</p></div>
          <button type="button" className={BUTTON} disabled={Boolean(adding)} aria-label={t('voices.close')} onClick={onClose}><X size={18} /></button>
        </header>
        <div className="shrink-0 space-y-3 border-b border-[var(--border)] px-5 py-3">
          <div role="tablist" aria-label={t('voices.source')} className="flex gap-1">
            {(['account', 'library'] as const).map((source) => <button key={source} type="button" role="tab" aria-selected={filters.source === source}
              disabled={busy} className={`${BUTTON} ${filters.source === source ? 'bg-[var(--surface-2)] font-medium text-[var(--text)]' : 'text-[var(--text-muted)]'}`}
              onClick={() => setFilters({ ...filters, source })}>{t(`voices.${source}`)}</button>)}
            {page && (loading || !page.unavailableReason) ? <span role={loading ? 'status' : undefined} title={t('voices.filterHint')} className="ml-auto flex items-center gap-1 self-center text-[11px] text-[var(--text-muted)]">
              {loading ? <Loader2 size={12} className="animate-spin" /> : null}{loading ? t('generation.loading') : t('voices.filteredFor').replace('{tier}', tierName)}
            </span> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-w-[180px] flex-1 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3">
              <Search size={14} className="shrink-0 text-[var(--text-muted)]" />
              <input ref={search} type="search" aria-label={t('voices.search')} placeholder={t('voices.search')} maxLength={200} disabled={busy}
                className="h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none" value={filters.search}
                onChange={(event) => setFilters({ ...filters, search: event.target.value })} />
            </label>
            <MenuSelect label={t('voices.language')} value={filters.language} className="w-[125px]" size="md" disabled={busy}
              groups={[{ choices: [{ value: '', label: t('voices.allLanguages') }, ...languages.map((code) => ({ value: code, label: languageName(code) }))] }]}
              onPick={(language) => setFilters({ ...filters, language, accent: '' })} />
            <MenuSelect label={t('voices.accent')} value={filters.accent} className="w-[160px]" size="md" disabled={accentsLoading || busy}
              groups={[{ choices: [{ value: '', label: t('voices.allAccents') }, ...[...accentChoices].map(([value, label]) => ({ value, label }))] }]}
              onPick={(accent) => setFilters({ ...filters, accent })} />
            <MenuSelect label={t('voices.gender')} value={filters.gender} className="w-[105px]" size="md" disabled={busy}
              groups={[{ choices: ['', 'female', 'male'].map((gender) => ({ value: gender, label: t(`voices.${gender || 'allGenders'}`) })) }]}
              onPick={(gender) => setFilters({ ...filters, gender })} />
            <button type="button" className={BUTTON} disabled={loading || busy} title={t('generation.reload')} aria-label={t('generation.reload')} onClick={() => setReload((n) => n + 1)}><RefreshCw size={14} /></button>
          </div>
        </div>
        <div role="tabpanel" aria-label={t(`voices.${filters.source}`)} className="min-h-0 flex-1 overflow-y-auto px-5 py-3" aria-busy={loading || moreLoading}>
          {loading && !page ? <div role="status" className="flex h-32 items-center justify-center gap-2 text-[13px] text-[var(--text-muted)]"><Loader2 size={16} className="animate-spin" />{t('generation.loading')}</div> : null}
          {error ? <p role="alert" className="mb-3 break-words rounded-lg border border-[var(--danger)]/30 p-3 text-[12px] text-[var(--danger)]">{error}</p> : null}
          {accentError && !error ? <p role="alert" className="mb-3 break-words rounded-lg border border-[var(--danger)]/30 p-3 text-[12px] text-[var(--danger)]">{t('voices.accent')}: {accentError}</p> : null}
          {!loading && !error && !page?.voices.length ? <p role="status" className="py-14 text-center text-[13px] text-[var(--text-muted)]">{emptyMessage}</p> : null}
          <div className={`space-y-2 ${loading ? 'opacity-50' : ''}`}>
            {page?.voices.map((voice) => {
              const supportedLanguages = voice.language?.split(', ') ?? [];
              const shownLanguages = filters.language && supportedLanguages.includes(filters.language) ? [filters.language] : supportedLanguages.slice(0, 2);
              return <article key={voice.voiceId} aria-label={voice.name} className="flex items-center gap-3 rounded-xl border border-[var(--border)] p-3 transition-colors hover:bg-[var(--bg-hover)]">
              <button type="button" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text)] transition hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-30"
                disabled={loading || busy || !voice.previewUrl} aria-label={`${t(playing === voice.voiceId ? 'voices.pause' : 'voices.preview')} ${voice.name}`} title={voice.previewUrl ? t('voices.preview') : t('voices.noPreview')}
                onClick={() => preview(voice)}>{playing === voice.voiceId ? <Pause size={16} /> : <Play size={16} />}</button>
              <div className="min-w-0 flex-1">
                <button type="button" disabled={loading || busy} title={t('voices.chooseAudition')} aria-label={`${t('voices.chooseAudition')} ${voice.name}`}
                  className="block max-w-full truncate text-left text-[13px] font-medium hover:text-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50"
                  onClick={() => audition(voice)}>{voice.name}</button>
                <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-[var(--text-muted)]">
                  {supportedLanguages.length ? <span title={supportedLanguages.map(languageName).join(' · ')}>
                    {shownLanguages.map(languageName).join(' · ')}{!filters.language && supportedLanguages.length > shownLanguages.length ? ` +${supportedLanguages.length - shownLanguages.length}` : ''}
                  </span> : null}
                  {voice.gender ? <span>{voiceLabel(voice.gender, t)}</span> : null}
                  {voice.accent ? <span>{accentChoices.get(voice.accent) ?? voiceLabel(voice.accent, t)}</span> : null}
                  {[voice.age, voice.useCase, voice.style].filter(Boolean).map((label, index) => <span key={index}>{voiceLabel(label, t)}</span>)}
                  {!voice.previewUrl ? <span>{t('voices.noPreview')}</span> : null}
                </div>
                {voice.description ? <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-[var(--text-muted)]">{voiceLabel(voice.description, t)}</p> : null}
              </div>
              <button type="button" className={`${BUTTON} flex shrink-0 items-center gap-1 border border-[var(--border)]`} disabled={loading || busy} onClick={() => void pick(voice)}>
                {adding === voice.voiceId ? <Loader2 size={13} className="animate-spin" /> : selected?.voiceId === voice.voiceId ? <Check size={13} /> : null}
                {t(selected?.voiceId === voice.voiceId ? 'voices.selected' : voice.publicOwnerId ? 'voices.addAndUse' : 'voices.use')}
              </button>
              </article>;
            })}
          </div>
          {page?.nextCursor ? <button type="button" className={`${BUTTON} mt-3 flex w-full items-center justify-center gap-2 border border-[var(--border)]`} disabled={moreLoading || loading || busy} onClick={() => void more()}>
            {moreLoading ? <Loader2 size={14} className="animate-spin" /> : null}{t('voices.more')}
          </button> : null}
        </div>
        <details data-voice-advanced className="group shrink-0 border-t border-[var(--border)] px-5">
          <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-[12px] font-medium">
            <span className="flex-1">{t('voices.advanced')}</span><ChevronDown size={14} className="transition-transform group-open:rotate-180" />
          </summary>
          <div className="max-h-[min(310px,42dvh)] space-y-3 overflow-y-auto pb-3 text-[12px]">
            <p className="text-[11px] text-[var(--text-muted)]">{t('voices.advancedHint')}</p>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{t('voices.auditionVoice')}: {auditionVoice?.name ?? t('voices.noAuditionVoice')}</span>
              <button type="button" className={BUTTON} disabled={busy} onClick={() => { clearGenerated(); onSettingsChange({ ...DEFAULT_VOICE_SETTINGS }); }}>{t('voices.restoreDefaults')}</button>
            </div>
            <div className="grid grid-cols-2 gap-5">
              {(['stability', 'similarity'] as const).map((key) => <label key={key} className="block">
                <span className="flex justify-between gap-2"><span>{t(`voices.${key}`)}</span><output>{Math.round(settings[key] * 100)}%</output></span>
                <input type="range" min={0} max={100} step={1} value={Math.round(settings[key] * 100)} disabled={busy} aria-label={t(`voices.${key}`)}
                  className="mt-2 block w-full accent-[var(--accent)]" onChange={(event) => { clearGenerated(); onSettingsChange({ ...settings, [key]: Number(event.target.value) / 100 }); }} />
                <span className="mt-1 flex justify-between text-[10px] text-[var(--text-muted)]"><span>{t(`voices.${key}Low`)}</span><span>{t(`voices.${key}High`)}</span></span>
              </label>)}
            </div>
            <label className="block"><span className="text-[11px] text-[var(--text-muted)]">{t('voices.previewText')}</span>
              <textarea aria-label={t('voices.previewText')} rows={2} maxLength={200} value={previewText} disabled={busy}
                className="mt-1 block w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2 text-[12px] outline-none focus:border-[var(--accent)]"
                onChange={(event) => { clearGenerated(); setPreviewText(event.target.value); }} />
            </label>
            {generationError ? <p role="alert" className="text-[var(--danger)]">{generationError}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={`${BUTTON} flex items-center gap-1 border border-[var(--border)]`} disabled={busy || !auditionVoice || !previewText.trim()} onClick={() => void generatePreview()}>
                {generating ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}{t(generating ? 'voices.generatingPreview' : 'voices.generatePreview')}
              </button>
              {generatedAudio && auditionVoice ? <button type="button" className={BUTTON} disabled={busy} onClick={() => play(generatedAudio, `generated:${auditionVoice.voiceId}`)}>
                {t(playing?.startsWith('generated:') ? 'voices.pause' : 'voices.replayPreview')}
              </button> : null}
              <button type="button" className={`${BUTTON} ml-auto border border-[var(--border)]`} disabled={busy || !auditionVoice} onClick={() => { if (auditionVoice) void pick(auditionVoice); }}>{t('voices.useAuditionVoice')}</button>
            </div>
          </div>
        </details>
        <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border)] px-5 py-3 text-[11px] text-[var(--text-muted)]">
          {filters.source === 'library' && page?.voices.length ? <p className="w-full">{t('voices.creditHint')}</p> : null}
          <span>{t('voices.count').replace('{count}', count)}</span>
          <span className="min-w-0 flex-1">{audioError ? t('voices.previewFailed') : t('voices.previewHint')}</span>
          <button type="button" disabled={Boolean(adding)} className="underline underline-offset-2 hover:text-[var(--text)] disabled:opacity-40" onClick={() => { onClose(); desktopBridge()?.openSettings?.('providers'); }}>{t('composer.openSettings')}</button>
        </footer>
        <audio ref={audio} preload="none" onEnded={() => setPlaying(null)} onError={() => { setAudioError(true); setPlaying(null); }} />
      </section>
    </dialog>, chatLayer(),
  );
}
