'use client';

import { useEffect, useId, useRef, useState } from 'react';

export type ChatEngine = 'codex' | 'claude';
export type CodexModel = 'gpt-6-astra' | 'gpt-6.1-sol' | 'gpt-6-luna';
/** Still readable in stored history and preferences; never offered or dispatched. */
export type RetiredCodexModel = 'gpt-6-sol' | 'gpt-5.6-luna' | 'gpt-5.6-terra' | 'gpt-5.6-sol';
export type ClaudeModel = 'haiku' | 'claude-sonnet-5-5' | 'opus';
export type RetiredClaudeModel = 'sonnet' | 'fable';
export type AgentModel = CodexModel | ClaudeModel;
// Each native model advertises the subset of efforts it supports.
export type CodexEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

type ContextOption = { value: string; label: string; note?: string };
type EngineOption = { value: ChatEngine; label: string; note: string };
type ModelOption = { value: AgentModel; label: string; note: string };
type EffortOption = { value: CodexEffort; label: string };

type CodexProfilePickerProps = {
  context: string;
  contexts: ContextOption[];
  engine: ChatEngine;
  engines: EngineOption[];
  model: AgentModel;
  models: ModelOption[];
  effort: CodexEffort;
  efforts: EffortOption[];
  disabled?: boolean;
  variant?: 'topbar' | 'chat';
  onContextChange: (value: string) => void;
  onEngineChange: (value: ChatEngine) => void;
  onModelChange: (value: AgentModel) => void;
  onEffortChange: (value: CodexEffort) => void;
};

export default function CodexProfilePicker({
  context,
  contexts,
  engine,
  engines,
  model,
  models,
  effort,
  efforts,
  disabled = false,
  variant = 'topbar',
  onContextChange,
  onEngineChange,
  onModelChange,
  onEffortChange,
}: CodexProfilePickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const activeContext = contexts.find((item) => item.value === context) ?? contexts[0];
  const activeEngine = engines.find((item) => item.value === engine) ?? engines[0];
  const activeModel = models.find((item) => item.value === model) ?? models[0];
  const activeEffort = efforts.find((item) => item.value === effort) ?? efforts[0];

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeWithEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeWithEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeWithEscape, true);
    };
  }, [open]);

  return (
    <div className="codex-profile-picker" data-variant={variant} data-engine={engine} ref={rootRef}>
      <button
        className="codex-profile-trigger"
        ref={triggerRef}
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={popoverId}
        title="Elegir contexto, motor, modelo y razonamiento"
      >
        <span className="codex-trigger-context">{activeContext?.label ?? 'Sin proyecto'}</span>
        <span className="codex-trigger-profile">
          <b>{activeEngine?.label ?? engine}</b><i />{activeModel?.label ?? model}<i />{activeEffort?.label ?? effort}
        </span>
        <span className="codex-trigger-chevron" aria-hidden="true">⌄</span>
      </button>

      {open ? (
        <section className="codex-profile-popover" id={popoverId} role="dialog" aria-label="Perfil del chat cotidiano">
          <header>
            <div><span>{(activeEngine?.label ?? engine).toUpperCase()} / PERFIL</span><strong>Configurar conversación</strong></div>
            <button onClick={() => { setOpen(false); triggerRef.current?.focus(); }} type="button" aria-label="Cerrar selector de perfil">×</button>
          </header>

          <fieldset className="codex-picker-section context-section">
            <legend>CONTEXTO</legend>
            <div className="codex-context-grid" role="radiogroup" aria-label="Contexto del proyecto">
              {contexts.map((item) => (
                <button
                  className={item.value === context ? 'active' : ''}
                  onClick={() => onContextChange(item.value)}
                  type="button"
                  role="radio"
                  aria-checked={item.value === context}
                  key={item.value}
                >
                  <i aria-hidden="true" /><span><strong>{item.label}</strong>{item.note ? <small>{item.note}</small> : null}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="codex-picker-section model-section">
            <legend>MOTOR</legend>
            <div className="codex-model-grid" role="radiogroup" aria-label="Motor de chat">
              {engines.map((item) => (
                <button
                  className={item.value === engine ? 'active' : ''}
                  onClick={() => onEngineChange(item.value)}
                  type="button"
                  role="radio"
                  aria-checked={item.value === engine}
                  key={item.value}
                >
                  <i aria-hidden="true" /><span><strong>{item.label}</strong><small>{item.note}</small></span><b aria-hidden="true">{item.value === engine ? '✓' : ''}</b>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="codex-picker-section model-section">
            <legend>MODELO</legend>
            <div className="codex-model-grid" role="radiogroup" aria-label="Modelo del motor seleccionado">
              {models.map((item) => (
                <button
                  className={item.value === model ? 'active' : ''}
                  onClick={() => onModelChange(item.value)}
                  type="button"
                  role="radio"
                  aria-checked={item.value === model}
                  key={item.value}
                >
                  <i aria-hidden="true" /><span><strong>{item.label}</strong><small>{item.note}</small></span><b aria-hidden="true">{item.value === model ? '✓' : ''}</b>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="codex-picker-section effort-section">
            <legend>RAZONAMIENTO</legend>
            <div className="codex-effort-grid" role="radiogroup" aria-label="Esfuerzo de razonamiento">
              {efforts.map((item) => (
                <button className={item.value === effort ? 'active' : ''} onClick={() => onEffortChange(item.value)} type="button" role="radio" aria-checked={item.value === effort} key={item.value}>{item.label}</button>
              ))}
            </div>
          </fieldset>

          <footer>
            <p>Solo afecta al chat cotidiano. Login, Logout y el radar usan el perfil elegido en Configuración.</p>
            <button onClick={() => { setOpen(false); triggerRef.current?.focus(); }} type="button">Listo</button>
          </footer>
        </section>
      ) : null}
    </div>
  );
}
