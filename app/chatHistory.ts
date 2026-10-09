import type { AgentModel, ChatEngine, CodexEffort, CodexModel, RetiredCodexModel, ClaudeModel, RetiredClaudeModel } from './components/CodexProfilePicker';

export type ChatProfile = { context: string; engine: ChatEngine; model: AgentModel; effort: CodexEffort };
export type ChatActivity = { id: string; label: string; state: 'running' | 'completed' | 'failed' | 'cancelled' };
/** A message keeps the model that actually produced it, even a retired one. */
export type ChatMessage = Omit<ChatProfile, 'model'> & { model: AgentModel | RetiredCodexModel | RetiredClaudeModel; id: string; role: 'user' | 'assistant'; text: string; created_at: number; activities?: ChatActivity[]; error?: string };
export type NativeConversation = ChatProfile & { id: string; created_at: number; updated_at: number; status: 'new' | 'ready' | 'expired'; legacy_key: string | null };
export type SavedConversation = NativeConversation & { title: string; draft: string; messages: ChatMessage[]; archived?: boolean; older_messages?: number };
export type ChatHistory = { version: 2; selected_id: string | null; conversations: SavedConversation[]; drafts?: Record<string, string> };
export const CHAT_HISTORY_KEY = 'esprit-chat-history-v2';
export const LEGACY_CHAT_KEY = 'esprit-chat-messages-v1';
export const CHAT_HISTORY_LIMIT = 120;
export const CHAT_ACTIVE_LIMIT = 60;
export const CHAT_TURN_LIMIT = 400;
// Contextos válidos: `general` o cualquier slug con el formato de la
// configuración. Así el historial sobrevive a que se añadan o quiten
// proyectos; el lado nativo decide si un contexto sigue disponible.
const contextSlug = /^[a-z0-9][a-z0-9-]{0,47}$/;
const contexts = { has: (value: unknown): value is string => typeof value === 'string' && (value === 'general' || contextSlug.test(value)) };
const engines = new Set(['codex', 'claude']);
const efforts = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
// Same successors as the native catalogue: retired models stay readable and a
// conversation that used one continues on its successor.
const retiredCodexModels: Record<RetiredCodexModel, CodexModel> = { 'gpt-5.6-luna': 'gpt-6-luna', 'gpt-6-sol': 'gpt-6.1-sol', 'gpt-5.6-terra': 'gpt-6.1-sol', 'gpt-5.6-sol': 'gpt-6.1-sol' };
const retiredClaudeModels: Record<RetiredClaudeModel, ClaudeModel> = { sonnet: 'claude-sonnet-5-5', fable: 'opus' };
export const currentAgentModel = (value: string): string => retiredCodexModels[value as RetiredCodexModel] ?? retiredClaudeModels[value as RetiredClaudeModel] ?? value;
const models = new Set(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', ...Object.keys(retiredCodexModels), 'haiku', 'claude-sonnet-5-5', 'opus', ...Object.keys(retiredClaudeModels)]);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
export const validProfile = (value: Record<string, unknown>) => text(value.context, 80) && contexts.has(value.context) && engines.has(String(value.engine)) && models.has(String(value.model)) && efforts.has(String(value.effort)) && (value.engine === 'codex' ? String(value.model).startsWith('gpt-') : !String(value.model).startsWith('gpt-'));

export const draftScope = (profile: Pick<ChatProfile, 'engine' | 'context'>) => `${profile.engine}::${profile.context}`;
export function normalizeDrafts(value: unknown): Record<string, string> {
  if (!record(value)) return {};
  const drafts: Record<string, string> = {};
  for (const [key, draft] of Object.entries(value)) {
    const parts = key.split('::');
    if (parts.length === 2 && engines.has(parts[0]) && contexts.has(parts[1]) && text(draft, 6000)) drafts[key] = draft;
  }
  return drafts;
}

export function normalizeMessage(value: unknown): ChatMessage | null {
  if (!record(value) || !validProfile(value) || !text(value.id, 160) || !text(value.text, 240_000) || (value.role !== 'user' && value.role !== 'assistant')) return null;
  const activities: ChatActivity[] = Array.isArray(value.activities) ? value.activities.filter((item) => record(item) && text(item.id, 160) && text(item.label, 240) && ['running', 'completed', 'failed', 'cancelled'].includes(String(item.state))).slice(-100).map((item) => ({ id: item.id, label: item.label, state: item.state === 'running' ? 'cancelled' : item.state })) : [];
  return { id: value.id, text: value.text, role: value.role, context: value.context as string, engine: value.engine as ChatEngine, model: value.model as ChatMessage['model'], effort: value.effort as CodexEffort, created_at: Number.isFinite(value.created_at) ? Number(value.created_at) : 0, activities, error: text(value.error, 80) ? value.error : undefined };
}

export function normalizeHistory(value: unknown): ChatHistory {
  if (!record(value) || value.version !== 2 || !Array.isArray(value.conversations)) return { version: 2, selected_id: null, conversations: [] };
  const ids = new Set<string>();
  const conversations = value.conversations.flatMap<SavedConversation>((item) => {
    if (!record(item) || !validProfile(item) || !text(item.id, 160) || ids.has(item.id) || !text(item.title, 120) || !Array.isArray(item.messages)) return [];
    ids.add(item.id);
    const messages = item.messages.map(normalizeMessage).filter((message): message is ChatMessage => Boolean(message && message.context === item.context && message.engine === item.engine));
    return [{ id: item.id, title: item.title, context: item.context as string, engine: item.engine as ChatEngine, model: currentAgentModel(String(item.model)) as AgentModel, effort: item.effort as CodexEffort, created_at: Number.isFinite(item.created_at) ? Number(item.created_at) : 0, updated_at: Number.isFinite(item.updated_at) ? Number(item.updated_at) : 0, status: item.status === 'new' || item.status === 'ready' ? item.status : 'expired', legacy_key: text(item.legacy_key, 200) ? item.legacy_key : null, draft: text(item.draft, 6000) ? item.draft : '', messages: messages.slice(-CHAT_TURN_LIMIT), archived: item.archived === true, older_messages: Math.max(0, Number(item.older_messages) || 0) + Math.max(0, messages.length - CHAT_TURN_LIMIT) }];
  });
  return { version: 2, selected_id: typeof value.selected_id === 'string' && conversations.some((item) => item.id === value.selected_id) ? value.selected_id : null, conversations, drafts: normalizeDrafts(value.drafts) };
}

/** Old transcripts are attached only to the exact semantic key returned by native. */
export function reconcileHistory(history: ChatHistory, native: NativeConversation[], legacy: unknown): ChatHistory {
  const oldMessages = Array.isArray(legacy) ? legacy.map(normalizeMessage).filter((message): message is ChatMessage => Boolean(message)) : [];
  const known = new Map(history.conversations.map((item) => [item.id, item]));
  const legacyGroups = new Map<string, ChatMessage[]>();
  for (const message of oldMessages) {
    const key = `${message.engine}::${message.context}::${message.model}::${message.effort}`;
    legacyGroups.set(key, [...(legacyGroups.get(key) ?? []), message]);
  }
  const migrated: SavedConversation[] = native.map((item) => {
    const saved = known.get(item.id);
    const old = item.legacy_key ? legacyGroups.get(item.legacy_key) ?? [] : [];
    if (item.legacy_key) legacyGroups.delete(item.legacy_key);
    if (saved) { known.delete(item.id); return { ...saved, ...item, title: saved.title, draft: saved.draft, messages: saved.messages.length ? saved.messages : old, archived: saved.archived, older_messages: saved.older_messages, model: saved.model, effort: saved.effort, updated_at: Math.max(saved.updated_at, item.updated_at) }; }
    return { ...item, title: old.find((message) => message.role === 'user')?.text.slice(0, 80) || 'Conversación', draft: '', messages: old };
  });
  // Expired/evicted CLI sessions still have useful visible history. Preserve
  // exact known attribution without inventing a resumable native thread.
  for (const [key, messages] of legacyGroups) {
    const first = messages[0];
    const id = ['legacy', first.engine, first.context, first.model, first.effort].join('_');
    if (known.has(id)) continue;
    migrated.push({ id, context: first.context, engine: first.engine, model: currentAgentModel(first.model) as AgentModel, effort: first.effort, created_at: first.created_at, updated_at: messages.at(-1)?.created_at ?? 0, status: 'expired', legacy_key: key, title: first.text.slice(0, 80) || 'Historial anterior', draft: '', messages });
  }
  // Local history remains readable if a CLI/native session has expired.
  const conversations: SavedConversation[] = [...[...known.values()].map((item): SavedConversation => ({ ...item, status: 'expired' })), ...migrated].sort((a, b) => a.updated_at - b.updated_at);
  return { version: 2, selected_id: history.selected_id, conversations, drafts: history.drafts ?? {} };
}

export function appendChatMessage(conversation: SavedConversation, message: ChatMessage): SavedConversation {
  const next = [...conversation.messages, message];
  return { ...conversation, messages: next.slice(-CHAT_TURN_LIMIT), older_messages: (conversation.older_messages ?? 0) + Math.max(0, next.length - CHAT_TURN_LIMIT), updated_at: message.created_at };
}
