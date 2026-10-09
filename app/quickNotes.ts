
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useState } from 'react';

export type MeetingLink = { project: string; id: string; title: string };
export type QuickNote = {
  id: string;
  category: string;
  title: string;
  body: string;
  created_ms: number;
  updated_ms: number;
  meeting: MeetingLink | null;
  logged_ms: number | null;
  /** The Logout has read the current content. */
  logged: boolean;
  meeting_exists: boolean;
  deletable: boolean;
  delete_reason: string;
};
export type QuickNotesView = { revision: number; notes: QuickNote[] };
export type QuickNoteDraft = { id?: string; category: string; title: string; body: string; meeting: MeetingLink | null };

export const QUICK_NOTE_SHORTCUT = '⇧Ctrl/⌘N';
export const baseCategories = [
  { slug: 'general', label: 'General' },
  { slug: 'burocracia', label: 'Gestiones' },
];

/** Pending notes as the Logout sees them: its own first-hand captures, bounded. */
export const quickNotesSnapshot = (view: QuickNotesView | null, error: string | null) => {
  if (!view) return { status: error ? 'unavailable' : 'not_loaded', error, notes: [] };
  const pending = view.notes.filter((note) => !note.logged).slice(0, 60);
  return {
    status: 'available',
    error: null,
    description: 'Your own quick notes (meetings, events, things not to forget) not yet recorded by a Logout.',
    pending_count: pending.length,
    notes: pending.map((note) => ({
      id: note.id,
      category: note.category,
      title: note.title,
      body: note.body.slice(0, 4000),
      updated_at: new Date(note.updated_ms).toISOString(),
      meeting: note.meeting ? { project: note.meeting.project, title: note.meeting.title } : null,
    })),
  };
};
/** Exact versions a Logout reads; only these are marked as recorded afterwards. */
export const pendingQuickNoteVersions = (view: QuickNotesView | null) => (view?.notes ?? [])
  .filter((note) => !note.logged).slice(0, 60).map((note) => ({ id: note.id, updated_ms: note.updated_ms }));

export function useQuickNotes(enabled: boolean) {
  const [view, setView] = useState<QuickNotesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const available = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const refresh = useCallback(async () => {
    if (!enabled) return null;
    if (!('__TAURI_INTERNALS__' in window)) { setError('Las notas rápidas funcionan dentro de Esprit.'); return null; }
    try { const next = await invoke<QuickNotesView>('quick_notes_load'); setView(next); setError(null); return next; }
    catch (reason) { setError(String(reason)); return null; }
  }, [enabled]);
  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => window.clearTimeout(timer); }, [refresh]);
  const save = useCallback(async (draft: QuickNoteDraft) => {
    const current = view ?? await refresh();
    const next = await invoke<QuickNotesView>('quick_notes_save', { request: { id: draft.id ?? null, category: draft.category, title: draft.title, body: draft.body, meeting: draft.meeting, expected_revision: current?.revision ?? 0 } });
    setView(next);
    return next;
  }, [view, refresh]);
  const remove = useCallback(async (id: string) => {
    const next = await invoke<QuickNotesView>('quick_notes_delete', { id, expectedRevision: view?.revision ?? 0, confirmed: true });
    setView(next);
  }, [view]);
  const markLogged = useCallback(async (versions: Array<{ id: string; updated_ms: number }>) => {
    if (!versions.length) return;
    try { setView(await invoke<QuickNotesView>('quick_notes_mark_logged', { entries: versions })); }
    catch (reason) { setError(String(reason)); }
  }, []);
  return { view, notes: view?.notes ?? [], error, available, refresh, save, remove, markLogged };
}
export type QuickNotes = ReturnType<typeof useQuickNotes>;
