'use client';

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
    <div className="github-space">
      <aside className="github-repositories">
        <header>
          <div><span>REPOSITORIOS</span><h3>{overview.login ? `@${overview.login}` : 'GitHub'}</h3></div>
          <button onClick={onRefresh} disabled={loading} type="button" aria-label="Actualizar GitHub">{loading ? '…' : '↻'}</button>
        </header>
        <div className="github-repository-list">
          <button className={!selectedRepository ? 'active' : ''} onClick={() => onSelectRepository(null)} type="button" aria-current={!selectedRepository ? 'page' : undefined}>
            <i>◎</i><div><strong>Todos los repositorios</strong><span>{repositories.length} vinculados a Esprit</span></div>
          </button>
          {repositories.map((repository) => (
            <button className={selectedRepository === repository.full_name ? 'active' : ''} key={repository.full_name} onClick={() => onSelectRepository(repository.full_name)} type="button" aria-current={selectedRepository === repository.full_name ? 'page' : undefined}>
              <i>{repository.private ? '●' : '○'}</i>
              <div>
                <strong>{repository.label || repository.name || repositoryShortName(repository.full_name)}</strong>
                <span>{repository.full_name}</span>
                <small>{repository.archived
                  ? 'Archivado'
                  : (repository.tracked_changes ?? 0) + (repository.untracked_changes ?? 0) > 0
                    ? `${repository.local_branch || repository.default_branch || 'local'} · ${(repository.tracked_changes ?? 0) + (repository.untracked_changes ?? 0)} cambios locales`
                    : repository.local_branch
                      ? `${repository.local_branch} · limpio`
                      : `Actualizado ${formatGitHubTime(repository.pushed_at)}`}</small>
              </div>
              {(repository.open_issues_count ?? 0) > 0 ? <b>{repository.open_issues_count}</b> : null}
            </button>
          ))}
        </div>
        <footer><i className={coverageIncomplete ? 'partial' : ''} /><div><strong>{coverageIncomplete ? 'Cobertura parcial' : 'Solo lectura'}</strong><span>{checkedAt ? `Actualizado ${checkedAt}` : 'Sesión conectada'}</span></div></footer>
      </aside>

      {coverageIncomplete ? <div className="github-warning github-global-warning" role="status">{coverageSummary}</div> : null}

      <section className={`github-activity${compactPanel === 'activity' ? ' compact-active' : ''}`}>
        <header>
          <div><span>ACTIVIDAD RECIENTE</span><h3>{selectedRepo?.label || selectedRepo?.name || (selectedRepository ? repositoryShortName(selectedRepository) : 'Todos los proyectos')}</h3></div>
          {selectedRepository ? <button onClick={() => onOpenRepository(selectedRepository)} type="button">Abrir repo ↗</button> : null}
        </header>
        <div className="github-compact-switch" aria-label="Panel de GitHub">
          <button className={compactPanel === 'activity' ? 'active' : ''} onClick={() => onSelectPanel('activity')} type="button" aria-pressed={compactPanel === 'activity'}>Actividad</button>
          <button className={compactPanel === 'notifications' ? 'active' : ''} onClick={() => onSelectPanel('notifications')} type="button" aria-pressed={compactPanel === 'notifications'}>Notificaciones {overview.notification_count > 0 ? `(${overview.notification_count})` : ''}</button>
        </div>
        <div className="github-activity-list">
          {activity.map((item) => (
            <button key={`${item.repo}-${item.id}`} onClick={() => onOpenItem(item.repo, item.target_kind || item.kind, item.target_id || item.id)} type="button">
              <span className="github-activity-mark">↗</span>
              <div>
                <small>{activityLabel(item.kind)} · {repositoryShortName(item.repo)}</small>
                <h4>{item.title}</h4>
                <p>{item.actor || overview.login || 'GitHub'} · {formatGitHubTime(item.created_at)}</p>
              </div>
              <span>→</span>
            </button>
          ))}
          {activity.length === 0 ? coverageIncomplete
            ? <div className="github-list-empty"><span>!</span><h4>Cobertura parcial</h4><p>No se puede confirmar toda la actividad. Actualiza la fuente o abre GitHub para revisarla.</p></div>
            : <div className="github-list-empty"><span>◇</span><h4>Sin actividad en este filtro</h4><p>Los commits de los últimos días aparecerán aquí sin convertirlos automáticamente en tareas terminadas.</p></div> : null}
        </div>
        <footer><span>{overview.coverage?.activity_truncated ? 'Actividad reciente · vista acotada' : 'Actividad reciente'}</span><b>{activity.length} movimientos</b></footer>
      </section>

      <section className={`github-notifications${compactPanel === 'notifications' ? ' compact-active' : ''}`}>
        <header><div><span>ATENCIÓN</span><h3>Notificaciones</h3></div>{overview.notification_count > 0 ? <b>{overview.notification_count}</b> : null}</header>
        <div className="github-compact-switch" aria-label="Panel de GitHub">
          <button className={compactPanel === 'activity' ? 'active' : ''} onClick={() => onSelectPanel('activity')} type="button" aria-pressed={compactPanel === 'activity'}>Actividad</button>
          <button className={compactPanel === 'notifications' ? 'active' : ''} onClick={() => onSelectPanel('notifications')} type="button" aria-pressed={compactPanel === 'notifications'}>Notificaciones {overview.notification_count > 0 ? `(${overview.notification_count})` : ''}</button>
        </div>
        <div className="github-notification-list">
          {notifications.map((item) => (
            <button className={item.unread ? 'unread' : ''} key={item.id} onClick={() => onOpenItem(item.repo, item.target_kind || item.subject_type, item.target_id)} type="button">
              <i />
              <div>
                <small>{notificationReason(item.reason)} · {repositoryShortName(item.repo)}</small>
                <h4>{item.title}</h4>
                <p>{item.subject_type} · {formatGitHubTime(item.updated_at)}</p>
              </div>
              <span>↗</span>
            </button>
          ))}
          {notifications.length === 0 ? coverageIncomplete
            ? <div className="github-list-empty"><span>!</span><h4>Cobertura parcial</h4><p>No se puede confirmar si quedan notificaciones. Actualiza la fuente o abre GitHub para revisarla.</p></div>
            : <div className="github-list-empty"><span>✓</span><h4>{selectedRepository ? 'Este repositorio no tiene avisos' : 'GitHub está al día'}</h4><p>{selectedRepository ? 'No hay notificaciones sin leer en este repositorio.' : 'No hay notificaciones sin leer para los repositorios enlazados.'}</p></div> : null}
        </div>
        <footer><span>Esprit no marca nada como leído.</span><b>READ ONLY</b></footer>
      </section>
    </div>
  );
}
