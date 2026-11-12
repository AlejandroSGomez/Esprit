import type { MattermostChannel, MattermostChannelData, MattermostOverview } from './components/MattermostSpace';

/** Only RAM snapshots and in-flight reads; never credentials or message persistence. */
export class MattermostChannels {
  readonly snapshots = new Map<string, { data: MattermostChannelData; stamp: number; readAt: number }>();
  private pending = new Map<string, Promise<MattermostChannelData>>();
  private prefetching = 0;

  hasPending(id: string) { return this.pending.has(id); }
  isFresh(channel: MattermostChannel, now = Date.now()) {
    const cached = this.snapshots.get(channel.id);
    return Boolean(cached && cached.stamp >= channel.last_post_at && now - cached.readAt < 20_000);
  }

  async read(channelId: string, stamp: number, load: () => Promise<MattermostChannelData>, force = false): Promise<MattermostChannelData> {
    const current = this.pending.get(channelId);
    if (current) {
      if (!force) return current;
      // A refresh after a write must not reuse the snapshot from before it.
      await current.catch(() => undefined);
      const newer = this.pending.get(channelId);
      if (newer) return newer;
    }
    const request = Promise.resolve().then(load).then(data => {
      if (data.channel.id === channelId && !data.channel.restricted && data.history?.mode !== 'full') {
        this.snapshots.delete(channelId);
        this.snapshots.set(channelId, { data, stamp, readAt: Date.now() });
        while (this.snapshots.size > 12) this.snapshots.delete(this.snapshots.keys().next().value!);
      }
      return data;
    }).finally(() => { if (this.pending.get(channelId) === request) this.pending.delete(channelId); });
    this.pending.set(channelId, request);
    return request;
  }

  async prefetch(channel: MattermostChannel, load: () => Promise<MattermostChannelData>) {
    if (channel.restricted || this.prefetching >= 2 || this.pending.has(channel.id) || this.isFresh(channel)) return;
    this.prefetching += 1;
    try { await this.read(channel.id, channel.last_post_at, load); }
    catch { /* Opening the channel reports errors; read-ahead stays quiet. */ }
    finally { this.prefetching -= 1; }
  }
}

/** The preference contains one opaque channel id, separated by configured account. */
export function mattermostLastChannelKey(overview: Pick<MattermostOverview, 'server' | 'team' | 'identity'>) {
  return `esprit-mm-last-channel:${encodeURIComponent(JSON.stringify([overview.server, overview.team, overview.identity]))}`;
}

/** Replace the authoritative recent window, retaining only older expanded history. */
export function mergeMattermostRecent(current: MattermostChannelData | null, next: MattermostChannelData, hasFullHistory: boolean) {
  if (!current || current.channel.id !== next.channel.id || !hasFullHistory || next.history?.mode !== 'recent') return next;
  if (next.history.complete) return next;
  const cutoff = next.history.window_start_at;
  const posts = new Map(current.posts.filter(post => cutoff == null || post.create_at < cutoff).map(post => [post.id, post]));
  next.posts.forEach(post => posts.set(post.id, post));
  return { ...next, posts: [...posts.values()].sort((left, right) => left.create_at - right.create_at || left.id.localeCompare(right.id)), history: current.history };
}
