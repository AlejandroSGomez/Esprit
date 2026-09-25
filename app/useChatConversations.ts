'use client';

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentModel, ChatEngine, CodexEffort } from './components/CodexProfilePicker';
import { ChatHistoryWriter, mergeConcurrentHistory, mergeRunText } from './chatPersistence';
import { appendChatMessage, draftScope, CHAT_HISTORY_KEY, CHAT_HISTORY_LIMIT, CHAT_ACTIVE_LIMIT, LEGACY_CHAT_KEY, normalizeHistory, reconcileHistory, type ChatActivity, type ChatHistory, type ChatProfile, type NativeConversation } from './chatHistory';

export type ChatCatalog = { engines: Array<{ value: ChatEngine; label: string; models: Array<{ value: AgentModel; label: string; note: string; efforts: CodexEffort[]; default_effort: CodexEffort }> }>; skills?: Array<{ name: string; label: string; description: string }> };
type RunEvent = { run_id: string; conversation_id: string; type: 'status' | 'text' | 'activity' | 'error'; text?: string; label?: string; state?: ChatActivity['state']; item_id?: string; code?: string };
type Reply = ChatProfile & { answer: string; conversation_id: string; run_id: string; conversation: NativeConversation };
type Run = { id: string; conversationId: string; text: string; textItems: Record<string, string>; label: string; activities: ChatActivity[] };
const emptyHistory: ChatHistory = { version: 2, selected_id: null, conversations: [] };
const readJSON = (key: string) => { try { return JSON.parse(window.localStorage.getItem(key) ?? 'null'); } catch { return null; } };
const errorDetails = (error: unknown) => typeof error === 'object' && error && 'message' in error ? { message: String(error.message), code: 'code' in error ? String(error.code) : 'CHAT_ERROR' } : { message: String(error), code: 'CHAT_ERROR' };

export function useChatConversations(profile: ChatProfile, onSelectProfile: (profile: ChatProfile) => void) {
  const [history, setHistory] = useState<ChatHistory>(emptyHistory);
  const historyRef = useRef(history);
  const [catalog, setCatalog] = useState<ChatCatalog | null>(null);
  const [ready, setReady] = useState(false);
  const [warning, setWarning] = useState('');
  const writerRef = useRef<ChatHistoryWriter | null>(null);
  const persistenceReady = useRef(false);
  const blankTouched = useRef(false);
  const selectionTouched = useRef(false);
  const initialization = useRef<Promise<void> | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const runRef = useRef<Run | null>(null);
  const busyRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const runDoneRef = useRef<Promise<void> | null>(null);
  const resolveRunRef = useRef<(() => void) | null>(null);
  const [starting, setStarting] = useState(false);
  const selectProfileRef = useRef(onSelectProfile);
  const profileRef = useRef(profile);
  useLayoutEffect(() => { profileRef.current = profile; selectProfileRef.current = onSelectProfile; }, [profile, onSelectProfile]);

  const update = useCallback((change: (current: ChatHistory) => ChatHistory) => {
    const next = change(historyRef.current);
    historyRef.current = next;
    setHistory(next);
    writerRef.current?.queue(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const stored = normalizeHistory(readJSON(CHAT_HISTORY_KEY));
    const initialProfile = profileRef.current;
    const load = async () => {
      if (cancelled) return;
      historyRef.current = stored;
      setHistory(stored);
      if (!('__TAURI_INTERNALS__' in window)) { persistenceReady.current = true; setReady(true); return; }
      const [catalogResult, nativeResult, savedResult] = await Promise.allSettled([
        invoke<ChatCatalog>('chat_catalog'),
        invoke<{ version: number; conversations: NativeConversation[]; warnings: string[] }>('chat_conversations'),
        invoke<{ history: unknown; revision: number }>('chat_load_history'),
      ]);
      if (cancelled) return;
      if (catalogResult.status === 'fulfilled') setCatalog(catalogResult.value);
      else setWarning(`No se pudo cargar el catálogo: ${errorDetails(catalogResult.reason).message}`);
      let loaded = stored;
      if (savedResult.status === 'fulfilled' && savedResult.value.history) loaded = normalizeHistory(savedResult.value.history);
      // Preserve typing, rename and selection made while native storage loads.
      loaded = mergeConcurrentHistory(stored, loaded, historyRef.current);
      if (nativeResult.status === 'fulfilled') {
        loaded = reconcileHistory(loaded, nativeResult.value.conversations, readJSON(LEGACY_CHAT_KEY));
        if (nativeResult.value.warnings.length) setWarning(nativeResult.value.warnings.join(' '));
      } else setWarning(`Tu historial sigue disponible. No se pudieron comprobar sus sesiones: ${errorDetails(nativeResult.reason).message}`);
      if (blankTouched.current || (!selectionTouched.current && (profileRef.current.engine !== initialProfile.engine || profileRef.current.context !== initialProfile.context))) loaded = { ...loaded, selected_id: null };
      historyRef.current = loaded;
      setHistory(loaded);
      if (savedResult.status === 'fulfilled') {
        const writer = new ChatHistoryWriter({
          save: (history, revision) => invoke('chat_save_history', { history, expectedRevision: revision }),
          load: async () => { const saved = await invoke<{ history: unknown; revision: number }>('chat_load_history'); return { history: normalizeHistory(saved.history), revision: saved.revision }; },
          conflict: (reconciled) => { historyRef.current = reconciled; setHistory(reconciled); setWarning('Se han reunido los cambios de otra ventana con los tuyos.'); },
        }, normalizeHistory(savedResult.value.history), savedResult.value.revision);
        writerRef.current = writer;
        writer.queue(loaded);
        persistenceReady.current = true;
      } else {
        setWarning(`No se pudo abrir el historial nativo; no se sobrescribirá. ${errorDetails(savedResult.reason).message}`);
      }
      const selected = loaded.conversations.find((item) => item.id === loaded.selected_id);
      if (selected) selectProfileRef.current(selected);
      setReady(true);
    };
    const pending = Promise.resolve().then(load);
    initialization.current = pending;
    void pending;
    return () => { cancelled = true; };
  }, []);

  const flush = useCallback(async () => {
    await initialization.current;
    if ('__TAURI_INTERNALS__' in window) {
      if (!persistenceReady.current || !writerRef.current) throw { code: 'HISTORY_UNAVAILABLE', message: 'El historial nativo no está disponible. Exporta una copia antes de cerrar.' };
      await writerRef.current.flush();
    } else {
      window.localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(historyRef.current));
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    const persist = () => { void flush().catch((error) => setWarning(`Los últimos cambios no se han guardado: ${errorDetails(error).message}`)); };
    const timer = window.setTimeout(persist, 400);
    window.addEventListener('pagehide', persist);
    return () => { window.clearTimeout(timer); window.removeEventListener('pagehide', persist); };
  }, [history, ready, flush]);

  useEffect(() => {
    if (!ready || busyRef.current) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const selected = historyRef.current.conversations.find((item) => item.id === historyRef.current.selected_id && item.context === profile.context && item.engine === profile.engine);
      if (!selected || (selected.model === profile.model && selected.effort === profile.effort)) return;
      update((state) => ({ ...state, conversations: state.conversations.map((item) => item.id === selected.id ? { ...item, model: profile.model, effort: profile.effort } : item) }));
    });
    return () => { cancelled = true; };
  }, [profile.context, profile.engine, profile.model, profile.effort, ready, update]);

  const selected = history.conversations.find((item) => item.id === history.selected_id && item.engine === profile.engine && item.context === profile.context) ?? null;
  const draft = selected?.draft ?? history.drafts?.[draftScope(profile)] ?? '';
  const setDraft = useCallback((value: string | ((current: string) => string)) => {
    const current = historyRef.current.conversations.find((item) => item.id === historyRef.current.selected_id && item.engine === profileRef.current.engine && item.context === profileRef.current.context);
    if (!current) {
      blankTouched.current = true;
      const key = draftScope(profileRef.current);
      update((state) => ({ ...state, selected_id: null, drafts: { ...state.drafts, [key]: (typeof value === 'function' ? value(state.drafts?.[key] ?? '') : value).slice(0, 6000) } }));
      return;
    }
    const next = typeof value === 'function' ? value(current.draft) : value;
    update((state) => ({ ...state, conversations: state.conversations.map((item) => item.id === current.id ? { ...item, draft: next.slice(0, 6000) } : item) }));
  }, [update]);

  const select = useCallback((id: string) => {
    if (busyRef.current) return;
    const item = historyRef.current.conversations.find((entry) => entry.id === id);
    if (!item) return;
    selectionTouched.current = true;
    update((state) => ({ ...state, selected_id: id }));
    selectProfileRef.current(item);
  }, [update]);

  const fresh = useCallback(() => {
    if (busyRef.current) return;
    blankTouched.current = true;
    update((state) => ({ ...state, selected_id: null }));
  }, [update]);

  const send = useCallback(async (prompt: string, effectiveProfile: ChatProfile) => {
    if (busyRef.current || !prompt.trim()) return;
    if (!persistenceReady.current) { setWarning('Espera a que termine de cargar el historial antes de enviar.'); return; }
    if (!('__TAURI_INTERNALS__' in window)) { setWarning('Las conversaciones se ejecutan dentro de Esprit.app.'); return; }
    busyRef.current = true;
    cancelRequestedRef.current = false;
    runDoneRef.current = new Promise<void>((resolve) => { resolveRunRef.current = resolve; });
    setStarting(true);
    setWarning('');
    let unlisten: (() => void) | undefined;
    let conversation = historyRef.current.conversations.find((item) => item.id === historyRef.current.selected_id && item.engine === effectiveProfile.engine && item.context === effectiveProfile.context);
    let userRecorded = false;
    try {
      if (conversation?.status === 'expired') throw { code: 'SESSION_EXPIRED', message: 'Esta sesión ha caducado. Su historial se conserva: pulsa Nuevo chat para empezar otra conversación.' };
      if (!conversation) {
        if (historyRef.current.conversations.length >= CHAT_HISTORY_LIMIT) throw { code: 'HISTORY_FULL', message: 'Has llegado a 120 conversaciones guardadas. El historial se conserva íntegro; continúa una conversación existente.' };
        if (historyRef.current.conversations.filter((item) => !item.archived).length >= CHAT_ACTIVE_LIMIT) throw { code: 'HISTORY_FULL', message: 'Tienes 60 conversaciones activas. Archiva una para abrir otra; sus mensajes seguirán guardados.' };
        const native = await invoke<NativeConversation>('chat_create_conversation', { engine: effectiveProfile.engine, project: effectiveProfile.context === 'general' ? null : effectiveProfile.context, model: effectiveProfile.model, effort: effectiveProfile.effort });
        conversation = { ...native, title: prompt.trim().slice(0, 80), draft: prompt.slice(0, 6000), messages: [] };
        const created = conversation;
        update((state) => ({ ...state, selected_id: created.id, conversations: [...state.conversations, created] }));
      }
      const conversationId = conversation.id;
      const runId = crypto.randomUUID();
      const initial: Run = { id: runId, conversationId, text: '', textItems: {}, label: 'Iniciando conversación…', activities: [] };
      runRef.current = initial;
      setRun(initial);
      unlisten = await listen<RunEvent>('chat-run-event', ({ payload }) => {
        const current = runRef.current;
        if (!current || payload.run_id !== current.id || payload.conversation_id !== current.conversationId) return;
        let next = current;
        if (payload.type === 'text' && typeof payload.text === 'string') { const projected = mergeRunText(current.textItems, payload.item_id ?? 'answer', payload.text); next = { ...current, textItems: projected.items, text: projected.text, label: 'Respondiendo…' }; }
        if (payload.type === 'status' && payload.label) next = { ...current, label: payload.label };
        if (payload.type === 'activity' && payload.label && payload.item_id) {
          const activity: ChatActivity = { id: payload.item_id, label: payload.label, state: payload.state ?? 'running' };
          next = { ...current, activities: [...current.activities.filter((item) => item.id !== activity.id), activity].slice(-100), label: activity.state === 'running' ? activity.label : current.label };
        }
        runRef.current = next;
        setRun(next);
      });
      if (cancelRequestedRef.current) throw { code: 'RUN_CANCELLED', message: 'Consulta detenida antes de enviar. El borrador se conserva.' };
      const now = Date.now();
      update((state) => ({ ...state, drafts: { ...state.drafts, [draftScope(effectiveProfile)]: '' }, conversations: state.conversations.map((item) => item.id === conversationId ? { ...appendChatMessage(item, { ...effectiveProfile, id: `${runId}-user`, role: 'user', text: prompt.trim(), created_at: now }), ...effectiveProfile, draft: '' } : item) }));
      userRecorded = true;
        setStarting(false);
      const reply = await invoke<Reply>('ask_codex', { prompt: prompt.trim(), conversationId, runId, project: effectiveProfile.context === 'general' ? null : effectiveProfile.context, engine: effectiveProfile.engine, model: effectiveProfile.model, effort: effectiveProfile.effort });
      const activities = (runRef.current?.activities ?? []).map((item) => item.state === 'running' ? { ...item, state: 'completed' as const } : item);
      update((state) => ({ ...state, conversations: state.conversations.map((item) => item.id === conversationId ? { ...appendChatMessage(item, { ...effectiveProfile, id: `${runId}-assistant`, role: 'assistant', text: reply.answer, created_at: Date.now(), activities }), ...reply.conversation } : item) }));
    } catch (reason) {
      const error = errorDetails(reason);
      if (conversation && userRecorded) {
        const conversationId = conversation.id;
        const activities = (runRef.current?.activities ?? []).map((item) => item.state === 'running' ? { ...item, state: error.code === 'RUN_CANCELLED' ? 'cancelled' as const : 'failed' as const } : item);
        const partial = runRef.current?.text.slice(0, Math.max(0, 239_998 - error.message.length));
        update((state) => ({ ...state, conversations: state.conversations.map((item) => item.id === conversationId ? { ...appendChatMessage(item, { ...effectiveProfile, id: crypto.randomUUID(), role: 'assistant', text: partial ? `${partial}\n\n${error.message}` : error.message, created_at: Date.now(), activities, error: error.code }), status: error.code === 'SESSION_EXPIRED' ? 'expired' : item.status } : item) }));
      } else setWarning(error.message);
    } finally {
      unlisten?.();
      runRef.current = null;
      setRun(null);
      busyRef.current = false;
      setStarting(false);
      resolveRunRef.current?.();
      resolveRunRef.current = null;
      runDoneRef.current = null;
    }
  }, [update]);

  const cancel = useCallback(async () => {
    cancelRequestedRef.current = true;
    const done = runDoneRef.current;
    const current = runRef.current;
    if (current) {
      try { await invoke<boolean>('chat_cancel_run', { runId: current.id }); }
      catch (error) { setWarning(errorDetails(error).message); throw error; }
    }
    // Native cancellation returns after signaling; wait until ask records its
    // final cancelled state before allowing flush/close to complete.
    await done;
  }, []);

  const rename = useCallback((id: string, title: string) => update((state) => ({ ...state, conversations: state.conversations.map((item) => item.id === id ? { ...item, title: title.trim().slice(0, 120) || 'Conversación' } : item) })), [update]);
  const archive = useCallback((id: string) => {
    const selected = historyRef.current.conversations.find((item) => item.id === id);
    if (selected?.archived && historyRef.current.conversations.filter((item) => !item.archived).length >= CHAT_ACTIVE_LIMIT) { setWarning('Ya tienes 60 conversaciones activas. Archiva otra antes de recuperar esta.'); return; }
    update((state) => ({ ...state, conversations: state.conversations.map((item) => item.id === id ? { ...item, archived: !item.archived } : item) }));
  }, [update]);
  const exportHistory = useCallback(async () => {
    if ('__TAURI_INTERNALS__' in window) {
      try {
        const result = await invoke<{ saved: boolean; filename?: string }>('chat_export_history', { history: historyRef.current });
        if (result.saved) setWarning(`Historial exportado a ${result.filename ?? 'un archivo JSON'}.`);
      } catch (error) { setWarning(errorDetails(error).message); }
      return;
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(historyRef.current, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `esprit-chat-${new Date().toISOString().slice(0, 10)}.json`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);
  return { history, selected, draft, setDraft, catalog, ready, warning, run, isAsking: starting || run !== null, select, fresh, send, cancel, rename, archive, exportHistory, flush };
}
