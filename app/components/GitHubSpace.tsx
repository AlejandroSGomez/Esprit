'use client';
import { getAppTimeZone } from '../appConfig';

export type GitHubRepository = {
  full_name: string;
  name?: string;
  label?: string;
  project_slug?: string | null;
  private: boolean | null;
  archived: boolean | null;
  default_branch: string | null;
  pushed_at?: string | null;
  open_issues_count: number | null;
  html_url: string;
  local_branch?: string | null;
  local_head?: string | null;
  tracked_changes?: number;
  untracked_changes?: number;
};

export type GitHubActivity = {
  id: string;
  repo: string;
  project_slug?: string | null;
  kind: string;
  title: string;
  actor: string;
  created_at: string;
  target_kind?: string | null;
  target_id?: string | null;
};

export type GitHubNotification = {
  id: string;
  repo: string;
  project_slug?: string | null;
  reason: string;
  subject_type: string;
  title: string;
  updated_at: string;
  unread: boolean;
  target_kind?: string | null;
  target_id?: string | null;
};

export type GitHubOverview = {
  status: 'available' | 'partial' | 'auth_required' | 'unavailable';
  connected: boolean;
  login?: string | null;
  checked_at: number;
  notification_count: number;
  repositories: GitHubRepository[];
  activity: GitHubActivity[];
  notifications: GitHubNotification[];
  warnings?: string[];
  error?: string | null;
  coverage?: {
    configured_repositories?: number;
    github_repositories?: number;
    returned_activity?: number;
    returned_notifications?: number;
    notifications_truncated?: boolean;
    activity_truncated?: boolean;
  };
};

export type GitHubPanel = 'activity' | 'notifications';

type GitHubSpaceProps = {
  overview: GitHubOverview | null;
  loading: boolean;
  error: string | null;
  selectedRepository: string | null;
  compactPanel: GitHubPanel;
  onSelectRepository: (repository: string | null) => void;
  onSelectPanel: (panel: GitHubPanel) => void;
  onRefresh: () => void;
  onConnect: () => void;
  onOpenRepository: (repository: string) => void;
  onOpenItem: (repository: string, kind: string, identifier?: string | null) => void;
  onClose?: () => void;
};

const formatGitHubTime = (value?: string | null) => {
  if (!value) return 'Sin actividad reciente';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('es-ES', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

const repositoryShortName = (repository: string) => repository.split('/').pop() || repository;
const dayLabel = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin fecha';
  const key = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: getAppTimeZone() });
  if (key(date) === key(new Date())) return 'Hoy';
  if (key(date) === key(new Date(Date.now() - 86_400_000))) return 'Ayer';
  const label = date.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: getAppTimeZone() });
  return label.charAt(0).toLocaleUpperCase('es') + label.slice(1);
};
const timeOnly = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: getAppTimeZone() }); };
const kindGlyph = (kind: string) => kind === 'commit' ? '◆' : kind === 'pull' ? '⇄' : kind === 'issue' ? '◎' : kind === 'release' ? '★' : '•';

const activityLabel = (kind: string) => {
  if (kind === 'commit') return 'COMMIT';
  if (kind === 'pull') return 'PULL REQUEST';
  if (kind === 'issue') return 'ISSUE';
  return kind.replaceAll('_', ' ').toLocaleUpperCase('es');
};

const notificationReason = (reason: string) => {
  const labels: Record<string, string> = {
    assign: 'Asignado',
    author: 'Autor',
    comment: 'Comentario',
    invitation: 'Invitación',
    manual: 'Suscripción',
    mention: 'Mención',
    review_requested: 'Revisión solicitada',
    security_alert: 'Seguridad',
    state_change: 'Cambio de estado',
    subscribed: 'Siguiendo',
    team_mention: 'Mención al equipo',
  };
  return labels[reason] ?? reason.replaceAll('_', ' ');
};

const summarizeWarnings = (warnings: string[]) => {
  const clean = warnings.map((warning) => warning.trim()).filter(Boolean);
  if (clean.length === 0) return '';
  const shown = clean.slice(0, 2);
  const joined = shown.join(' ');
  const summary = joined.length > 220 ? `${joined.slice(0, 217).trimEnd()}…` : joined;
  return clean.length > shown.length ? `${summary} (+${clean.length - shown.length})` : summary;
};

export default function GitHubSpace({
  overview,
  loading,
  error,
  selectedRepository,
  compactPanel,
  onSelectRepository,
  onSelectPanel,
  onRefresh,
  onConnect,
  onOpenRepository,
  onOpenItem,
  onClose,
}: GitHubSpaceProps) {
  const repositories = overview?.repositories ?? [];
  const activity = (overview?.activity ?? []).filter((item) => !selectedRepository || item.repo === selectedRepository);
  const notifications = (overview?.notifications ?? []).filter((item) => !selectedRepository || item.repo === selectedRepository);
  const selectedRepo = repositories.find((repository) => repository.full_name === selectedRepository) ?? null;
  const sourceProblem = error ?? overview?.error ?? null;
  const checkedAt = overview?.checked_at ? new Date(overview.checked_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : null;
  const authenticationExpired = overview?.status === 'auth_required';
  const coverageIncomplete = Boolean(overview && (
    overview.status !== 'available'
    || overview.error
    || (overview.warnings?.length ?? 0) > 0
    || overview.coverage?.activity_truncated
    || overview.coverage?.notifications_truncated
  ));
  const warningSummary = overview ? summarizeWarnings([
    ...(overview.warnings ?? []),
    ...(overview.error ? [overview.error] : []),
  ]) : '';
  const coverageSummary = warningSummary || (overview?.coverage?.notifications_truncated
    ? 'La lista de notificaciones está truncada; abre o actualiza GitHub para completar la revisión.'
    : overview?.coverage?.activity_truncated
      ? 'La actividad reciente está truncada; abre o actualiza GitHub para completar la revisión.'
      : 'GitHub no ha podido confirmar una cobertura completa. Actualiza la fuente o revísala en GitHub.');

  if (!overview && loading) {
    return <div className="github-state"><i /><h3>Conectando con GitHub</h3><p>Esprit está reuniendo repositorios, commits y notificaciones.</p></div>;
  }

  if (!overview?.connected) {
    return (
      <div className="github-state github-auth-state">
        <span>GH</span>
        <small>GITHUB / SESIÓN LOCAL</small>
        <h3>{authenticationExpired ? 'La sesión de GitHub ha caducado.' : sourceProblem ? 'La sesión necesita atención.' : 'Conecta GitHub con Esprit.'}</h3>
        <p>{authenticationExpired
          ? 'La sesión local gestionada por GitHub CLI necesita reautenticación. Esprit nunca guarda el token ni marca notificaciones como leídas.'
          : sourceProblem ?? 'Esprit usa una sesión local gestionada por GitHub CLI. Nunca guarda el token ni marca notificaciones como leídas.'}</p>
        <div><button onClick={onConnect} type="button">{authenticationExpired || sourceProblem ? 'Reautenticar GitHub →' : 'Conectar GitHub →'}</button><button onClick={onRefresh} disabled={loading} type="button">{loading ? 'Comprobando…' : 'Comprobar de nuevo'}</button></div>
        <em>Completa el acceso en Terminal y después pulsa «Comprobar de nuevo».</em>
      </div>
    );
  }

  return (
    <div className="github-space gh-v2">
      <aside className="github-repositories">
        <header>
          <div><h3>GitHub</h3><span>{overview.login ? `@${overview.login}` : 'Solo lectura'}</span></div>
          <button onClick={onRefresh} disabled={loading} type="button" aria-label="Actualizar GitHub" title={checkedAt ? `Actualizado ${checkedAt}` : 'Actualizar'}>{loading ? '…' : '↻'}</button>
        </header>
        <div className="github-repository-list">
          <button className={`gh-repo${!selectedRepository ? ' active' : ''}`} onClick={() => onSelectRepository(null)} type="button" aria-current={!selectedRepository ? 'page' : undefined}>
            <i aria-hidden="true" /><div><strong>Todos</strong><small>{repositories.length} repositorios</small></div>
            {overview.notification_count > 0 ? <b>{overview.notification_count}</b> : null}
          </button>
          {repositories.map((repository) => {
            const changes = (repository.tracked_changes ?? 0) + (repository.untracked_changes ?? 0);
            const unread = (overview.notifications ?? []).filter((item) => item.repo === repository.full_name && item.unread).length;
            return <button className={`gh-repo tone-${repository.project_slug ?? 'general'}${selectedRepository === repository.full_name ? ' active' : ''}`} key={repository.full_name} onClick={() => onSelectRepository(repository.full_name)} type="button" aria-current={selectedRepository === repository.full_name ? 'page' : undefined} title={repository.full_name}>
              <i aria-hidden="true" />
              <div>
                <strong>{repository.label || repository.name || repositoryShortName(repository.full_name)}</strong>
                <small>{repository.archived ? 'Archivado' : <>{repository.local_branch || repository.default_branch || 'main'}{changes > 0 ? <em> · {changes} cambios</em> : repository.local_branch ? ' · limpio' : ''}</>}</small>
              </div>
              {unread > 0 ? <b>{unread}</b> : null}
            </button>;
          })}
        </div>
        <footer><i className={coverageIncomplete ? 'partial' : ''} /><span>{coverageIncomplete ? 'Cobertura parcial' : 'Solo lectura · Esprit no marca nada como leído'}</span></footer>
      </aside>

      <section className="gh-main">
        <header className="gh-toolbar">
          <h3>{selectedRepo?.label || selectedRepo?.name || (selectedRepository ? repositoryShortName(selectedRepository) : 'Todos los repositorios')}</h3>
          <div className="gh-tabs" role="tablist" aria-label="Panel de GitHub">
            <button role="tab" aria-selected={compactPanel === 'activity'} onClick={() => onSelectPanel('activity')} type="button">Actividad <small>{activity.length}</small></button>
            <button role="tab" aria-selected={compactPanel === 'notifications'} onClick={() => onSelectPanel('notifications')} type="button">Notificaciones {notifications.filter((item) => item.unread).length ? <b>{notifications.filter((item) => item.unread).length}</b> : <small>0</small>}</button>
          </div>
          {selectedRepository ? <button className="gh-open" onClick={() => onOpenRepository(selectedRepository)} type="button">Abrir repo ↗</button> : null}
          {onClose ? <button className="gh-close" onClick={onClose} type="button" aria-label="Cerrar GitHub">×</button> : null}
        </header>
        {coverageIncomplete ? <div className="github-warning github-global-warning" role="status">{coverageSummary}</div> : null}
        {compactPanel === 'activity' ? <div className="gh-list">
          {activity.map((item, index) => {
            const day = dayLabel(item.created_at);
            const newDay = index === 0 || dayLabel(activity[index - 1].created_at) !== day;
            return <div key={`${item.repo}-${item.id}`}>
              {newDay ? <div className="gh-day">{day}</div> : null}
              <button className={`gh-row kind-${item.kind} tone-${item.project_slug ?? 'general'}`} onClick={() => onOpenItem(item.repo, item.target_kind || item.kind, item.target_id || item.id)} type="button">
                <span className="gh-kind" title={activityLabel(item.kind)} aria-hidden="true">{kindGlyph(item.kind)}</span>
                <span className="gh-row-copy"><strong>{item.title}</strong><small><i aria-hidden="true" />{repositoryShortName(item.repo)} · {item.actor || overview.login || 'GitHub'}</small></span>
                <time>{timeOnly(item.created_at)}</time>
              </button>
            </div>;
          })}
          {activity.length === 0 ? <div className="github-list-empty"><span>{coverageIncomplete ? '!' : '◇'}</span><h4>{coverageIncomplete ? 'Cobertura parcial' : 'Sin actividad en este filtro'}</h4><p>{coverageIncomplete ? 'No se puede confirmar toda la actividad. Actualiza o abre GitHub.' : 'Los commits recientes aparecerán aquí.'}</p></div> : null}
          {overview.coverage?.activity_truncated ? <p className="gh-note">Vista acotada a la actividad reciente.</p> : null}
        </div> : <div className="gh-list">
          {notifications.map((item) => <button className={`gh-row notification tone-${item.project_slug ?? 'general'}${item.unread ? ' unread' : ''}`} key={item.id} onClick={() => onOpenItem(item.repo, item.target_kind || item.subject_type, item.target_id)} type="button">
            <span className="gh-kind" aria-hidden="true">{item.unread ? '●' : '○'}</span>
            <span className="gh-row-copy"><strong>{item.title}</strong><small><i aria-hidden="true" />{repositoryShortName(item.repo)} · {notificationReason(item.reason)} · {item.subject_type}</small></span>
            <time>{formatGitHubTime(item.updated_at)}</time>
          </button>)}
          {notifications.length === 0 ? <div className="github-list-empty"><span>{coverageIncomplete ? '!' : '✓'}</span><h4>{coverageIncomplete ? 'Cobertura parcial' : selectedRepository ? 'Este repositorio no tiene avisos' : 'GitHub está al día'}</h4><p>{coverageIncomplete ? 'No se puede confirmar si quedan notificaciones.' : 'No hay notificaciones sin leer.'}</p></div> : null}
        </div>}
      </section>
    </div>
  );
}
