import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAppTimeZone } from './appConfig';
import { zonedDateKey } from './timeZone';

export type ResearchKind = 'meeting' | 'reading' | 'waiting';
export type ResearchNote = { id: string; kind: ResearchKind; project: string; title: string; date: string; fields: Record<string, string> };
export type ResearchOverview = { notes: ResearchNote[]; warnings: string[] };
export type ResearchProject = { slug: string; name: string; next: string; summary: string; status?: string };
export type WaitingItem = { owner: string; detail: string; line: number; source: string };
export type ResearchReview = { plan_id: string; destination: string; before: string; after: string; state_link?: boolean };
type DraftContent = { notes: Record<string, ResearchNote>; bases: Record<string, ResearchNote | null> };
type Drafts = DraftContent & { revision: number };

export const noteLabels = { meeting: 'Reunión', reading: 'Lectura', waiting: 'En espera' };
export const noteFields: Record<ResearchKind, Array<[string, string, string]>> = {
  meeting: [['participants', 'Participantes', 'Quién participa'], ['agenda', 'Agenda y preguntas', 'Qué necesitamos resolver'], ['references', 'Figuras y referencias', 'Documento, figura, página o enlace que quieres discutir'], ['notes', 'Notas', 'Lo que se ha discutido'], ['decisions', 'Acuerdos', 'Solo decisiones confirmadas'], ['actions', 'Próximas acciones', 'Acción · responsable · fecha, si se acordó']],
  reading: [['source', 'Paper', 'Referencia o ubicación en Biblioteca'], ['idea', 'Idea aprovechable', 'Qué mecanismo o método merece la pena retener'], ['question', 'Pregunta abierta', 'Qué necesitas entender o comprobar'], ['application', 'Aplicación al proyecto', 'Qué prueba concreta sugiere para tu modelo']],
  waiting: [['source', 'Fuente', 'Documento o mensaje donde consta esta dependencia'], ['owner', 'De quién depende', 'Persona o equipo'], ['since', 'Desde cuándo', 'Fecha documentada; déjalo vacío si no consta'], ['unblocks', 'Qué desbloquea', 'Qué podrás hacer cuando llegue la respuesta'], ['meanwhile', 'Qué puedo avanzar mientras tanto', 'Una acción independiente de esta respuesta']],
};
/** Hoy (`YYYY-MM-DD`) en la zona horaria de la configuración. */
export const configuredToday = () => zonedDateKey(new Date(), getAppTimeZone());
export const blankNote = (kind: ResearchKind, seed: Partial<ResearchNote> = {}): ResearchNote => ({ id: '', kind, project: '', title: '', date: configuredToday(), fields: {}, ...seed });

/** Coalesced serial writer: a failed save retains the newest draft, and flush
 * waits for edits queued while an earlier native write was in flight. */
export class ResearchDraftWriter {
  private pending: DraftContent | null = null;
  private flight: Promise<void> | null = null;
  constructor(private revision: number, private save: (drafts: Drafts) => Promise<number>) {}
  queue(content: DraftContent) { this.pending = content; }
  flush(): Promise<void> {
    if (!this.flight) this.flight = Promise.resolve().then(async () => {
      while (this.pending) {
        const content = this.pending; this.pending = null;
        try { this.revision = await this.save({ revision: this.revision, ...content }); }
        catch (error) { this.pending ??= content; throw error; }
      }
    }).finally(() => { this.flight = null; });
    return this.flight.then(() => this.pending ? this.flush() : undefined);
  }
}

export function useResearch() {
  const [overview, setOverview] = useState<ResearchOverview>({ notes: [], warnings: [] });
  const [drafts, setDrafts] = useState<Record<string, ResearchNote>>({});
  const draftsRef = useRef(drafts);
  const basesRef = useRef<Record<string, ResearchNote | null>>({});
  const notesRef = useRef(overview.notes);
  notesRef.current = overview.notes;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const writer = useRef<ResearchDraftWriter | null>(null);
  const writeBusy = useRef(false);
  const setWriteBusy = useCallback((busy: boolean) => { writeBusy.current = busy; }, []);
  const isWriting = useCallback(() => writeBusy.current, []);
  const initialization = useRef<Promise<void> | null>(null);
  const refresh = useCallback(async () => {
    try { setOverview(await invoke<ResearchOverview>('research_overview')); }
    catch (reason) { setOverview(current => ({ ...current, warnings: [String(reason)] })); }
  }, []);
  useEffect(() => {
    let cancelled = false;
    initialization.current = Promise.resolve().then(async () => {
      try {
        if (!('__TAURI_INTERNALS__' in window)) { setError('Las notas de proyecto requieren la app de escritorio.'); return; }
        const loaded = await invoke<Drafts>('research_load_drafts');
        if (cancelled) return;
        draftsRef.current = loaded.notes; basesRef.current = loaded.bases; setDrafts(loaded.notes);
        writer.current = new ResearchDraftWriter(loaded.revision, (value) => invoke<number>('research_save_drafts', { drafts: value }));
        setReady(true);
      } catch (reason) { if (!cancelled) setError(String(reason)); }
    });
    void refresh();
    return () => { cancelled = true; };
  }, [refresh]);
  const flush = useCallback(async () => {
    await initialization.current;
    if (!writer.current) {
      if (Object.keys(draftsRef.current).length) throw new Error('Los borradores de investigación no se pueden guardar.');
      return;
    }
    setSaving(true);
    try { await writer.current.flush(); setError(''); }
    catch (reason) { setError(String(reason)); throw reason; }
    finally { setSaving(false); }
  }, []);
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => { void flush().catch(() => {}); }, 350);
    return () => window.clearTimeout(timer);
  }, [drafts, ready, flush]);
  const putDraft = useCallback((key: string, note: ResearchNote | null, savedBase?: ResearchNote) => {
    if (!writer.current) { setError('Los borradores aún no están disponibles.'); return false; }
    const next = { ...draftsRef.current };
    const bases = { ...basesRef.current };
    if (note) {
      if (!(key in bases)) bases[key] = notesRef.current.find(value => value.id === note.id) ?? null;
      if (savedBase) bases[key] = savedBase;
      next[key] = note;
    } else { delete next[key]; delete bases[key]; }
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    if (Object.keys(next).length > 48 || bytes({ revision: 0, notes: next, bases }) > 2 * 1024 * 1024 || (note && bytes(note) > 86 * 1024)) {
      setError('Se ha alcanzado el límite de borradores. Conserva el contenido en una nota del proyecto antes de añadir más.');
      return false;
    }
    basesRef.current = bases; draftsRef.current = next; setDrafts(next); writer.current.queue({ notes: next, bases }); return true;
  }, []);
  const getDraft = useCallback((id: string) => draftsRef.current[id], []);
  const captureFocused = useCallback(() => {
    const field = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const key = field?.dataset.researchDraft;
    const name = field?.dataset.researchField;
    if (!key || !name || !draftsRef.current[key]) return;
    const note = draftsRef.current[key];
    putDraft(key, name.startsWith('fields.') ? { ...note, fields: { ...note.fields, [name.slice(7)]: field!.value } } : { ...note, [name]: field!.value });
  }, [putDraft]);
  const exportDrafts = useCallback(async () => {
    try {
      const result = await invoke<{ saved: boolean; filename: string | null }>('research_export_drafts', { drafts: { revision: 0, notes: draftsRef.current, bases: basesRef.current } });
      if (result.saved) setError(`Copia exportada: ${result.filename}`);
    } catch (reason) { setError(String(reason)); }
  }, []);
  return { ...overview, drafts, bases: basesRef.current, ready, error, saving, putDraft, refresh, flush, captureFocused, exportDrafts, setOverview, setWriteBusy, isWriting, getDraft };
}
export type Research = ReturnType<typeof useResearch>;
