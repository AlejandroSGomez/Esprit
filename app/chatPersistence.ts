import type { ChatHistory, SavedConversation } from './chatHistory';
const TURN_LIMIT = 400;

/** Local edits win only for fields changed since the last saved base. Both
 * message sets survive a concurrent write; no conversation is silently dropped. */
export function mergeConcurrentHistory(base: ChatHistory, remote: ChatHistory, local: ChatHistory): ChatHistory {
  const baseById = new Map(base.conversations.map((item) => [item.id, item]));
  const merged = new Map(remote.conversations.map((item) => [item.id, item]));
  for (const item of local.conversations) {
    const other = merged.get(item.id);
    const previous = baseById.get(item.id);
    if (!other) { merged.set(item.id, item); continue; }
    const messages = new Map(other.messages.map((message) => [message.id, message]));
    const previousMessages = new Map(previous?.messages.map((message) => [message.id, message]) ?? []);
    for (const message of item.messages) {
      if (messages.has(message.id) || !previousMessages.has(message.id) || JSON.stringify(message) !== JSON.stringify(previousMessages.get(message.id))) messages.set(message.id, message);
    }
    const mergedMessages = [...messages.values()].sort((a, b) => a.created_at - b.created_at);
    const next: SavedConversation = { ...other, messages: mergedMessages.slice(-TURN_LIMIT), updated_at: Math.max(item.updated_at, other.updated_at), older_messages: Math.max(item.older_messages ?? 0, other.older_messages ?? 0) + Math.max(0, mergedMessages.length - TURN_LIMIT) };
    const localFields = ['title', 'draft', 'archived', 'model', 'effort', 'status'] as const;
    for (const field of localFields) if (!previous || item[field] !== previous[field]) Object.assign(next, { [field]: item[field] });
    merged.set(item.id, next);
  }
  const selected_id = local.selected_id !== base.selected_id ? local.selected_id : remote.selected_id;
  const drafts = { ...remote.drafts };
  for (const key of new Set([...Object.keys(base.drafts ?? {}), ...Object.keys(local.drafts ?? {})])) {
    if (local.drafts?.[key] !== base.drafts?.[key]) drafts[key] = local.drafts?.[key] ?? '';
  }
  return { version: 2, selected_id, drafts, conversations: [...merged.values()].sort((a, b) => a.updated_at - b.updated_at) };
}

type Adapter = {
  save: (history: ChatHistory, revision: number) => Promise<{ revision: number }>;
  load: () => Promise<{ history: ChatHistory; revision: number }>;
  conflict: (history: ChatHistory) => void;
};
const isConflict = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'HISTORY_CONFLICT');

/** One writer serializes saves and coalesces edits while a save is in flight. */
export class ChatHistoryWriter {
  private pending: ChatHistory | null = null;
  private flight: Promise<void> | null = null;
  private base: ChatHistory;
  private revision: number;
  private adapter: Adapter;
  constructor(adapter: Adapter, history: ChatHistory, revision: number) { this.adapter = adapter; this.base = history; this.revision = revision; }
  queue(history: ChatHistory) { this.pending = history; }
  flush(): Promise<void> {
    if (!this.flight) this.flight = Promise.resolve().then(() => this.drain()).finally(() => { this.flight = null; });
    return this.flight.then(() => this.pending ? this.flush() : undefined);
  }
  private async drain() {
    let conflicts = 0;
    while (this.pending) {
      const snapshot = this.pending;
      this.pending = null;
      try {
        const saved = await this.adapter.save(snapshot, this.revision);
        this.base = snapshot;
        this.revision = saved.revision;
      } catch (error) {
        // Keep the most recent edit, even if the previous save failed.
        const latest = this.pending ?? snapshot;
        this.pending = latest;
        if (!isConflict(error) || conflicts++ >= 2) throw error;
        const remote = await this.adapter.load();
        const reconciled = mergeConcurrentHistory(this.base, remote.history, this.pending ?? latest);
        this.base = remote.history;
        this.revision = remote.revision;
        this.pending = reconciled;
        this.adapter.conflict(reconciled);
      }
    }
  }
}

/** CLI text events replace a named item; independent messages remain visible. */
export function mergeRunText(items: Record<string, string>, id: string, text: string): { items: Record<string, string>; text: string } {
  const next = { ...items };
  const last = Object.entries(next).filter(([key]) => key !== 'final').at(-1)?.[1];
  if (id !== 'final' || text.trim() !== last?.trim()) next[id] = text;
  return { items: next, text: Object.values(next).filter(Boolean).join('\n\n') };
}
