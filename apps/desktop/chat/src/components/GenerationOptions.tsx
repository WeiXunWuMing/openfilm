import React from 'react';
import { Captions, Check, ChevronDown, FileText, Mic, Music, Type } from 'lucide-react';
import { useT } from '@/i18n';
import { GENERATION_KINDS, generationText, type GenerationOptions as Options } from '@/lib/generation-options';
import { DEFAULT_VOICE_SETTINGS } from 'openfilm/studio-ui/lib/providers.ts';
import { VoicePicker } from './VoicePicker';

const ICONS = { subtitles: Captions, emphasis: Type, voiceover: Mic, music: Music };

export function GenerationOptions({ value, onChange, onFocusComposer, onSubmit }: {
  value: Options;
  onChange: (next: Options) => void;
  onFocusComposer: () => void;
  onSubmit: () => void;
}) {
  const t = useT();
  const [voicesOpen, setVoicesOpen] = React.useState(false);
  const selected = GENERATION_KINDS.filter((kind) => value[kind]);
  React.useEffect(() => { if (!value.voiceover) setVoicesOpen(false); }, [value.voiceover]);
  return (
    <div className="border-t border-[var(--border)] px-3 py-2">
      <fieldset className="flex flex-wrap items-center gap-1.5">
        <legend className="sr-only">{t('generation.title')}</legend>
        {GENERATION_KINDS.map((kind) => {
          const Icon = ICONS[kind];
          return <div key={kind} data-generation-kind={kind} data-generation-active={value[kind] || undefined}
            className={`generation-option flex items-center rounded-lg border text-[12px] transition-colors focus-within:ring-1 focus-within:ring-[var(--accent)] ${value[kind]
              ? 'text-[var(--text)]' : 'border-transparent text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'}`}>
            <label className="flex cursor-pointer items-center gap-1.5 px-2 py-1">
              <input type="checkbox" className="sr-only" checked={value[kind]} onChange={(event) => {
                onChange({ ...value, [kind]: event.target.checked, ...(kind === 'voiceover' && !event.target.checked ? { voice: null } : {}) });
                if (event.nativeEvent instanceof MouseEvent && event.nativeEvent.detail > 0) requestAnimationFrame(onFocusComposer);
              }} />
              {value[kind] ? <Check size={12} className="text-[var(--generation-ink)]" /> : <Icon size={12} />}{t(`generation.${kind}`)}
            </label>
            {kind === 'voiceover' && value.voiceover ? <button type="button" aria-label={t('generation.voice')} title={value.voice?.name ?? t('generation.chooseVoice')}
              className="flex max-w-[100px] items-center gap-1 border-l border-[var(--border)] px-1.5 py-1 text-[var(--generation-ink)] hover:bg-[var(--bg-hover)]"
              onClick={() => setVoicesOpen(true)}>
              {value.voice ? <span className="truncate text-[11px] text-[var(--text)]">{value.voice.name}</span> : null}<ChevronDown size={12} className="shrink-0" />
            </button> : null}
          </div>;
        })}
      </fieldset>
      {selected.length ? <details data-generation-prompts className="group mt-1" onToggle={(event) => { if (!event.currentTarget.open) requestAnimationFrame(onFocusComposer); }}>
        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded px-1 py-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text)]">
          <FileText size={12} /><span className="flex-1">{t('generation.manage')} · {t('generation.selectedCount').replace('{count}', String(selected.length))}</span>
          <span className="group-open:hidden">{t('generation.expand')}</span><span className="hidden group-open:inline">{t('generation.collapse')}</span><ChevronDown size={12} className="transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-1 max-h-56 space-y-2 overflow-y-auto">
          {selected.map((kind) => <section key={kind} data-generation-kind={kind} className="generation-requirement rounded-r-lg px-2 py-1.5">
            <label htmlFor={`generation-${kind}`} className="mb-1 block text-[11px] font-medium text-[var(--text-muted)]">{t(`generation.${kind}`)}</label>
            <textarea id={`generation-${kind}`} rows={2} value={generationText(value, kind, t)}
              className="block max-h-32 min-h-10 w-full resize-y bg-transparent text-[12px] leading-5 text-[var(--text)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
              onChange={(event) => onChange({ ...value, prompts: { ...value.prompts, [kind]: event.target.value } })}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                event.preventDefault(); onSubmit();
              }} />
            {kind === 'voiceover' && value.voice ? <p className="mt-1 text-[11px] text-[var(--text-muted)]">{t('generation.voiceSummary').replace('{voice}', value.voice.name)}</p> : null}
          </section>)}
        </div>
        <p className="mt-1 px-1 text-[10px] text-[var(--text-muted)]">{t('generation.hint')}</p>
      </details> : null}
      {voicesOpen ? <VoicePicker selected={value.voice} settings={value.voiceSettings ?? DEFAULT_VOICE_SETTINGS} onSettingsChange={(voiceSettings) => onChange({ ...value, voiceSettings })} onClose={() => setVoicesOpen(false)} onPick={(voice) => {
        onChange({ ...value, voiceover: true, voice }); setVoicesOpen(false); requestAnimationFrame(onFocusComposer);
      }} /> : null}
    </div>
  );
}
