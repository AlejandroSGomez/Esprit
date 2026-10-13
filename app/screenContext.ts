export type MailReplyTarget = { threadId: string; from_account: string; to: string; subject: string; reply_message_id: string };
export type AgentTarget = { mail?: MailReplyTarget; mattermost?: { channelId: string; rootId: string | null }; title?: string };
export type ScreenSnapshot = { mail?: MailReplyTarget; space: string; title: string; text: string; mattermost?: { channelId: string; rootId: string | null } };
type Provider = () => ScreenSnapshot | null | Promise<ScreenSnapshot | null>;

const providers = new Map<string, Provider>();
const MAX_SCREEN_CHARS = 14_000;

/** Registers the provider of one space; returns the unregister function. */
export function registerScreen(space: string, provider: Provider) {
  providers.set(space, provider);
  return () => { if (providers.get(space) === provider) providers.delete(space); };
}

export async function captureScreen(space: string | null): Promise<ScreenSnapshot | null> {
  const provider = providers.get(space ?? 'home');
  if (!provider) return null;
  try {
    const snapshot = await provider();
    return snapshot ? { ...snapshot, text: bound(snapshot.text, MAX_SCREEN_CHARS) } : null;
  } catch { return null; }
}

export const bound = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 40)}\n[… recortado por Esprit]`;

export type AgentAction =
  | { type: 'mail_draft'; mode: 'reply' | 'new'; to?: string; subject?: string; body: string }
  | { type: 'mattermost_draft'; message: string }
  | { type: 'project_file'; project: string; folder: string; name: string; content: string }
  | { type: 'quick_note'; category: string; title: string; body: string };
