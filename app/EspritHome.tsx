'use client';
import MailThreadView from './components/MailThread';

import { invoke } from '@tauri-apps/api/core';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import NotesSpace from './components/NotesSpace';
import QuickNoteComposer from './components/QuickNoteComposer';
import JournalClubSpace from './components/JournalClubSpace';
import { useQuickNotes, quickNotesSnapshot, pendingQuickNoteVersions, type QuickNoteDraft } from './quickNotes';
import NavIcon, { type NavIconName } from './components/NavIcon';
import ChatWorkspace from './components/ChatWorkspace';
import { useChatConversations } from './useChatConversations';
import { currentAgentModel, type ChatProfile } from './chatHistory';
import './components/WorkspacePolish.css';
import './components/PublicShell.css';
import { CSSProperties, FormEvent, KeyboardEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CalendarEvent, CalendarOverview } from './components/CalendarSpace';
import CodexProfilePicker, { AgentModel, ChatEngine, ClaudeModel, CodexEffort, CodexModel } from './components/CodexProfilePicker';
import SplitDivider from './components/SplitDivider';
import { useAutoGrow } from './components/useAutoGrow';
import type { GitHubOverview, GitHubPanel } from './components/GitHubSpace';
import type {
  MattermostAvatar,
  MattermostChannel,
  MattermostChannelData,
  MattermostFilePreview,
  MattermostOverview,
} from './components/MattermostSpace';
import RichText from './components/RichText';
import SettingsSpace, {
  AppearancePalette,
  AppearanceTextSize,
  isAppearancePalette,
  isAppearanceTextSize,
} from './components/SettingsSpace';
import { useResizableSplit } from './components/useResizableSplit';
import { startVisiblePolling } from './visiblePolling';
import GlobalSearch, { type PaperTarget } from './components/GlobalSearch';
import type { SearchEntry } from './globalSearch';
import { LatestRequest } from './latestRequest';
import { useResearch, type ResearchNote, type WaitingItem } from './research';
import { ResearchSpace, WaitingPanel, NoteEditor } from './components/ResearchSpace';
import './components/LivingDesk.css';
import { useAppConfig, useAppConfigControls } from './appConfig';
import { nextDateKey, zonedWallTimeIso } from './timeZone';

/** Presupuestos separados del snapshot de correo para Login y Logout. */
const MAIL_INBOX_BUDGET = 30;
const MAIL_SENT_BUDGET = 20;

const workspaceLoading = () => <div className="workspace-loading" role="status">Abriendo espacio…</div>;
const TravelSpace = dynamic(() => import('./components/TravelSpace'), { loading: workspaceLoading });
const CalendarSpace = dynamic(() => import('./components/CalendarSpace'), { loading: workspaceLoading });
const ClusterSpace = dynamic(() => import('./components/ClusterSpace'), { loading: workspaceLoading });
const GitHubSpace = dynamic(() => import('./components/GitHubSpace'), { loading: workspaceLoading });
const LibrarySpace = dynamic(() => import('./components/LibrarySpace'), { loading: workspaceLoading });
const ProjectSpace = dynamic(() => import('./components/ProjectSpace'), { loading: workspaceLoading });
const MattermostSpace = dynamic(() => import('./components/MattermostSpace'), { loading: workspaceLoading });

/**
 * Destinos semánticos fijos de `open_target`. El lado nativo resuelve cada uno
 * desde la configuración; la interfaz nunca envía rutas ni URLs.
 */
type Action = 'calendar' | 'config_file' | 'esprit_app' | 'esprit_source' | 'jupyter' | 'library' | 'mail' | 'mattermost' | 'project' | 'workspace';
type WindowName = 'notes' | 'journal' | 'trips' | 'mattermost' | 'mail' | 'github' | 'cluster' | 'projects' | 'calendar' | 'library' | 'daily' | 'settings' | 'meetings';
type DailyMode = 'login' | 'logout';
type LogoutPhase = 'discovering' | 'interview' | 'previewing' | 'review' | 'applying' | 'complete';
type LoginHistoryEntry = { id: string; label: string; created_at: string; briefing: string; kept?: boolean };
type LoginHistoryOverview = { version: number; entries: LoginHistoryEntry[] };
type LogoutHistoryEntry = { id: string; label: string; created_at: string; summary: string; kept?: boolean };
type LogoutHistoryOverview = { version: number; entries: LogoutHistoryEntry[] };
type DailyHistoryReview = { kind: DailyMode; id: string; label: string; created_at: string; content: string };
type DailyRitualReply = { answer: string; action: string; questions?: string[]; discovery_id?: string | null; plan_id?: string | null; history_entry?: LoginHistoryEntry | null; logout_history_entry?: LogoutHistoryEntry | null; source_warnings?: string[]; paper_radar?: { status: 'recommendations' | 'nothing_relevant' | 'unavailable'; message: string; new_count: number; source_stale: boolean } | null };
type RefreshResult<T> = { overview: T | null; error: string | null };
type DailySourceOverrides = {
  globalState?: RefreshResult<GlobalStateOverview>;
  mattermost?: RefreshResult<MattermostOverview>;
  mail?: RefreshResult<MailOverview>;
  calendar?: RefreshResult<CalendarOverview>;
  github?: RefreshResult<GitHubOverview>;
};
type GlobalFocus = { project: string; headline: string; detail: string; next: string; updated: string };
type GlobalProject = { slug: string; name: string; status: string; summary: string; next: string; deadline: string; progress: number; source: string };
type GlobalStateOverview = { checked_at: number; updated_at: string; last_logout: string; focus: GlobalFocus; projects: GlobalProject[]; waiting_on: WaitingItem[] };
type MailMessage = {
  id: string;
  thread_id: string;
  from: string;
  from_name: string;
  from_address: string;
  to: string;
  provider?: string;
  internet_message_id?: string;
  /** Clave de la cuenta configurada (`m0`, `m1`, …). */
  mailbox: string;
  mailbox_label: string;
  mailbox_address: string;
  subject: string;
  snippet: string;
  body: string;
  labels: string[];
  unread: boolean;
  has_attachment: boolean;
  date: string;
  display_url: string;
  folder?: 'inbox' | 'sent';
  is_own?: boolean;
};
type MailAccountKey = string;
type MailAccount = {
  key: MailAccountKey;
  label: string;
  address: string;
  provider?: string;
  connected: boolean;
  unread_count: number;
  error: string;
};
type MailOverview = {
  connected: boolean;
  email_address: string;
  checked_at: number;
  unread_count: number;
  draft_count: number;
  emails: MailMessage[];
  accounts?: MailAccount[];
  warnings?: string[];
  next_page_token?: string;
  sent_truncated?: boolean;
  sent_source?: string;
  sent_source_count?: number;
  sent_accounts?: { key: string; connected: boolean; error: string; returned_count?: number }[];
};
type MailThread = { thread_id: string; messages: MailMessage[]; message_count?: number; truncated?: boolean; reconstructed?: boolean; source_thread_count?: number };
type MailDraft = { from_account: MailAccountKey; to: string; subject: string; body: string; reply_message_id: string | null };
type InboxItem = { source: string; glyph: string; title: string; meta: string; tone: string; window?: WindowName };
type ThemeMode = 'light' | 'dark';
type ProjectExitTarget = WindowName | 'app' | null;
type ProjectEditorStatus = { unsaved: boolean; busy: boolean };

const isThemeMode = (value: string | null): value is ThemeMode => value === 'light' || value === 'dark';
const isChatEngine = (value: string | null): value is ChatEngine => value === 'codex' || value === 'claude';
const isCodexModel = (value: string | null): value is CodexModel => (
  value === 'gpt-6-astra' || value === 'gpt-6.1-sol' || value === 'gpt-6-luna'
);
// Mirrors the native catalogue: only Astra and Sol reach Ultra.
const supportsUltra = (value: string) => value === 'gpt-6-astra' || value === 'gpt-6.1-sol';
const isClaudeModel = (value: string | null): value is ClaudeModel => (
  value === 'haiku' || value === 'claude-sonnet-5-5' || value === 'opus'
);
const isCodexEffort = (value: string | null): value is CodexEffort => (
  value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max' || value === 'ultra'
);

const engineLabel = (engine: ChatEngine) => engine === 'claude' ? 'Claude' : 'Codex';

// Escape dismisses the review sheet, dialog or viewer in front of a space
// before the space itself, through that layer's own Cancel/Close control.
// A layer without one keeps the space open rather than discarding context.
const dismissFrontOverlay = () => {
  const layers = [...document.querySelectorAll<HTMLElement>('.utility-window [role="dialog"], .utility-window [role="alertdialog"], .utility-window .mm-file-viewer')]
    .filter((layer) => layer.getClientRects().length > 0);
  const front = layers.at(-1);
  if (!front) return false;
  const dismiss = [...front.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    .find((button) => /^(cancelar|cerrar|conservar|volver|×)/i.test((button.getAttribute('aria-label') || button.textContent || '').trim()));
  dismiss?.click();
  return true;
};

type NavigationItem = { label: string; glyph: string; window?: WindowName; count?: number };

/** Iconos incluidos en `public/quick-icons/`; el resto de enlaces usa una inicial. */
const bundledQuickIcons = new Set(['chatgpt', 'mattermost', 'obsidian', 'overleaf', 'vscode']);

type HomeProject = {
  slug: string;
  name: string;
  shortName: string;
  eyebrow: string;
  status?: string;
  summary: string;
  next: string;
  deadline: string;
  progress: number;
  hasState: boolean;
};

/** El estado global usa valores internos en inglés; la interfaz los muestra en español. */
const projectStatusLabels: Record<string, string> = {
  active: 'Activo',
  waiting: 'Esperando',
  exploratory: 'Exploratorio',
  paused: 'Pausado',
  candidate: 'Candidato',
};
const projectStatusLabel = (status: string) => projectStatusLabels[status] ?? status;

const NO_STATE_YET = 'Sin estado todavía';

/** Un módulo desactivado figura así en la captura de Login/Logout, nunca como error. */
const NOT_CONFIGURED = { status: 'no configurado' } as const;

/** Últimos abiertos primero; si no hay historial, el orden de la configuración. */
const normalizeRecentProjectSlugs = (value: unknown, slugs: string[]) => {
  const known = new Set(slugs);
  const supplied = Array.isArray(value) ? value.filter((slug): slug is string => typeof slug === 'string') : [];
  const seen = new Set<string>();
  return [...supplied, ...slugs]
    .filter((slug) => known.has(slug) && !seen.has(slug) && Boolean(seen.add(slug)))
    .slice(0, 5);
};

const joinSpanishList = (items: string[]) => (
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} y ${items.at(-1)}`
);

const calendarEventIdentity = (event: CalendarEvent, timeZone: string) => {
  if (event.all_day) return `${event.title.trim().toLocaleLowerCase('es')}::${event.start.slice(0, 10)}`;
  const date = new Date(event.start);
  const localDay = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).format(date);
  return `${event.title.trim().toLocaleLowerCase('es')}::${localDay}`;
};

const formatMailDate = (value: string, compact = false) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('es-ES', compact
    ? { day: '2-digit', month: 'short' }
    : { day: 'numeric', month: 'long', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};

const formatLoginHistoryTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  if (date.toDateString() !== new Date().toDateString()) {
    return date.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
  }
  return date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
};

const oldestIncludedAt = (values: Array<string | number>) => {
  const timestamps = values
    .map((value) => typeof value === 'number' ? value : new Date(value).getTime())
    .filter((value) => Number.isFinite(value) && value > 0);
  return timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : null;
};

const previewLoginEntry: LoginHistoryEntry = {
  id: 'preview-login-home',
  label: 'login-preview',
  created_at: '2000-01-01T08:35:00+01:00',
  briefing: [
    '- Revisar el estado del proyecto principal y fijar el siguiente paso.',
    '- Contestar los mensajes pendientes antes de la reunión de grupo.',
    '- Reservar un bloque de dos horas para escribir.',
  ].join('\n'),
};

const cleanLoginHighlight = (value: string) => value
  .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '')
  .replace(/^\s*#{1,6}\s+/, '')
  .replace(/!\[[^\]]*]\([^)]*\)/g, '')
  .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/[*_~]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const extractLoginHighlights = (briefing: string) => {
  const lines = briefing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidates = [
    ...lines.filter((line) => /^([-+*]|\d+[.)])\s+/.test(line)),
    ...lines.filter((line) => !/^#{1,6}\s+/.test(line) && !/^([-+*]|\d+[.)])\s+/.test(line) && line.length >= 28),
  ].map(cleanLoginHighlight).filter((line) => line.length >= 12);
  return candidates.filter((line, index) => candidates.findIndex((candidate) => candidate.toLocaleLowerCase('es') === line.toLocaleLowerCase('es')) === index).slice(0, 3);
};

export default function EspritHome() {
  const config = useAppConfig();
  const { demo: demoPreview, reload: reloadConfig, reloading: configReloading } = useAppConfigControls();
  const { modules, engines } = config;
  const quick = useQuickNotes(modules.notes.enabled);
  const [quickDraft, setQuickDraft] = useState<QuickNoteDraft | null>(null);
  const logoutNoteVersions = useRef<Array<{id:string;updated_ms:number}>>([]);
  const openQuickNote = (category = 'general') => setQuickDraft({category,title:'',body:'',meeting:null});
  const journalStatus = useRef({unsaved:false,busy:false});
  const setJournalStatus = useCallback((status: {unsaved:boolean;busy:boolean}) => { journalStatus.current=status; }, []);

  const displayTimeZone = config.time_zone;
  const mattermostEnabled = modules.mattermost.enabled;
  const mailEnabled = modules.mail.enabled;
  const githubEnabled = modules.github.enabled;
  const calendarEnabled = modules.calendar.enabled;
  const clusterEnabled = modules.cluster.enabled;
  const libraryEnabled = modules.library.enabled;
  const configPalette: AppearancePalette = isAppearancePalette(config.appearance.palette) ? config.appearance.palette : 'tinta';
  const configTheme: ThemeMode = config.appearance.theme === 'dark' ? 'dark' : 'light';
  const defaultChatEngine: ChatEngine = engines.claude || !engines.codex ? 'claude' : 'codex';
  const defaultRitualModel: AgentModel = defaultChatEngine === 'claude' ? 'opus' : 'gpt-6-astra';
  const isEngineEnabled = useCallback((engine: ChatEngine) => engine === 'claude' ? engines.claude : engines.codex, [engines]);
  const projectSlugs = useMemo(() => config.projects.map((project) => project.slug), [config.projects]);
  const clusterLabel = modules.cluster.label.trim() || 'Clúster';

  const navigation = useMemo<NavigationItem[]>(() => [
    { label: 'Inicio', glyph: '⌂' },
    ...(modules.notes.enabled ? [{label:'Notas',glyph:'✎',window:'notes' as const}] : []),
    ...(modules.journal.enabled ? [{label:'Journal Club',glyph:'▤',window:'journal' as const}] : []),
    ...(mattermostEnabled ? [{ label: 'Mattermost', glyph: 'M', window: 'mattermost' as const }] : []),
    ...(mailEnabled ? [{ label: 'Correo', glyph: '@', window: 'mail' as const }] : []),
    ...(githubEnabled ? [{ label: 'GitHub', glyph: 'G', window: 'github' as const }] : []),
    ...(clusterEnabled ? [{ label: clusterLabel, glyph: clusterLabel.charAt(0).toLocaleUpperCase('es'), window: 'cluster' as const }] : []),
    { label: 'Proyectos', glyph: '◇', window: 'projects' },
    { label: 'Login / Logout', glyph: '↕', window: 'daily' },
    ...(calendarEnabled ? [{ label: 'Calendario', glyph: '□', window: 'calendar' as const }] : []),
    ...(libraryEnabled ? [{ label: 'Biblioteca', glyph: '≡', window: 'library' as const }] : []),
    ...(modules.travel.enabled ? [{ label: 'Viajes UAM', glyph: '✈', window: 'trips' as const }] : []),
    ...(modules.meetings.enabled ? [{ label: 'Reuniones', glyph: '◎', window: 'meetings' as const }] : []),
  ], [modules.notes.enabled, modules.journal.enabled, mattermostEnabled, mailEnabled, githubEnabled, clusterEnabled, clusterLabel, calendarEnabled, libraryEnabled, modules.meetings.enabled, modules.travel.enabled]);

  const windowTitles: Record<WindowName, string> = {
    notes: 'Notas', journal: 'Journal Club',
    mattermost: 'Mattermost',
    mail: 'Correo',
    github: 'GitHub',
    cluster: clusterLabel,
    meetings: 'Reuniones',
    trips: 'Viajes UAM',
    projects: 'Proyectos',
    calendar: 'Calendario',
    library: 'Biblioteca',
    daily: 'Ritual diario',
    settings: 'Configuración',
  };

  const codexContexts = useMemo(() => [
    { value: 'general', label: 'Sin proyecto', note: 'Contexto global del doctorado' },
    ...config.projects.map((project) => ({ value: project.slug, label: project.short_name, note: project.tag ?? '' })),
  ], [config.projects]);

  const contextLabels = useMemo<Record<string, string>>(() => ({
    general: 'Sin proyecto',
    ...Object.fromEntries(config.projects.map((project) => [project.slug, project.short_name])),
  }), [config.projects]);

  // Hitos de la configuración como fechas clave de día completo en la zona
  // configurada. Una fecha mal escrita se omite en lugar de romper Inicio.
  const pinnedDeadlines = useMemo(() => config.milestones.flatMap((milestone, index): Array<CalendarEvent & { meta: string }> => {
    try {
      return [{
        id: `pinned:${index}`,
        calendar: '',
        title: milestone.title,
        start: zonedWallTimeIso(milestone.date, '00:00', displayTimeZone),
        end: zonedWallTimeIso(nextDateKey(milestone.date), '00:00', displayTimeZone),
        all_day: true,
        location: null,
        meta: milestone.meta ?? 'Hito',
      }];
    } catch {
      return [];
    }
  }), [config.milestones, displayTimeZone]);

  const [theme, setTheme] = useState<ThemeMode>(configTheme);
  const [palette, setPalette] = useState<AppearancePalette>(configPalette);
  const [textSize, setTextSize] = useState<AppearanceTextSize>('comfortable');
  const [showHiddenFiles, setShowHiddenFiles] = useState(false);
  const [homeDesignPreview, setHomeDesignPreview] = useState(false);
  const [projectOpenRequest,setProjectOpenRequest] = useState<{project:string;relativePath:string;nonce:number}|null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeWindow, setActiveWindow] = useState<WindowName | null>(null);
  const activeSpaceRef = useRef<WindowName | null>(null);
  useEffect(() => { activeSpaceRef.current = activeWindow; }, [activeWindow]);
  const [keptSpaces, setKeptSpaces] = useState({ projects: false, library: false, cluster: false, journal: false });
  const [projectEditorStatus, setProjectEditorStatus] = useState<ProjectEditorStatus>({ unsaved: false, busy: false });
  const [projectExitReview, setProjectExitReview] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [selectedContext, setSelectedContext] = useState('general');
  // Marca que las preferencias y la transcripción ya se leyeron del almacén
  // local. Sin esto, el efecto que guarda la transcripción se ejecutaría en el
  // primer render con la lista vacía y borraría lo guardado antes de leerlo.
  const [hydrated, setHydrated] = useState(false);
  // El composer de la topbar se expande sobre el dashboard, así que solo debe
  // crecer mientras se escribe en él: un borrador olvidado no puede dejar un
  // panel grande flotando encima.
  // Entrevista del Logout: una respuesta por pregunta, más un cuadro libre
  // para lo que las preguntas no cubren.
  const [logoutQuestions, setLogoutQuestions] = useState<string[]>([]);
  const [logoutAnswers, setLogoutAnswers] = useState<string[]>([]);
  const [logoutExtra, setLogoutExtra] = useState('');
  // Modelo y razonamiento de Login, Logout y el radar de papers. Es una
  // preferencia aparte de la del chat cotidiano: los rituales corren solos y
  // conviene poder darles más esfuerzo sin encarecer cada conversación.
  const [ritualModel, setRitualModel] = useState<AgentModel>(defaultRitualModel);
  const [ritualEffort, setRitualEffort] = useState<CodexEffort>('high');
  const [composerFocused, setComposerFocused] = useState(false);
  const [chatEngine, setChatEngine] = useState<ChatEngine>(defaultChatEngine);
  const [codexModel, setCodexModel] = useState<CodexModel>('gpt-6.1-sol');
  const [claudeModel, setClaudeModel] = useState<ClaudeModel>('opus');
  const [codexEffort, setCodexEffort] = useState<CodexEffort>('medium');
  const selectChatProfile = useCallback((profile: ChatProfile) => {
    setSelectedContext(profile.context);
    setChatEngine(profile.engine);
    if (profile.engine === 'codex') setCodexModel(profile.model as CodexModel);
    else setClaudeModel(profile.model as ClaudeModel);
    setCodexEffort(profile.effort);
  }, []);
  const chat = useChatConversations({ context: selectedContext, engine: chatEngine, model: chatEngine === 'claude' ? claudeModel : codexModel, effort: codexEffort }, selectChatProfile);
  const prompt = chat.draft;
  const setPrompt = chat.setDraft;
  const isAsking = chat.isAsking;
  const [toast, setToast] = useState<string | null>(null);
  const research = useResearch();
  const { ready: researchReady, error: researchError, drafts: researchDrafts, putDraft: putResearchDraft, captureFocused: captureResearchInput, flush: flushResearch, isWriting: isResearchWriting } = research;
  const [noteDraftId, setNoteDraftId] = useState<string | null>(null);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [paperTarget, setPaperTarget] = useState<PaperTarget | null>(null);
  const [attentionTab, setAttentionTab] = useState<'waiting' | 'inbox'>('waiting');
  const openResearchNote = useCallback((note: ResearchNote, existingDraft?: string) => {
    if (!researchReady) { setToast(researchError || 'Cargando los borradores…'); return; }
    const previousDraft = existingDraft || (note.id ? Object.keys(researchDrafts).find(key => researchDrafts[key].id === note.id) : null);
    const id = previousDraft || crypto.randomUUID();
    if (!previousDraft && !putResearchDraft(id, note)) { setToast('No se pudo crear otro borrador. Revisa los borradores existentes.'); return; }
    setNoteDraftId(id);
  }, [researchReady, researchError, researchDrafts, putResearchDraft]);
  const [mattermostOverview, setMattermostOverview] = useState<MattermostOverview | null>(null);
  const [mattermostError, setMattermostError] = useState<string | null>(null);
  const [mattermostLoading, setMattermostLoading] = useState(false);
  const [selectedMattermostChannel, setSelectedMattermostChannel] = useState<string | null>(null);
  const [mattermostChannelData, setMattermostChannelData] = useState<MattermostChannelData | null>(null);
  const [mattermostChannelLoading, setMattermostChannelLoading] = useState(false);
  const [mattermostAvatars, setMattermostAvatars] = useState<Record<string, MattermostAvatar>>({});
  const [selectedProjectExplorer, setSelectedProjectExplorer] = useState<string | null>(null);
  // Lo guardado en este equipo, sin filtrar; la lista visible se deriva de la
  // configuración para que añadir o quitar proyectos no pierda el historial.
  const [storedRecentProjectSlugs, setStoredRecentProjectSlugs] = useState<string[]>([]);
  const recentProjectSlugs = useMemo(() => normalizeRecentProjectSlugs(storedRecentProjectSlugs, projectSlugs), [storedRecentProjectSlugs, projectSlugs]);
  const [acknowledgedMattermost, setAcknowledgedMattermost] = useState<Record<string, number>>({});
  const [mailOverview, setMailOverview] = useState<MailOverview | null>(null);
  const [mailError, setMailError] = useState<string | null>(null);
  const [mailLoading, setMailLoading] = useState(false);
  const [selectedMailThread, setSelectedMailThread] = useState<string | null>(null);
  const [mailThread, setMailThread] = useState<MailThread | null>(null);
  const [mailThreadLoading, setMailThreadLoading] = useState(false);
  const [selectedMailAccount, setSelectedMailAccount] = useState<'all' | MailAccountKey>('all');
  const [selectedMailFolder, setSelectedMailFolder] = useState<'inbox' | 'sent'>('inbox');
  // Reparto entre la revisión documentada y el formulario de respuestas. El
  // valor es la parte de arriba, así que arrastrar la barra hacia arriba
  // agranda el área donde se escribe.
  const interviewSplit = useResizableSplit({
    storageKey: 'esprit-logout-interview-split',
    defaultValue: 55,
    min: 18,
    // El tope deja al formulario al menos un 30% del alto, más de lo que tenía
    // con la altura fija anterior: arrastrar hacia abajo no puede empeorarlo.
    max: 70,
    axis: 'horizontal',
  });
  const mailSplit = useResizableSplit({ storageKey: 'esprit-mail-split', defaultValue: 32, min: 18, max: 72 });
  const [mailLayout, setMailLayout] = useState<'inbox' | 'split' | 'message'>('split');
  const [mailComposeKind, setMailComposeKind] = useState<'new' | 'reply' | 'forward'>('new');
  const [mailForwardHasAttachments, setMailForwardHasAttachments] = useState(false);
  const mailReadRequest = useRef(new LatestRequest());
  // Opened conversations, in WebView memory only (never persisted), keyed by the
  // thread and its newest listed message so a new reply invalidates the entry.
  const mailThreadCache = useRef(new Map<string, MailThread>());
  const [mailDraft, setMailDraft] = useState<MailDraft>({ from_account: config.modules.mail.accounts[0]?.key ?? '', to: '', subject: '', body: '', reply_message_id: null });
  const [mailComposerOpen, setMailComposerOpen] = useState(false);
  const [mailSendConfirm, setMailSendConfirm] = useState(false);
  const [mailSending, setMailSending] = useState(false);
  const [githubOverview, setGitHubOverview] = useState<GitHubOverview | null>(null);
  const [githubError, setGitHubError] = useState<string | null>(null);
  const [githubLoading, setGitHubLoading] = useState(false);
  const [selectedGitHubRepository, setSelectedGitHubRepository] = useState<string | null>(null);
  const [githubCompactPanel, setGitHubCompactPanel] = useState<GitHubPanel>('activity');
  const [calendarOverview, setCalendarOverview] = useState<CalendarOverview | null>(null);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [globalState, setGlobalState] = useState<GlobalStateOverview | null>(null);
  const [globalStateError, setGlobalStateError] = useState<string | null>(null);
  const [dailyMode, setDailyMode] = useState<DailyMode>('login');
  const [logoutPhase, setLogoutPhase] = useState<LogoutPhase>('discovering');
  const [logoutDiscovery, setLogoutDiscovery] = useState('');
  const [logoutDiscoveryId, setLogoutDiscoveryId] = useState<string | null>(null);
  const [dailyNotes, setDailyNotes] = useState('');
  const [dailyPreview, setDailyPreview] = useState('');
  const [dailyPlanId, setDailyPlanId] = useState<string | null>(null);
  const [dailyResult, setDailyResult] = useState('');
  const [loginResult, setLoginResult] = useState('');
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [dailyWarnings, setDailyWarnings] = useState<string[]>([]);
  const [dailyBusy, setDailyBusy] = useState(false);
  const [runningRitualProfile, setRunningRitualProfile] = useState<{ model: AgentModel; effort: CodexEffort } | null>(null);
  const displayedRitualProfile = runningRitualProfile ?? { model: ritualModel, effort: ritualEffort };
  const ritualModelLabel = chat.catalog?.engines.flatMap((engine) => engine.models).find((model) => model.value === displayedRitualProfile.model)?.label ?? displayedRitualProfile.model;
  const ritualEffortLabel = ({ low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Extra-high', max: 'Máximo', ultra: 'Ultra' } as Record<string, string>)[displayedRitualProfile.effort] ?? displayedRitualProfile.effort;
  const [dailyApplied, setDailyApplied] = useState(false);
  const [dailySessionKind, setDailySessionKind] = useState<DailyMode | null>(null);
  const [dailyHistoryReview, setDailyHistoryReview] = useState<DailyHistoryReview | null>(null);
  const [dailyHistoryTab, setDailyHistoryTab] = useState<DailyMode>('login');
  const [loginHistory, setLoginHistory] = useState<LoginHistoryEntry[]>([]);
  const [loginHistoryLoading, setLoginHistoryLoading] = useState(false);
  const [loginHistoryError, setLoginHistoryError] = useState<string | null>(null);
  const [selectedLoginId, setSelectedLoginId] = useState<string | null>(null);
  const [loginDeleteCandidate, setLoginDeleteCandidate] = useState<string | null>(null);
  const [loginDeleting, setLoginDeleting] = useState<string | null>(null);
  const [logoutHistory, setLogoutHistory] = useState<LogoutHistoryEntry[]>([]);
  const [logoutHistoryLoading, setLogoutHistoryLoading] = useState(false);
  const [logoutHistoryError, setLogoutHistoryError] = useState<string | null>(null);
  const compactInputRef = useRef<HTMLTextAreaElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const utilityWindowRef = useRef<HTMLElement>(null);
  const lastWindowTriggerRef = useRef<HTMLElement | null>(null);
  const projectEditorStatusRef = useRef<ProjectEditorStatus>({ unsaved: false, busy: false });
  const projectExitTargetRef = useRef<ProjectExitTarget>(null);
  const projectExitActionRef = useRef<(() => void) | null>(null);
  const selectedMattermostChannelRef = useRef<string | null>(null);
  const mattermostChannelRequestRef = useRef(0);
  // Last recent read per channel, in memory only, so switching back shows the
  // conversation at once while a quiet refresh replaces it.
  const mattermostChannelSnapshots = useRef(new Map<string, MattermostChannelData>());
  const mattermostChannelReadsRef = useRef(new Map<string, number>());
  const mattermostAvatarQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const mattermostRefreshPromise = useRef<Promise<RefreshResult<MattermostOverview>> | null>(null);
  const mattermostAvatarRequestsRef = useRef<Set<string>>(new Set());
  const mattermostFullHistoryRef = useRef<Set<string>>(new Set());
  const mailRefreshPromise = useRef<Promise<RefreshResult<MailOverview>> | null>(null);
  const githubRefreshPromise = useRef<Promise<RefreshResult<GitHubOverview>> | null>(null);
  const calendarRefreshPromise = useRef<Promise<RefreshResult<CalendarOverview>> | null>(null);
  const globalStateRefreshPromise = useRef<Promise<RefreshResult<GlobalStateOverview>> | null>(null);

  const updateProjectEditorStatus = useCallback((status: ProjectEditorStatus) => {
    projectEditorStatusRef.current = status;
    setProjectEditorStatus(status);
  }, []);

  const requestWindowTransition = useCallback((target: WindowName | null) => {
    setProjectExitReview(false);
    projectExitActionRef.current = null;
    setActiveWindow(target);
    if (target === 'projects' || target === 'library' || target === 'cluster' || target === 'journal') setKeptSpaces((current) => ({ ...current, [target]: true }));
    if (!target) window.requestAnimationFrame(() => lastWindowTriggerRef.current?.focus());
    return true;
  }, []);

  const closeUtilityWindow = useCallback(() => {
    requestWindowTransition(null);
  }, [requestWindowTransition]);

  const cancelProjectExit = useCallback(() => {
    projectExitTargetRef.current = null;
    projectExitActionRef.current = null;
    setProjectExitReview(false);
  }, []);

  const { cancel: cancelChat, flush: flushChat, setDraft: storeChatDraft } = chat;
  const [nativeCloseError, setNativeCloseError] = useState<string | null>(null);
  const closingNativeRef = useRef(false);
  const nativeCloseApprovedRef = useRef(false);
  const finishNativeClose = useCallback(async () => {
    if (closingNativeRef.current) return;
    closingNativeRef.current = true;
    setNativeCloseError(null);
    try {
      if (isResearchWriting()) throw new Error('Se está guardando una nota en el proyecto. Espera a que termine y vuelve a cerrar.');
      // Capture the visible final input even if macOS Quit reached the bridge
      // before React processed its last keyboard/input event.
      const focused = document.activeElement;
      if (focused && (focused === compactInputRef.current || focused === chatInputRef.current)) storeChatDraft((focused as HTMLTextAreaElement).value);
      captureResearchInput();
      await cancelChat();
      await flushChat();
      await flushResearch();
      nativeCloseApprovedRef.current = true;
      await invoke('close_esprit_window');
    } catch (error) {
      nativeCloseApprovedRef.current = false;
      setNativeCloseError(typeof error === 'object' && error && 'message' in error ? String(error.message) : String(error));
    } finally {
      closingNativeRef.current = false;
    }
  }, [cancelChat, flushChat, storeChatDraft, captureResearchInput, flushResearch, isResearchWriting]);
  const closeHandlerRef = useRef(finishNativeClose);
  useEffect(() => { closeHandlerRef.current = finishNativeClose; }, [finishNativeClose]);

  const confirmProjectExit = useCallback(() => {
    const target = projectExitTargetRef.current;
    const deferredAction = projectExitActionRef.current;
    projectExitTargetRef.current = null;
    projectExitActionRef.current = null;
    setProjectExitReview(false);
    if (target === 'app') {
      void closeHandlerRef.current();
      return;
    }
    setActiveWindow(target);
    if (target === 'projects' || target === 'library' || target === 'cluster' || target === 'journal') setKeptSpaces((current) => ({ ...current, [target]: true }));
    if (!target) window.requestAnimationFrame(() => lastWindowTriggerRef.current?.focus());
    if (deferredAction) window.setTimeout(deferredAction, 0);
  }, []);

  useEffect(() => {
    projectEditorStatusRef.current = projectEditorStatus;
  }, [projectEditorStatus]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (nativeCloseApprovedRef.current || (!projectEditorStatusRef.current.unsaved && !projectEditorStatusRef.current.busy && !journalStatus.current.unsaved && !journalStatus.current.busy)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    if (!('__TAURI_INTERNALS__' in window)) return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(({ listen }) => listen('esprit-close-requested', () => {
      if (nativeCloseApprovedRef.current) return;
      if (projectEditorStatusRef.current.busy || journalStatus.current.busy) {
        setToast('Espera a que termine la operación actual antes de cerrar Esprit.');
        return;
      }
      if (journalStatus.current.unsaved) { setActiveWindow('journal'); setToast('Guarda los cambios de Journal Club antes de cerrar. El borrador se conserva en este equipo.'); return; }
      if (!projectEditorStatusRef.current.unsaved) {
        void closeHandlerRef.current();
        return;
      }
      setKeptSpaces((current) => ({ ...current, projects: true }));
      setActiveWindow('projects');
      projectExitTargetRef.current = 'app';
      projectExitActionRef.current = null;
      setProjectExitReview(true);
    })).then(async (cleanup) => {
      if (cancelled) { cleanup(); return; }
      unlisten = cleanup;
      await invoke('arm_esprit_close_guard');
    }).catch((error) => {
      if (!cancelled) setNativeCloseError(`No se pudo preparar el cierre seguro: ${String(error)}`);
    });
    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  // Valores de la configuración en el momento de abrir: las preferencias
  // guardadas en este equipo mandan; la configuración solo da el punto de partida.
  const [mountDefaults] = useState(() => ({ theme: configTheme, palette: configPalette, engine: defaultChatEngine, ritualModel: defaultRitualModel, engines }));

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const search = new URLSearchParams(window.location.search);
      const requestedTheme = search.get('theme');
      const storedTheme = window.localStorage.getItem('esprit-theme');
      const storedPalette = window.localStorage.getItem('esprit-palette');
      const storedTextSize = window.localStorage.getItem('esprit-text-size');
      const storedShowHiddenFiles = window.localStorage.getItem('esprit-show-hidden-files');
      const storedChatEngine = window.localStorage.getItem('esprit-chat-engine');
      const storedCodexModel = window.localStorage.getItem('esprit-codex-model');
      const storedClaudeModel = window.localStorage.getItem('esprit-claude-model');
      const storedCodexEffort = window.localStorage.getItem('esprit-codex-effort');
      const storedRitualModel = window.localStorage.getItem('esprit-ritual-model');
      const storedRitualEffort = window.localStorage.getItem('esprit-ritual-effort');
      const storedRecentProjects = window.localStorage.getItem('esprit-recent-projects-v1');
      const storedMailLayout = window.localStorage.getItem('esprit-mail-layout');
      const engineAvailable = (engine: ChatEngine) => engine === 'claude' ? mountDefaults.engines.claude : mountDefaults.engines.codex;
      if (storedMailLayout === 'inbox' || storedMailLayout === 'split' || storedMailLayout === 'message') setMailLayout(storedMailLayout);
      const nextTextSize = isAppearanceTextSize(storedTextSize) ? storedTextSize : 'comfortable';
      setTheme(isThemeMode(requestedTheme) ? requestedTheme : isThemeMode(storedTheme) ? storedTheme : mountDefaults.theme);
      setPalette(isAppearancePalette(storedPalette) ? storedPalette : mountDefaults.palette);
      setTextSize(nextTextSize);
      setShowHiddenFiles(storedShowHiddenFiles === '1');
      document.documentElement.dataset.textSize = nextTextSize;
      setChatEngine(isChatEngine(storedChatEngine) && engineAvailable(storedChatEngine) ? storedChatEngine : mountDefaults.engine);
      // A retired Codex model is replaced by its successor once, then remembered.
      const restoredCodexModel = currentAgentModel(storedCodexModel ?? '');
      setCodexModel(isCodexModel(restoredCodexModel) ? restoredCodexModel : 'gpt-6.1-sol');
      if (isCodexModel(restoredCodexModel) && restoredCodexModel !== storedCodexModel) window.localStorage.setItem('esprit-codex-model', restoredCodexModel);
      setClaudeModel(isClaudeModel(currentAgentModel(storedClaudeModel ?? '')) ? currentAgentModel(storedClaudeModel ?? '') as ClaudeModel : 'opus');
      setCodexEffort(isCodexEffort(storedCodexEffort) ? storedCodexEffort : 'medium');
      const restoredRitualModel = currentAgentModel(storedRitualModel ?? '');
      const effectiveRitualModel = (isCodexModel(restoredRitualModel) && engineAvailable('codex')) || (isClaudeModel(restoredRitualModel) && engineAvailable('claude'))
        ? restoredRitualModel
        : mountDefaults.ritualModel;
      setRitualModel(effectiveRitualModel);
      if (effectiveRitualModel === restoredRitualModel && restoredRitualModel !== storedRitualModel) window.localStorage.setItem('esprit-ritual-model', restoredRitualModel);
      if (isCodexEffort(storedRitualEffort)) setRitualEffort(storedRitualEffort === 'ultra' && !supportsUltra(effectiveRitualModel) ? 'xhigh' : storedRitualEffort);
      try {
        const parsed: unknown = storedRecentProjects ? JSON.parse(storedRecentProjects) : [];
        setStoredRecentProjectSlugs(Array.isArray(parsed) ? parsed.filter((slug): slug is string => typeof slug === 'string').slice(0, 40) : []);
      } catch {
        setStoredRecentProjectSlugs([]);
      }
      setHomeDesignPreview(search.get('preview') === 'home');
      setHydrated(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mountDefaults]);

  useEffect(() => {
    if (!activeWindow) return;
    const frame = window.requestAnimationFrame(() => utilityWindowRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [activeWindow]);

  const toggleTheme = () => {
    setTheme((current) => {
      const next = current === 'light' ? 'dark' : 'light';
      window.localStorage.setItem('esprit-theme', next);
      return next;
    });
  };

  const updateTheme = (value: ThemeMode) => {
    setTheme(value);
    window.localStorage.setItem('esprit-theme', value);
  };

  const updatePalette = (value: AppearancePalette) => {
    setPalette(value);
    window.localStorage.setItem('esprit-palette', value);
  };

  const updateTextSize = (value: AppearanceTextSize) => {
    setTextSize(value);
    document.documentElement.dataset.textSize = value;
    window.localStorage.setItem('esprit-text-size', value);
  };

  const updateShowHiddenFiles = (value: boolean) => {
    setShowHiddenFiles(value);
    window.localStorage.setItem('esprit-show-hidden-files', value ? '1' : '0');
  };

  const resetAppearance = () => {
    updateTheme(configTheme);
    updatePalette(configPalette);
    updateTextSize('comfortable');
    setToast('Estilo inicial restaurado.');
  };

  const updateChatEngine = (value: string) => {
    if (!isChatEngine(value) || !isEngineEnabled(value)) return;
    setChatEngine(value);
    window.localStorage.setItem('esprit-chat-engine', value);
  };

  // Cada motor recuerda su propio modelo, así que alternar no pierde la elección.
  const updateCodexModel = (value: string) => {
    if (chatEngine === 'claude') {
      if (!isClaudeModel(value)) return;
      setClaudeModel(value);
      window.localStorage.setItem('esprit-claude-model', value);
      return;
    }
    if (!isCodexModel(value)) return;
    setCodexModel(value);
    window.localStorage.setItem('esprit-codex-model', value);
  };

  const updateCodexEffort = (value: string) => {
    if (!isCodexEffort(value)) return;
    setCodexEffort(value);
    window.localStorage.setItem('esprit-codex-effort', value);
  };

  const activeChatModel: AgentModel = chatEngine === 'claude' ? claudeModel : codexModel;

  const updateRitualModel = (value: string) => {
    if (!(isCodexModel(value) && isEngineEnabled('codex')) && !(isClaudeModel(value) && isEngineEnabled('claude'))) return;
    if (!supportsUltra(value) && ritualEffort === 'ultra') {
      setRitualEffort('xhigh');
      window.localStorage.setItem('esprit-ritual-effort', 'xhigh');
    }
    setRitualModel(value);
    window.localStorage.setItem('esprit-ritual-model', value);
  };
  const updateRitualEffort = (value: string) => {
    if (!isCodexEffort(value)) return;
    setRitualEffort(value);
    window.localStorage.setItem('esprit-ritual-effort', value);
  };
  const nativeEngines = (chat.catalog?.engines ?? [])
    .filter((engine) => isEngineEnabled(engine.value))
    .map((engine) => ({ value: engine.value, label: engine.label, note: engine.value === 'codex' ? 'Codex CLI' : 'Claude Code' }));
  const nativeModels = chat.catalog?.engines.find((engine) => engine.value === chatEngine)?.models ?? [];
  const nativeModel = nativeModels.find((model) => model.value === activeChatModel);
  const nativeEfforts = (nativeModel?.efforts ?? []).map((value) => ({ value, label: value === 'xhigh' ? 'xHigh' : value[0].toUpperCase() + value.slice(1) }));
  useEffect(() => {
    if (!nativeModel || nativeModel.efforts.includes(codexEffort)) return;
    const frame = window.requestAnimationFrame(() => {
      setCodexEffort(nativeModel.default_effort);
      window.localStorage.setItem('esprit-codex-effort', nativeModel.default_effort);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [nativeModel, codexEffort]);

  /**
   * Reúne las respuestas en el mismo formato numerado que el ritual ya
   * esperaba cuando todo se escribía en un solo cuadro, así que el contrato
   * del prompt no cambia. Las preguntas sin responder se omiten.
   */
  const composedLogoutNotes = () => {
    const answered = logoutQuestions
      .map((question, index) => ({ question, answer: (logoutAnswers[index] ?? '').trim(), index }))
      .filter((entry) => entry.answer.length > 0)
      .map((entry) => `${entry.index + 1}. ${entry.question}\n${entry.answer}`);
    const extra = logoutExtra.trim();
    if (extra) answered.push(`Además:\n${extra}`);
    return answered.join('\n\n');
  };
  const logoutAnsweredCount = logoutAnswers.filter((answer) => answer.trim().length > 0).length;
  const logoutHasNotes = logoutAnsweredCount > 0 || logoutExtra.trim().length > 0;

  // El composer compacto no puede empujar la topbar, que mide 64px fijos, así
  // que al crecer se expande flotando por encima del dashboard.
  useAutoGrow(compactInputRef, prompt, { minHeight: 39, maxHeight: 132, expanded: composerFocused });
  // El del chat vive en su propio panel, así que crece siempre.
  useAutoGrow(chatInputRef, prompt, { minHeight: 48, maxHeight: 240 });

  const rememberProject = useCallback((slug: string) => {
    if (!projectSlugs.includes(slug)) return;
    setStoredRecentProjectSlugs((current) => {
      const next = normalizeRecentProjectSlugs([slug, ...current], projectSlugs);
      window.localStorage.setItem('esprit-recent-projects-v1', JSON.stringify(next));
      return next;
    });
  }, [projectSlugs]);

  const selectProjectExplorer = useCallback((slug: string) => {
    if (!projectSlugs.includes(slug)) return;
    setSelectedProjectExplorer(slug);
    rememberProject(slug);
  }, [projectSlugs, rememberProject]);

  const selectCodexContext = useCallback((context: string) => {
    setSelectedContext(context);
    if (projectSlugs.includes(context)) rememberProject(context);
  }, [projectSlugs, rememberProject]);

  const refreshMattermost = useCallback(async (force = false) => {
    if (!('__TAURI_INTERNALS__' in window) || !mattermostEnabled) return { overview: null, error: null };
    if (mattermostRefreshPromise.current) return mattermostRefreshPromise.current;
    setMattermostLoading(true);
    const request = Promise.resolve()
      .then(async (): Promise<RefreshResult<MattermostOverview>> => {
        try {
          const overview = await invoke<MattermostOverview>('mattermost_overview', { force });
          setMattermostOverview(overview);
          setMattermostError(null);
          return { overview, error: null };
        } catch (error) {
          const message = String(error);
          setMattermostError(message);
          return { overview: null, error: message };
        }
      })
      .finally(() => {
        setMattermostLoading(false);
        mattermostRefreshPromise.current = null;
      });
    mattermostRefreshPromise.current = request;
    return request;
  }, [mattermostEnabled]);

  const refreshMail = useCallback(async () => {
    if (!('__TAURI_INTERNALS__' in window) || !mailEnabled) return { overview: null, error: null };
    if (mailRefreshPromise.current) return mailRefreshPromise.current;
    setMailLoading(true);
    const request = Promise.resolve()
      .then(async (): Promise<RefreshResult<MailOverview>> => {
        try {
          const overview = await invoke<MailOverview>('mail_overview');
          setMailOverview(overview);
          setMailError(null);
          return { overview, error: null };
        } catch (error) {
          const message = String(error);
          setMailError(message);
          return { overview: null, error: message };
        }
      })
      .finally(() => {
        setMailLoading(false);
        mailRefreshPromise.current = null;
      });
    mailRefreshPromise.current = request;
    return request;
  }, [mailEnabled]);

  const refreshGitHub = useCallback(async () => {
    if (!('__TAURI_INTERNALS__' in window) || !githubEnabled) return { overview: null, error: null };
    if (githubRefreshPromise.current) return githubRefreshPromise.current;
    setGitHubLoading(true);
    const request = Promise.resolve()
      .then(async (): Promise<RefreshResult<GitHubOverview>> => {
        try {
          const overview = await invoke<GitHubOverview>('github_overview');
          setGitHubOverview(overview);
          setGitHubError(null);
          return { overview, error: null };
        } catch (error) {
          const message = String(error);
          setGitHubError(message);
          return { overview: null, error: message };
        }
      })
      .finally(() => {
        setGitHubLoading(false);
        githubRefreshPromise.current = null;
      });
    githubRefreshPromise.current = request;
    return request;
  }, [githubEnabled]);

  const refreshCalendar = useCallback(async (force = false): Promise<RefreshResult<CalendarOverview>> => {
    if (!('__TAURI_INTERNALS__' in window) || !calendarEnabled) return { overview: null, error: null };
    const inFlight = calendarRefreshPromise.current;
    if (inFlight) {
      if (!force) return inFlight;
      await inFlight;
      if (calendarRefreshPromise.current) return calendarRefreshPromise.current;
    }
    setCalendarLoading(true);
    const request = Promise.resolve()
      .then(async (): Promise<RefreshResult<CalendarOverview>> => {
        try {
          const overview = await invoke<CalendarOverview>('calendar_overview', { force });
          setCalendarOverview(overview);
          setCalendarError(null);
          return { overview, error: null };
        } catch (error) {
          const message = String(error);
          setCalendarError(message);
          return { overview: null, error: message };
        }
      })
      .finally(() => {
        setCalendarLoading(false);
        calendarRefreshPromise.current = null;
      });
    calendarRefreshPromise.current = request;
    return request;
  }, [calendarEnabled]);

  const refreshGlobalState = useCallback(async () => {
    if (!('__TAURI_INTERNALS__' in window)) return { overview: null, error: null };
    if (globalStateRefreshPromise.current) return globalStateRefreshPromise.current;
    const request = Promise.resolve()
      .then(async (): Promise<RefreshResult<GlobalStateOverview>> => {
        try {
          const overview = await invoke<GlobalStateOverview>('global_state_overview');
          setGlobalState(overview);
          setGlobalStateError(null);
          return { overview, error: null };
        } catch (error) {
          const message = String(error);
          setGlobalStateError(message);
          return { overview: null, error: message };
        }
      })
      .finally(() => {
        globalStateRefreshPromise.current = null;
      });
    globalStateRefreshPromise.current = request;
    return request;
  }, []);

  const refreshLoginHistory = useCallback(async () => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    setLoginHistoryLoading(true);
    try {
      const overview = await invoke<LoginHistoryOverview>('login_history_overview');
      setLoginHistory(overview.entries);
      setLoginDeleteCandidate(null);
      setLoginHistoryError(null);
    } catch (error) {
      setLoginHistoryError(String(error));
    } finally {
      setLoginHistoryLoading(false);
    }
  }, []);

  const refreshLogoutHistory = useCallback(async () => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    setLogoutHistoryLoading(true);
    try {
      const overview = await invoke<LogoutHistoryOverview>('logout_history_overview');
      setLogoutHistory(overview.entries);
      setLogoutHistoryError(null);
    } catch (error) {
      setLogoutHistoryError(String(error));
    } finally {
      setLogoutHistoryLoading(false);
    }
  }, []);

  const toggleHistoryKeep = async (kind: DailyMode, entry: LoginHistoryEntry | LogoutHistoryEntry) => {
    try {
      if (kind === 'login') {
        const overview = await invoke<LoginHistoryOverview>('login_history_keep', { request: { entry_id: entry.id, kept: !entry.kept } });
        setLoginHistory(overview.entries);
      } else {
        const overview = await invoke<LogoutHistoryOverview>('logout_history_keep', { request: { entry_id: entry.id, kept: !entry.kept } });
        setLogoutHistory(overview.entries);
      }
      setToast(entry.kept ? 'El registro volverá a caducar a los 7 días.' : 'Registro conservado más allá de 7 días.');
    } catch (reason) { setToast(String(reason)); }
  };

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('esprit-mattermost-seen');
      if (stored) window.requestAnimationFrame(() => setAcknowledgedMattermost(JSON.parse(stored)));
    } catch {
      // A corrupt local cache should never prevent Esprit from opening.
    }
    if (!mattermostEnabled) return;
    return startVisiblePolling(() => refreshMattermost(), 60_000, { initialDelayMs: 150, resumeDelayMs: () => activeSpaceRef.current === 'mattermost' ? 0 : 500 });
  }, [mattermostEnabled, refreshMattermost]);

  useEffect(() => {
    if (!mailEnabled) return;
    return startVisiblePolling(() => refreshMail(), 120_000, { initialDelayMs: 350, resumeDelayMs: () => activeSpaceRef.current === 'mail' ? 0 : 1000 });
  }, [mailEnabled, refreshMail]);

  useEffect(() => {
    if (!githubEnabled) return;
    return startVisiblePolling(() => refreshGitHub(), 300_000, { initialDelayMs: 900, resumeDelayMs: () => activeSpaceRef.current === 'github' ? 0 : 1700 });
  }, [githubEnabled, refreshGitHub]);

  useEffect(() => {
    if (!calendarEnabled) return;
    return startVisiblePolling(() => refreshCalendar(), 120_000, { initialDelayMs: 600, resumeDelayMs: () => activeSpaceRef.current === 'calendar' ? 0 : 1400 });
  }, [calendarEnabled, refreshCalendar]);

  // Un módulo desactivado al recargar la configuración cierra su espacio.
  useEffect(() => {
    if (!activeWindow || activeWindow === 'settings' || navigation.some((item) => item.window === activeWindow)) return;
    const frame = window.requestAnimationFrame(() => setActiveWindow(null));
    return () => window.cancelAnimationFrame(frame);
  }, [activeWindow, navigation]);

  useEffect(() => {
    if (activeWindow !== 'calendar') return;
    void refreshCalendar(true);
  }, [activeWindow, refreshCalendar]);

  useEffect(() => {
    return startVisiblePolling(() => refreshGlobalState(), 300_000, { resumeDelayMs: 200 });
  }, [refreshGlobalState]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshLoginHistory(); void refreshLogoutHistory(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshLoginHistory, refreshLogoutHistory]);

  const effectiveMattermostBadge = useCallback((channel: MattermostChannel) => (
    acknowledgedMattermost[channel.id] >= channel.last_post_at ? 0 : channel.badge
  ), [acknowledgedMattermost]);

  const mattermostNotificationCount = mattermostOverview?.channels.reduce(
    (total, channel) => total + effectiveMattermostBadge(channel),
    0,
  ) ?? 0;
  const mailNotificationCount = mailOverview?.unread_count ?? 0;
  const githubNotificationCount = githubOverview?.connected ? githubOverview.notification_count : 0;
  const githubAuthenticationExpired = githubOverview?.status === 'auth_required';
  const githubCoverageIncomplete = Boolean(githubOverview?.connected && (
    githubError
    || githubOverview.error
    || githubOverview.status !== 'available'
    || (githubOverview.warnings?.length ?? 0) > 0
    || githubOverview.coverage?.activity_truncated
    || githubOverview.coverage?.notifications_truncated
  ));
  // The exported HTML may be opened days after it was built. The first client
  // render must share this neutral clock; only an effect reads the live date.
  const [now, setNow] = useState(0);
  useEffect(() => startVisiblePolling(() => setNow(Date.now()), 60_000), []);
  const upcomingCalendarEvents = calendarOverview?.events.filter((event) => new Date(event.end).getTime() > now) ?? [];
  const futureCalendarEvents = upcomingCalendarEvents.filter((event) => new Date(event.start).getTime() >= now);
  const coreCalendars = new Set(modules.calendar.read);
  const calendarNotificationCount = upcomingCalendarEvents.filter((event) => {
    const startsIn = new Date(event.start).getTime() - now;
    return coreCalendars.has(event.calendar) && startsIn >= 0 && startsIn <= 24 * 60 * 60 * 1000;
  }).length;
  const globalNotificationCount = mattermostNotificationCount + mailNotificationCount + calendarNotificationCount + githubNotificationCount;
  const checkedTime = (checkedAt: number) => new Date(checkedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: displayTimeZone });
  const configuredMailAccounts = modules.mail.accounts;
  const mattermostInboxItem: InboxItem = {
    source: 'Mattermost',
    glyph: 'M',
    title: mattermostError
      ? 'No se pudo actualizar'
      : mattermostNotificationCount > 0
        ? `${mattermostNotificationCount} ${mattermostNotificationCount === 1 ? 'aviso' : 'avisos'}`
        : 'Todo al día',
    meta: mattermostError
      ? 'Comprueba la conexión o abre Mattermost'
      : mattermostOverview
        ? `${mattermostOverview.team ? `${mattermostOverview.team} · ` : ''}actualizado ${checkedTime(mattermostOverview.checked_at)}`
        : 'Actualizando…',
    tone: 'sage',
    window: 'mattermost',
  };
  const mailInboxItem: InboxItem = {
    source: 'Correo',
    glyph: '@',
    title: mailError
      ? 'No se pudo actualizar'
      : mailNotificationCount > 0
        ? `${mailNotificationCount} ${mailNotificationCount === 1 ? 'correo sin leer' : 'correos sin leer'}`
        : 'Correo al día',
    meta: mailError
      ? 'Revisa Mail.app y el permiso de Automatización'
      : mailOverview
        ? `${configuredMailAccounts.length} ${configuredMailAccounts.length === 1 ? 'cuenta' : 'cuentas'} de Mail · actualizado ${checkedTime(mailOverview.checked_at)}`
        : 'Leyendo Mail…',
    tone: 'aubergine',
    window: 'mail',
  };
  const calendarInboxItem: InboxItem = {
    source: 'Calendario',
    glyph: 'C',
    title: calendarError
      ? 'Acceso pendiente'
      : calendarNotificationCount > 0
        ? `${calendarNotificationCount} ${calendarNotificationCount === 1 ? 'evento en las próximas 24 h' : 'eventos en las próximas 24 h'}`
        : calendarOverview
          ? `${upcomingCalendarEvents.length} eventos próximos`
          : 'Sincronizando calendarios…',
    meta: calendarError
      ? 'Autoriza Esprit en Privacidad → Automatización'
      : futureCalendarEvents[0]
        ? `${futureCalendarEvents[0].calendar} · ${new Date(futureCalendarEvents[0].start).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: displayTimeZone })}`
        : `${modules.calendar.read.join(' + ') || 'Calendar'} · Calendar local`,
    tone: 'olive',
    window: 'calendar',
  };
  const githubInboxItem: InboxItem = {
    source: 'GitHub',
    glyph: 'G',
    title: githubAuthenticationExpired
      ? 'Sesión caducada'
      : githubError && !githubOverview?.connected
        ? 'No se pudo actualizar'
        : !githubOverview?.connected
          ? 'Sesión pendiente'
          : githubCoverageIncomplete
            ? 'Lectura parcial'
            : githubNotificationCount > 0
              ? `${githubNotificationCount} ${githubNotificationCount === 1 ? 'notificación' : 'notificaciones'}`
              : 'Repositorios al día',
    meta: githubAuthenticationExpired
      ? 'Reautentica la sesión local de GitHub CLI'
      : githubError && !githubOverview?.connected
        ? 'Revisa GitHub CLI o la conexión'
        : !githubOverview?.connected
          ? 'Conecta o reautentica GitHub CLI'
          : githubCoverageIncomplete
            ? 'Cobertura incompleta · abre GitHub para revisar'
            : `${githubOverview.login ? `@${githubOverview.login} · ` : ''}actualizado ${checkedTime(githubOverview.checked_at)}`,
    tone: 'graphite',
    window: 'github',
  };
  const inboxItems: InboxItem[] = [
    ...(mattermostEnabled ? [mattermostInboxItem] : []),
    ...(mailEnabled ? [mailInboxItem] : []),
    ...(calendarEnabled ? [calendarInboxItem] : []),
    ...(githubEnabled ? [githubInboxItem] : []),
  ];
  const ritualSourceNames = [
    ...(mailEnabled ? ['el correo'] : []),
    ...(mattermostEnabled ? ['Mattermost'] : []),
    ...(calendarEnabled ? ['el calendario'] : []),
    ...(githubEnabled ? ['GitHub'] : []),
  ];
  const pinnedFutureDeadlines = now ? pinnedDeadlines.filter((event) => new Date(event.end).getTime() > now) : [];
  const pinnedIdentities = new Set(pinnedFutureDeadlines.map((event) => calendarEventIdentity(event, displayTimeZone)));
  // Keep three upcoming items on Home: pinned deadlines first, then Calendar.
  const supplementalCalendarEvents = futureCalendarEvents
    .filter((event) => !pinnedIdentities.has(calendarEventIdentity(event, displayTimeZone)))
    .slice(0, Math.max(1, 3 - pinnedFutureDeadlines.length));
  const displayedDeadlines = [...pinnedFutureDeadlines, ...supplementalCalendarEvents]
    .sort((left, right) => left.start.localeCompare(right.start))
    .map((event) => {
      const date = new Date(event.start);
      const formattedDate = new Intl.DateTimeFormat('es-ES', {
        day: '2-digit',
        month: 'short',
        timeZone: displayTimeZone,
      }).formatToParts(date);
      return {
        day: formattedDate.find((part) => part.type === 'day')?.value ?? '--',
        month: (formattedDate.find((part) => part.type === 'month')?.value ?? '---').replace('.', '').toUpperCase(),
        title: event.title,
        meta: 'meta' in event && typeof event.meta === 'string' ? event.meta : `${event.calendar}${event.all_day ? ' · todo el día' : ` · ${date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: displayTimeZone })}`}`,
      };
    });
  // Nombre, nombre corto y etiqueta vienen de la configuración; resumen,
  // siguiente paso, plazo, progreso y estado, del radar del estado global.
  const availableProjects = useMemo<HomeProject[]>(() => config.projects.map((known) => {
    const project = globalState?.projects.find((candidate) => candidate.slug === known.slug);
    const statusLabel = project?.status ? projectStatusLabel(project.status) : '';
    return project ? {
      slug: known.slug,
      name: known.name,
      shortName: known.short_name,
      eyebrow: (known.tag || statusLabel || 'Proyecto').toLocaleUpperCase('es'),
      status: statusLabel || undefined,
      summary: project.summary,
      next: project.next,
      deadline: project.deadline,
      progress: Math.max(0, Math.min(100, project.progress)),
      hasState: true,
    } : {
      slug: known.slug,
      name: known.name,
      shortName: known.short_name,
      eyebrow: (known.tag || 'Sin estado').toLocaleUpperCase('es'),
      summary: NO_STATE_YET,
      next: NO_STATE_YET,
      deadline: 'Sin plazo',
      progress: 0,
      hasState: false,
    };
  }), [config.projects, globalState]);
  const homeProjects = [
    ...recentProjectSlugs
      .map((slug) => availableProjects.find((project) => project.slug === slug))
      .filter((project): project is HomeProject => Boolean(project)),
    ...availableProjects.filter((project) => !recentProjectSlugs.includes(project.slug)),
  ].slice(0, 5);
  const activeFocus = globalState?.focus ?? {
    project: 'general',
    headline: 'Todavía no hay un foco registrado.',
    detail: 'Haz Login para empezar el día o Logout al terminarlo: Esprit anotará aquí en qué estás trabajando.',
    next: '',
    updated: 'estado pendiente',
  };
  const focusProject = availableProjects.find((project) => project.slug === activeFocus.project);
  const focusHasNativeContext = projectSlugs.includes(activeFocus.project);
  const headerDate = new Date(now);
  const todayKey = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: displayTimeZone,
    year: 'numeric',
  }).format(headerDate);
  const designPreviewLoginEntry = homeDesignPreview
    ? { ...previewLoginEntry, label: `login-${todayKey}`, created_at: headerDate.toISOString() }
    : null;
  const latestLoginCandidate = loginHistory[0] ?? designPreviewLoginEntry;
  const latestLoginKey = latestLoginCandidate
    ? new Intl.DateTimeFormat('en-CA', {
      day: '2-digit',
      month: '2-digit',
      timeZone: displayTimeZone,
      year: 'numeric',
    }).format(new Date(latestLoginCandidate.created_at))
    : null;
  const homeLoginEntry = latestLoginKey === todayKey ? latestLoginCandidate : null;
  const extractedLoginHighlights = homeLoginEntry ? extractLoginHighlights(homeLoginEntry.briefing) : [];
  const homeLoginHighlights = homeLoginEntry && extractedLoginHighlights.length === 0
    ? ['Abre el briefing completo para revisar las prioridades documentadas del día.']
    : extractedLoginHighlights;

  const loadMattermostChannel = useCallback(async (channelId: string, showLoading = false, force = false) => {
    const requestId = ++mattermostChannelRequestRef.current;
    if (showLoading) setMattermostChannelLoading(true);
    const reads = mattermostChannelReadsRef.current;
    reads.set(channelId, (reads.get(channelId) ?? 0) + 1);
    try {
      const data = await invoke<MattermostChannelData>('mattermost_channel', { channelId, force });
      if (data.history?.mode !== 'full') {
        mattermostChannelSnapshots.current.delete(channelId);
        mattermostChannelSnapshots.current.set(channelId, data);
        while (mattermostChannelSnapshots.current.size > 8) mattermostChannelSnapshots.current.delete(mattermostChannelSnapshots.current.keys().next().value as string);
      }
      if (mattermostChannelRequestRef.current === requestId && selectedMattermostChannelRef.current === channelId) {
        setMattermostChannelLoading(false);
        setMattermostChannelData((current) => {
          if (!current || !mattermostFullHistoryRef.current.has(channelId) || data.history?.mode !== 'recent') return data;
          const posts = new Map(current.posts.map((post) => [post.id, post]));
          data.posts.forEach((post) => posts.set(post.id, post));
          return { ...data, posts: [...posts.values()].sort((left, right) => left.create_at - right.create_at), history: current.history };
        });
        setMattermostError(null);
      }
      return data;
    } catch (error) {
      if (mattermostChannelRequestRef.current === requestId && selectedMattermostChannelRef.current === channelId) {
        setMattermostError(String(error));
      }
      throw error;
    } finally {
      const remaining = (reads.get(channelId) ?? 1) - 1;
      if (remaining > 0) reads.set(channelId, remaining); else reads.delete(channelId);
      if (showLoading && mattermostChannelRequestRef.current === requestId) setMattermostChannelLoading(false);
    }
  }, []);

  const loadMattermostHistory = useCallback(async (channelId: string) => {
    const requestId = ++mattermostChannelRequestRef.current;
    const data = await invoke<MattermostChannelData>('mattermost_channel_history', { channelId });
    if (mattermostChannelRequestRef.current === requestId && selectedMattermostChannelRef.current === channelId) {
      mattermostFullHistoryRef.current.add(channelId);
      setMattermostChannelData(data);
      setMattermostError(null);
    }
  }, []);

  const openMattermostChannel = useCallback(async (channel: MattermostChannel) => {
    mattermostChannelRequestRef.current += 1;
    mattermostFullHistoryRef.current.delete(channel.id);
    selectedMattermostChannelRef.current = channel.id;
    setSelectedMattermostChannel(channel.id);
    const snapshot = channel.restricted ? undefined : mattermostChannelSnapshots.current.get(channel.id);
    setMattermostChannelData(snapshot ?? null);
    setMattermostChannelLoading(false);
    setMattermostError(null);
    const acknowledged = { ...acknowledgedMattermost, [channel.id]: channel.last_post_at };
    setAcknowledgedMattermost(acknowledged);
    window.localStorage.setItem('esprit-mattermost-seen', JSON.stringify(acknowledged));

    if (channel.restricted) {
      setMattermostChannelData({
        channel: { id: channel.id, label: channel.label, type: channel.type, restricted: true },
        posts: [],
      });
      return;
    }

    try {
      await loadMattermostChannel(channel.id, !snapshot);
    } catch {
      if (!snapshot) setMattermostChannelData(null);
    }
  }, [acknowledgedMattermost, loadMattermostChannel]);

  const openMattermostLink = useCallback(async (url: string) => {
    await invoke('mattermost_open_link', { url });
  }, []);

  // Los informes de Login y Logout renderizan Markdown con enlaces; sin esto
  // quedaban inertes, igual que los de las notas.
  const openDocumentLink = useCallback((url: string) => {
    void invoke<string>('document_open_link', { url })
      .then((message) => setToast(message))
      .catch((reason) => setToast(String(reason)));
  }, []);

  const interceptMailLink = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest('a');
    const href = anchor?.getAttribute('href');
    if (!href) return;
    event.preventDefault();
    event.stopPropagation();
    void invoke<string>('mail_open_link', { url: href })
      .then((message) => setToast(message))
      .catch((reason) => setToast(String(reason)));
  };

  const readMattermostAttachment = useCallback(async (fileId: string) => (
    invoke<MattermostFilePreview>('mattermost_attachment', { fileId })
  ), []);

  const loadMattermostAvatars = useCallback((requests: Array<{ channelId: string; userId: string }>) => {
    const pending = requests.filter(({ userId }) => {
      if (mattermostAvatarRequestsRef.current.has(userId)) return false;
      mattermostAvatarRequestsRef.current.add(userId);
      return true;
    });
    // Each batch is a bridge process with its own login: queue them instead of
    // opening several sessions at once next to the channel read.
    for (let index = 0; index < pending.length; index += 24) {
      const batch = pending.slice(index, index + 24);
      mattermostAvatarQueueRef.current = mattermostAvatarQueueRef.current.then(() => invoke<MattermostAvatar[]>('mattermost_avatars', {
        request: { requests: batch.map(({ channelId, userId }) => ({ channel_id: channelId, user_id: userId })) },
      }).then((avatars) => {
        setMattermostAvatars((current) => ({ ...current, ...Object.fromEntries(avatars.map((avatar) => [avatar.user_id, avatar])) }));
      }).catch(() => {
        batch.forEach(({ userId }) => mattermostAvatarRequestsRef.current.delete(userId));
      }));
    }
  }, []);

  const sendMattermostMessage = useCallback(async (channelId: string, message: string, rootId?: string | null) => {
    await invoke('mattermost_send', {
      request: { channel_id: channelId, message, root_id: rootId ?? null, confirmed: true },
    });
    await loadMattermostChannel(channelId, false, true);
    void refreshMattermost(true);
  }, [loadMattermostChannel, refreshMattermost]);

  const editMattermostMessage = useCallback(async (postId: string, message: string, expectedUpdateAt: number) => {
    try {
      await invoke('mattermost_edit', {
        request: {
          post_id: postId,
          message,
          expected_update_at: expectedUpdateAt,
          confirmed: true,
        },
      });
      if (selectedMattermostChannel) await loadMattermostChannel(selectedMattermostChannel, false, true);
    } catch (error) {
      if (selectedMattermostChannel) void loadMattermostChannel(selectedMattermostChannel, false, true).catch(() => undefined);
      throw error;
    }
  }, [loadMattermostChannel, selectedMattermostChannel]);

  const clearMailSelection = () => {
    mailReadRequest.current.invalidate();
    setSelectedMailThread(null);
    setMailThread(null);
    setMailThreadLoading(false);
  };

  useEffect(() => {
    if (hydrated) window.localStorage.setItem('esprit-mail-layout', mailLayout);
  }, [hydrated, mailLayout]);

  const openMailThread = useCallback(async (email: MailMessage) => {
    const isCurrent = mailReadRequest.current.begin();
    const cacheKey = `${email.thread_id}::${email.id}`;
    const cached = mailThreadCache.current.get(cacheKey);
    setSelectedMailThread(email.thread_id);
    setMailComposerOpen(false);
    setMailSendConfirm(false);
    if (cached) {
      setMailThread(cached);
      setMailThreadLoading(false);
      return;
    }
    // Show the listed preview at once; the full conversation replaces it.
    setMailThread({ thread_id: email.thread_id, messages: [email] });
    setMailThreadLoading(true);
    try {
      const thread = await invoke<MailThread>('mail_thread', { threadId: email.thread_id });
      if (!isCurrent()) return;
      const complete = thread.messages.length ? thread : { thread_id: email.thread_id, messages: [email] };
      if (thread.messages.length) {
        mailThreadCache.current.set(cacheKey, complete);
        while (mailThreadCache.current.size > 40) mailThreadCache.current.delete(mailThreadCache.current.keys().next().value as string);
      }
      setMailThread(complete);
      setMailError(null);
    } catch (error) {
      if (!isCurrent()) return;
      setMailThread({ thread_id: email.thread_id, messages: [email] });
      setMailError(String(error));
    } finally {
      if (isCurrent()) setMailThreadLoading(false);
    }
  }, []);

  // Identidades de envío: solo las cuentas de Mail declaradas en la
  // configuración, en su orden. El lado nativo vuelve a validar la clave.
  const configuredMailKeys = new Set(configuredMailAccounts.map((account) => account.key));
  const defaultMailAccount = configuredMailAccounts[0]?.key ?? '';
  const mailAccountFor = (key: string | undefined) => (key && configuredMailKeys.has(key) ? key : defaultMailAccount);

  const startMail = () => {
    setMailComposeKind('new');
    setMailForwardHasAttachments(false);
    setMailLayout((current) => current === 'inbox' ? 'split' : current);
    const preferred = selectedMailAccount === 'all' ? defaultMailAccount : mailAccountFor(selectedMailAccount);
    setMailDraft({ from_account: preferred, to: '', subject: '', body: '', reply_message_id: null });
    setMailSendConfirm(false);
    setMailComposerOpen(true);
  };

  const startReply = () => {
    if (mailThreadLoading || mailThread?.thread_id !== selectedMailThread) return;
    setMailComposeKind('reply');
    setMailForwardHasAttachments(false);
    const selected = mailOverview?.emails.find((email) => email.thread_id === selectedMailThread);
    const fromAccount = mailAccountFor(selected?.mailbox);
    const account = (mailOverview?.accounts?.find((value) => value.key === fromAccount)?.address
      || configuredMailAccounts.find((value) => value.key === fromAccount)?.address
      || '').toLowerCase();
    const source = [...(mailThread?.messages ?? [])].reverse().find(
      (message) => !message.is_own && (!account || message.from_address.toLowerCase() !== account),
    )
      ?? mailOverview?.emails.find((email) => email.thread_id === selectedMailThread);
    if (!source) return;
    setMailDraft({
      from_account: mailAccountFor(source.mailbox),
      to: source.from_address || source.from,
      subject: /^re:/i.test(source.subject) ? source.subject : `Re: ${source.subject}`,
      body: '',
      reply_message_id: source.id,
    });
    setMailSendConfirm(false);
    setMailComposerOpen(true);
  };

  const startForward = () => {
    if (mailThreadLoading || mailThread?.thread_id !== selectedMailThread) return;
    const source = mailThread.messages.at(-1);
    if (!source) return;
    setMailComposeKind('forward');
    setMailForwardHasAttachments(source.has_attachment);
    setMailDraft({
      from_account: mailAccountFor(source.mailbox),
      to: '',
      subject: /^(fwd?|rv):/i.test(source.subject) ? source.subject : `Fwd: ${source.subject}`,
      body: `\n\n—— Mensaje reenviado ——\nDe: ${source.from}\nFecha: ${formatMailDate(source.date)}\nPara: ${source.to}\nAsunto: ${source.subject}\n\n${source.body || source.snippet}`,
      reply_message_id: null,
    });
    setMailSendConfirm(false);
    setMailComposerOpen(true);
  };

  const reviewMailSend = (event: FormEvent) => {
    event.preventDefault();
    if (!mailDraft.to.trim() || !mailDraft.subject.trim() || !mailDraft.body.trim()) {
      setToast('Completa destinatario, asunto y mensaje antes de revisar el envío.');
      return;
    }
    setMailSendConfirm(true);
  };

  const confirmMailSend = async () => {
    if (mailSending || !mailSendConfirm) return;
    setMailSending(true);
    try {
      await invoke('mail_send', { request: mailDraft });
      mailThreadCache.current.clear();
      const sender = configuredMailAccounts.find((accountValue) => accountValue.key === mailDraft.from_account)?.label || 'Mail';
      setToast(mailDraft.reply_message_id ? `Respuesta enviada desde ${sender}.` : `Correo enviado desde ${sender}.`);
      setMailComposerOpen(false);
      setMailSendConfirm(false);
      setMailDraft({ from_account: defaultMailAccount, to: '', subject: '', body: '', reply_message_id: null });
      void refreshMail();
    } catch (error) {
      setToast(`No se pudo enviar: ${String(error)}`);
      setMailSendConfirm(false);
    } finally {
      setMailSending(false);
    }
  };

  // Failures stay long enough to read and can be dismissed; confirmations fade.
  const toastIsError = Boolean(toast && /^(no se pudo|error|falló|fallo)|no está disponible|invalid|failed/i.test(toast));
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), toastIsError ? 8000 : 3000);
    return () => window.clearTimeout(timeout);
  }, [toast, toastIsError]);

  useEffect(() => {
    if (activeWindow !== 'mattermost' || selectedMattermostChannel || !mattermostOverview?.channels.length) return;
    const firstChannel = [...mattermostOverview.channels]
      .filter((channel) => !channel.restricted)
      .sort((left, right) => right.last_post_at - left.last_post_at)[0];
    const timer = window.setTimeout(() => { if (firstChannel) void openMattermostChannel(firstChannel); }, 0);
    return () => window.clearTimeout(timer);
  }, [activeWindow, mattermostOverview, openMattermostChannel, selectedMattermostChannel]);

  useEffect(() => {
    if (activeWindow !== 'mail' || mailLayout === 'inbox' || selectedMailThread || !mailOverview?.emails.length) return;
    const firstEmail = mailOverview.emails.find(
      (email) => (email.folder ?? 'inbox') === selectedMailFolder && (selectedMailAccount === 'all' || email.mailbox === selectedMailAccount),
    );
    const timer = window.setTimeout(() => { if (firstEmail) void openMailThread(firstEmail); }, 0);
    return () => window.clearTimeout(timer);
  }, [activeWindow, mailOverview, mailLayout, openMailThread, selectedMailThread, selectedMailAccount, selectedMailFolder]);

  useEffect(() => {
    if (activeWindow !== 'mattermost' || !selectedMattermostChannel) return;
    const selected = mattermostOverview?.channels.find((channel) => channel.id === selectedMattermostChannel);
    if (!selected || selected.restricted) return;
    // Return the read so the poller's in-flight guard and back-off apply, and
    // never cancel a foreground load that is still running.
    return startVisiblePolling(() => {
      if (mattermostChannelReadsRef.current.has(selectedMattermostChannel)) return undefined;
      return loadMattermostChannel(selectedMattermostChannel).then(() => undefined, (error) => ({ error: String(error) }));
    }, 20_000, { runImmediately: false });
  }, [activeWindow, loadMattermostChannel, mattermostOverview, selectedMattermostChannel]);

  const runAction = async (action: Action, project?: string) => {
    if (!('__TAURI_INTERNALS__' in window)) {
      setToast('Esta acción está disponible al abrir la app Esprit.');
      return;
    }

    try {
      const message = await invoke<string>('open_target', { action, project: project ?? null });
      if (action === 'project' && project) rememberProject(project);
      setToast(message);
    } catch (error) {
      setToast(`No se pudo completar la acción: ${String(error)}`);
    }
  };

  // Enlaces de la barra lateral: solo se envía su posición en la
  // configuración; el lado nativo resuelve la URL o la app.
  const openConfiguredLink = async (index: number) => {
    if (!('__TAURI_INTERNALS__' in window)) {
      setToast('Esta acción está disponible al abrir la app Esprit.');
      return;
    }
    try {
      setToast(await invoke<string>('open_link', { index }));
    } catch (error) {
      setToast(`No se pudo abrir el enlace: ${String(error)}`);
    }
  };

  const reloadConfiguration = async () => {
    const next = await reloadConfig();
    if (next.status === 'ok') setToast('Configuración recargada.');
    else setToast(`No se pudo recargar la configuración: ${next.error}`);
  };

  const connectGitHub = async () => {
    if (!('__TAURI_INTERNALS__' in window)) {
      setToast('La conexión con GitHub funciona dentro de la app Esprit.');
      return;
    }
    setGitHubLoading(true);
    try {
      const message = await invoke<string>('github_connect');
      setToast(message || 'Completa la conexión con GitHub y actualiza la vista.');
      await refreshGitHub();
    } catch (error) {
      setToast(`No se pudo iniciar la conexión: ${String(error)}`);
    } finally {
      setGitHubLoading(false);
    }
  };

  const openGitHubTarget = async (repository: string | null, targetKind: string, targetId?: string | null) => {
    if (!('__TAURI_INTERNALS__' in window)) {
      setToast('La apertura segura de GitHub funciona dentro de la app Esprit.');
      return;
    }
    try {
      const supportedKind = ['repo', 'repository', 'commit', 'pull', 'pull_request', 'issue'].includes(targetKind)
        ? targetKind
        : 'repository';
      const message = await invoke<string>('github_open_target', {
        request: {
          repository,
          target_kind: supportedKind,
          target_id: supportedKind === 'repository' || supportedKind === 'repo' ? null : targetId ?? null,
        },
      });
      setToast(message);
    } catch (error) {
      setToast(`No se pudo abrir GitHub: ${String(error)}`);
    }
  };

  const dailySourceSnapshot = (overrides: DailySourceOverrides = {}) => {
    const activeGlobalState = overrides.globalState?.overview ?? globalState;
    const activeGlobalStateError = overrides.globalState ? overrides.globalState.error : globalStateError;
    const activeMattermost = overrides.mattermost?.overview ?? mattermostOverview;
    const activeMattermostError = overrides.mattermost ? overrides.mattermost.error : mattermostError;
    const activeMail = overrides.mail?.overview ?? mailOverview;
    const activeMailError = overrides.mail ? overrides.mail.error : mailError;
    const activeCalendar = overrides.calendar?.overview ?? calendarOverview;
    const activeCalendarError = overrides.calendar ? overrides.calendar.error : calendarError;
    const activeGitHub = overrides.github?.overview ?? githubOverview;
    const activeGitHubError = overrides.github ? overrides.github.error : githubError;
    const mattermostChannels = activeMattermost?.channels ?? [];
    // Entrantes y enviados con presupuesto propio. Un corte plano sobre la
    // lista mezclada dejaba fuera lo enviado en cuanto el día traía bastante
    // correo entrante, y es justo el lado que dice qué hizo el usuario.
    const allMail = activeMail?.emails ?? [];
    const inboxMessages = allMail.filter((email) => (email.folder ?? 'inbox') === 'inbox').slice(0, MAIL_INBOX_BUDGET);
    const sentMessages = allMail.filter((email) => email.folder === 'sent').slice(0, MAIL_SENT_BUDGET);
    const mailMessages = [...inboxMessages, ...sentMessages];
    const calendarEvents = activeCalendar?.events.slice(0, 80) ?? [];
    const githubRepositories = activeGitHub?.repositories ?? [];
    const githubActivity = activeGitHub?.activity.slice(0, 60) ?? [];
    const githubNotifications = activeGitHub?.notifications.slice(0, 50) ?? [];
    const snapshotMattermostNotificationCount = mattermostChannels.reduce(
      (total, channel) => total + effectiveMattermostBadge(channel),
      0,
    );

    return {
      generated_at: new Date().toISOString(),
      timezone: displayTimeZone,
      global_state: activeGlobalState
        ? {
          status: activeGlobalStateError ? 'stale' : 'available',
          error: activeGlobalStateError,
          updated_at: activeGlobalState.updated_at,
          last_logout: activeGlobalState.last_logout,
        }
        : { status: 'unavailable', error: activeGlobalStateError },
      mattermost: !mattermostEnabled ? NOT_CONFIGURED : activeMattermost
        ? {
          status: activeMattermostError ? 'stale' : 'available',
          error: activeMattermostError,
          checked_at: activeMattermost.checked_at,
          notification_count: snapshotMattermostNotificationCount,
          returned_count: mattermostChannels.length,
          total_available: mattermostChannels.length,
          truncated: false,
          content_scope: 'solo metadatos de canal; el contenido de los mensajes llega en mattermost_full_sweep',
          oldest_included_at: oldestIncludedAt(mattermostChannels.map((channel) => channel.last_post_at)),
          channels: mattermostChannels.map((channel) => ({
            label: channel.label,
            type: channel.type,
            badge: effectiveMattermostBadge(channel),
            last_post_at: channel.last_post_at,
            restricted: channel.restricted,
          })),
        }
        : { status: 'unavailable', error: activeMattermostError },
      mail: !mailEnabled ? NOT_CONFIGURED : activeMail
        ? {
          status: activeMailError || activeMail.warnings?.length ? 'stale' : 'available',
          error: activeMailError || activeMail.warnings?.join(' · ') || null,
          checked_at: activeMail.checked_at,
          unread_count: activeMail.unread_count,
          accounts: activeMail.accounts?.map((account) => ({
            address: account.address,
            label: account.label,
            connected: account.connected,
            unread_count: account.unread_count,
            error: account.error || null,
          })),
          returned_count: mailMessages.length,
          returned_inbox_count: inboxMessages.length,
          returned_sent_count: sentMessages.length,
          sent_source: activeMail.sent_source,
          sent_source_count: activeMail.sent_source_count,
          sent_coverage: activeMail.sent_accounts ?? [],
          sent_truncated: Boolean(activeMail.sent_truncated),
          source_returned_count: activeMail.emails.length,
          total_available: activeMail.next_page_token ? null : activeMail.emails.length,
          truncated: Boolean(activeMail.next_page_token) || Boolean(activeMail.sent_truncated) || activeMail.emails.length > mailMessages.length,
          oldest_included_at: oldestIncludedAt(mailMessages.map((email) => email.date)),
          messages: mailMessages.map((email) => ({
            // `folder` y `to` son lo que permite leer un enviado como tal:
            // sin ellos el remitente es siempre el usuario y no se ve a quién.
            folder: email.folder ?? 'inbox',
            from: email.from_name,
            to: email.to,
            mailbox: email.mailbox_label,
            subject: email.subject,
            snippet: email.snippet.slice(0, 600),
            unread: email.unread,
            date: email.date,
          })),
        }
        : { status: 'unavailable', error: activeMailError },
      calendar: !calendarEnabled ? NOT_CONFIGURED : activeCalendar
        ? {
          status: activeCalendarError ? 'stale' : 'available',
          error: activeCalendarError,
          checked_at: activeCalendar.checked_at,
          selected_calendars: activeCalendar.selected_calendars,
          writable_calendars: activeCalendarError ? [] : activeCalendar.writable_calendars,
          returned_count: calendarEvents.length,
          source_returned_count: activeCalendar.events.length,
          total_available: activeCalendar.total_events,
          truncated: activeCalendar.truncated || activeCalendar.events.length > calendarEvents.length,
          oldest_included_at: oldestIncludedAt(calendarEvents.map((event) => event.start)),
          events: calendarEvents.map((event) => ({
            calendar: event.calendar,
            title: event.title,
            start: event.start,
            end: event.end,
            all_day: event.all_day,
          })),
        }
        : { status: 'unavailable', error: activeCalendarError },
      github: !githubEnabled ? NOT_CONFIGURED : activeGitHub?.connected
        ? {
          status: activeGitHubError || activeGitHub.status === 'partial' ? 'stale' : 'available',
          error: activeGitHubError ?? activeGitHub.error ?? null,
          checked_at: activeGitHub.checked_at,
          login: activeGitHub.login,
          notification_count: activeGitHub.notification_count,
          returned_repositories: githubRepositories.length,
          returned_activity: githubActivity.length,
          source_returned_activity: activeGitHub.activity.length,
          returned_notifications: githubNotifications.length,
          source_returned_notifications: activeGitHub.notifications.length,
          truncated: Boolean(
            activeGitHub.coverage?.activity_truncated
            || activeGitHub.coverage?.notifications_truncated
            || activeGitHub.activity.length > githubActivity.length
            || activeGitHub.notifications.length > githubNotifications.length
          ),
          warnings: activeGitHub.warnings ?? [],
          repositories: githubRepositories.map((repository) => ({
            full_name: repository.full_name,
            project_slug: repository.project_slug,
            label: repository.label,
            default_branch: repository.default_branch,
            pushed_at: repository.pushed_at,
            archived: repository.archived,
            local_branch: repository.local_branch,
            local_head: repository.local_head,
            tracked_changes: repository.tracked_changes ?? 0,
            untracked_changes: repository.untracked_changes ?? 0,
          })),
          activity: githubActivity.map((item) => ({
            repository: item.repo,
            project_slug: item.project_slug,
            kind: item.kind,
            title: item.title,
            actor: item.actor,
            created_at: item.created_at,
          })),
          notifications: githubNotifications.map((item) => ({
            repository: item.repo,
            project_slug: item.project_slug,
            reason: item.reason,
            subject_type: item.subject_type,
            title: item.title,
            updated_at: item.updated_at,
            unread: item.unread,
          })),
        }
        : {
          status: 'unavailable',
          error: activeGitHubError ?? activeGitHub?.error ?? (activeGitHub?.status === 'auth_required' ? 'GitHub requiere autenticación.' : null),
        },
    };
  };

  const executeDailyRitual = async (
    action: 'login' | 'logout_discovery' | 'logout_preview',
    notes = dailyNotes,
  ) => {
    if (dailyBusy) return;
    if (action === 'login' && logoutDiscoveryId && logoutPhase !== 'complete') {
      setToast('Hay un Logout abierto. Sus respuestas se conservan; complétalo antes de iniciar otro ritual.');
      return;
    }
    if (!('__TAURI_INTERNALS__' in window)) {
      setToast('El ritual diario funciona dentro de la app Esprit.');
      return;
    }
    setRunningRitualProfile({ model: ritualModel, effort: ritualEffort });
    setDailySessionKind(action === 'login' ? 'login' : 'logout');
    setDailyHistoryReview(null);
    setDailyBusy(true);
    setDailyError(null);
    if (action !== 'logout_preview') setDailyWarnings([]);
    if (action === 'login') {
      setLoginResult('');
      setSelectedLoginId(null);
    }
    if (action === 'logout_discovery') {
      setLogoutPhase('discovering');
      setLogoutDiscovery('');
      setLogoutDiscoveryId(null);
      setLogoutQuestions([]);
      setLogoutAnswers([]);
      setLogoutExtra('');
      setDailyNotes('');
      setDailyPreview('');
      setDailyPlanId(null);
      setDailyApplied(false);
    }
    if (action === 'logout_preview') {
      setLogoutPhase('previewing');
      setDailyPlanId(null);
    }
    try {
      let sources: Record<string, unknown> = {};
      if (action !== 'logout_preview') {
        const [freshGlobalState, freshMattermost, freshMail, freshCalendar, freshGitHub] = await Promise.all([
          refreshGlobalState(),
          refreshMattermost(),
          refreshMail(),
          refreshCalendar(true),
          refreshGitHub(),
        ]);
        sources = dailySourceSnapshot({
          globalState: freshGlobalState,
          mattermost: freshMattermost,
          mail: freshMail,
          calendar: freshCalendar,
          github: freshGitHub,
        });
      }
      if (action !== 'logout_preview' && modules.notes.enabled) {
        const notes = await quick.refresh();
        sources = {...sources, quick_notes: quickNotesSnapshot(notes, quick.error)};
        if (action === 'logout_discovery') logoutNoteVersions.current = pendingQuickNoteVersions(notes);
      }
      if (action === 'logout_preview' && !logoutDiscoveryId) {
        throw new Error('Falta la revisión documentada. Vuelve a iniciar Logout.');
      }
      const reply = await invoke<DailyRitualReply>('phd_daily_ritual', {
        request: {
          action,
          user_notes: notes,
          sources,
          discovery_id: action === 'logout_preview' ? logoutDiscoveryId : null,
          model: ritualModel,
          effort: ritualEffort,
        },
      });
      setDailyWarnings(reply.source_warnings ?? []);
      if (action === 'logout_discovery') {
        const discoveryId = reply.discovery_id ?? null;
        if (!discoveryId) throw new Error('El asistente no devolvió una sesión de revisión válida.');
        const questions = reply.questions ?? [];
        setLogoutDiscovery(reply.answer);
        setLogoutQuestions(questions);
        setLogoutAnswers(questions.map(() => ''));
        setLogoutExtra('');
        setLogoutDiscoveryId(discoveryId);
        setLogoutPhase('interview');
      } else if (action === 'logout_preview') {
        const planId = reply.plan_id ?? null;
        if (!planId) throw new Error('El asistente no devolvió un plan confirmable.');
        setDailyPreview(reply.answer);
        setDailyPlanId(planId);
        setDailyApplied(false);
        setLogoutPhase('review');
      } else {
        setLoginResult(reply.answer);
        if (reply.paper_radar?.status === 'recommendations') {
          setToast(`Radar de lectura: ${reply.paper_radar.new_count} paper${reply.paper_radar.new_count === 1 ? '' : 's'} nuevo${reply.paper_radar.new_count === 1 ? '' : 's'}.`);
        } else if (reply.paper_radar?.status === 'nothing_relevant') {
          setToast('Radar de lectura: nada suficientemente relevante en esta tanda.');
        }
        const historyEntry = reply.history_entry;
        if (historyEntry) {
          setLoginHistory((current) => [
            historyEntry,
            ...current.filter((entry) => entry.id !== historyEntry.id),
          ].slice(0, 30));
          setSelectedLoginId(historyEntry.id);
          setLoginHistoryError(null);
        } else {
          void refreshLoginHistory();
        }
      }
    } catch (error) {
      setDailyError(String(error));
      if (action === 'logout_preview') setLogoutPhase('interview');
    } finally {
      setDailyBusy(false);
      setRunningRitualProfile(null);
    }
  };

  const applyDailyLogout = async () => {
    if (dailyBusy || !dailyPlanId) return;
    if (!('__TAURI_INTERNALS__' in window)) {
      setToast('El ritual diario funciona dentro de la app Esprit.');
      return;
    }
    setDailyBusy(true);
    setLogoutPhase('applying');
    setDailyError(null);
    setDailyResult('');
    try {
      const reply = await invoke<DailyRitualReply>('apply_daily_logout', { planId: dailyPlanId });
      setDailyResult(reply.answer);
      setDailyWarnings(reply.source_warnings ?? []);
      setDailyApplied(true);
      if (modules.notes.enabled) await quick.markLogged(logoutNoteVersions.current);
      setDailyPlanId(null);
      setLogoutPhase('complete');
      if (reply.logout_history_entry) {
        setLogoutHistory((current) => [reply.logout_history_entry!, ...current.filter((entry) => entry.id !== reply.logout_history_entry!.id)].slice(0, 30));
        setLogoutHistoryError(null);
      } else {
        void refreshLogoutHistory();
      }
      void refreshGlobalState();
      void refreshCalendar(true);
    } catch (error) {
      setDailyError(String(error));
      setLogoutPhase('review');
    } finally {
      setDailyBusy(false);
    }
  };

  const openDailyRitual = (mode: DailyMode) => {
    if (!requestWindowTransition('daily')) return;
    setChatOpen(false);
    setDailyMode(mode);
    setDailyHistoryTab(mode);
    setDailyHistoryReview(null);
    setLoginDeleteCandidate(null);
    void (mode === 'login' ? refreshLoginHistory() : refreshLogoutHistory());
  };

  const reviewLoginHistory = (entry: LoginHistoryEntry) => {
    if (!requestWindowTransition('daily')) return;
    if (document.activeElement instanceof HTMLElement) lastWindowTriggerRef.current = document.activeElement;
    setChatOpen(false);
    setMailComposerOpen(false);
    setMailSendConfirm(false);
    setDailyHistoryReview({ kind: 'login', id: entry.id, label: entry.label, created_at: entry.created_at, content: entry.briefing });
    setDailyHistoryTab('login');
    setSelectedLoginId(entry.id);
    setLoginDeleteCandidate(null);
  };

  const reviewLogoutHistory = (entry: LogoutHistoryEntry) => {
    if (!requestWindowTransition('daily')) return;
    if (document.activeElement instanceof HTMLElement) lastWindowTriggerRef.current = document.activeElement;
    setChatOpen(false);
    setMailComposerOpen(false);
    setMailSendConfirm(false);
    setDailyHistoryReview({ kind: 'logout', id: entry.id, label: entry.label, created_at: entry.created_at, content: entry.summary });
    setDailyHistoryTab('logout');
  };

  const deleteLoginHistory = async (entry: LoginHistoryEntry) => {
    if (dailyBusy || loginDeleting) return;
    setLoginDeleting(entry.id);
    setLoginHistoryError(null);
    try {
      const overview = await invoke<LoginHistoryOverview>('login_history_delete', {
        request: { login_id: entry.id, confirmed: true },
      });
      setLoginHistory(overview.entries);
      setLoginDeleteCandidate(null);
      if (selectedLoginId === entry.id) setSelectedLoginId(null);
      if (dailyHistoryReview?.kind === 'login' && dailyHistoryReview.id === entry.id) setDailyHistoryReview(null);
      setToast(`${entry.label} eliminado del historial.`);
    } catch (error) {
      const message = String(error);
      setLoginHistoryError(message);
      setToast(`No se pudo borrar el Login: ${message}`);
    } finally {
      setLoginDeleting(null);
    }
  };

  const searchEntries = useMemo<SearchEntry[]>(() => globalSearchOpen ? [
    ...navigation.map((item,index) => ({ key: `space-${index}`, kind: 'Espacio', title: item.label, detail: 'Abrir espacio', target: item.window ?? 'home' })),
    ...availableProjects.map(project => ({ key: `project-${project.slug}`, kind: 'Proyecto', title: project.name, detail: project.next, text: project.summary, target: project.slug })),
    ...research.notes.map(note => ({ key: `note-${note.id}`, kind: note.kind === 'meeting' ? 'Reunión' : note.kind === 'reading' ? 'Lectura' : 'En espera', title: note.title, detail: `${note.date} · ${contextLabels[note.project] ?? note.project}`, text: Object.values(note.fields).join(' '), target: note.id })),
    ...Object.entries(research.drafts).map(([key,note]) => ({ key: `draft-${key}`, kind: 'Borrador', title: note.title || 'Nota sin título', detail: `${note.date} · ${contextLabels[note.project] ?? 'Proyecto por elegir'}`, text: Object.values(note.fields).join(' '), target: key })),
    ...chat.history.conversations.map(conversation => ({ key: `chat-${conversation.id}`, kind: 'Chat', title: conversation.title, detail: `${contextLabels[conversation.context] ?? conversation.context}${conversation.archived ? ' · Archivado' : ''}`, text: conversation.messages.map(message => message.text).join(' '), target: conversation.id })),
  ] : [], [globalSearchOpen, navigation, availableProjects, contextLabels, research.notes, research.drafts, chat.history.conversations]);
  const chooseSearchResult = (entry: SearchEntry) => {
    setChatOpen(false);
    if (entry.kind === 'Espacio') requestWindowTransition(entry.target === 'home' ? null : entry.target as WindowName);
    else if (entry.kind === 'Proyecto') { selectProjectExplorer(entry.target); requestWindowTransition('projects'); }
    else if (entry.kind === 'Chat') { chat.select(entry.target); setActiveWindow(null); setChatOpen(true); }
    else if (entry.kind === 'Borrador') { const note = research.drafts[entry.target]; if (note) openResearchNote(note,entry.target); }
    else { const note = research.notes.find(note => note.id === entry.target); if (note) openResearchNote(note); }
  };

  const toggleWindow = (windowName?: WindowName) => {
    if (!windowName) {
      closeUtilityWindow();
      return;
    }
    if (activeWindow === windowName) {
      closeUtilityWindow();
      return;
    }
    if (document.activeElement instanceof HTMLElement) lastWindowTriggerRef.current = document.activeElement;
    setChatOpen(false);
    setMailComposerOpen(false);
    setMailSendConfirm(false);
    requestWindowTransition(windowName);
  };

  // Va después de `toggleWindow` a propósito: el array de dependencias se
  // evalúa durante el render, así que referenciarlo antes de su declaración
  // lanzaría un ReferenceError.
  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const chord = event.metaKey || event.ctrlKey;
      if (chord && event.shiftKey && event.key.toLowerCase() === 'n' && modules.notes.enabled) { event.preventDefault(); openQuickNote(); return; }
      if (chord && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!noteDraftId) setGlobalSearchOpen(value => !value); return; }
      if (globalSearchOpen || noteDraftId) return;
      if (chord && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        setQuickOpen(value => !value);
        return;
      }
      if (chord && event.key === ',') {
        event.preventDefault();
        toggleWindow('settings');
        return;
      }
      // Ctrl/⌘1…Ctrl/⌘9 y Ctrl/⌘0 siguen el orden visible de la barra lateral.
      if (chord && !event.shiftKey && !event.altKey && /^[0-9]$/.test(event.key)) {
        const index = event.key === '0' ? 9 : Number(event.key) - 1;
        const target = navigation[index];
        if (!target) return;
        event.preventDefault();
        toggleWindow(target.window);
        return;
      }
      if (event.key === 'Escape') {
        if (quickOpen) { setQuickOpen(false); return; }
        if (projectExitReview) cancelProjectExit();
        else if (mailSendConfirm) setMailSendConfirm(false);
        else if (mailComposerOpen) setMailComposerOpen(false);
        else if (chatOpen) setChatOpen(false);
        else if (!dismissFrontOverlay()) closeUtilityWindow();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
    // `toggleWindow` se recrea en cada render; el resto de dependencias basta
    // para mantener el handler al día sin volver a suscribirse cada vez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modules.notes.enabled, quickOpen, globalSearchOpen, noteDraftId, cancelProjectExit, chatOpen, closeUtilityWindow, mailComposerOpen, mailSendConfirm, projectExitReview, activeWindow, navigation]);

  const focusCodex = (context: string, seed = '') => {
    selectCodexContext(context);
    setPrompt(seed);
    setQuickOpen(true);
  };

  const sendCodexMessage = async (cleanPrompt: string, context: string, engine: ChatEngine, model: AgentModel, effort: CodexEffort) => {
    setChatOpen(true);
    await chat.send(cleanPrompt, { context, engine, model, effort });
    window.requestAnimationFrame(() => chatInputRef.current?.focus());
  };

  const askCodex = async (event?: FormEvent) => {
    event?.preventDefault();
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || isAsking) return;

    if (!('__TAURI_INTERNALS__' in window)) {
      setToast(`La conversación con ${engineLabel(chatEngine)} funciona dentro de la app Esprit.`);
      return;
    }

    const context = selectedContext;
    const engine = chatEngine;
    const model = activeChatModel;
    const effort = codexEffort;
    if (!requestWindowTransition(null)) return;
    setQuickOpen(false);
    await sendCodexMessage(cleanPrompt, context, engine, model, effort);
  };

  const handleChatKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void askCodex();
    }
  };

  const handleCompactKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter envía; ⇧Enter deja escribir varias líneas sin salir del composer.
    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void askCodex();
  };

  const mailEmails = (mailOverview?.emails ?? []).filter(
    (email) => (email.folder ?? 'inbox') === selectedMailFolder && (selectedMailAccount === 'all' || email.mailbox === selectedMailAccount),
  );
  const selectedEmail = mailEmails.find((email) => email.thread_id === selectedMailThread);
  // Pestañas y remitentes: las cuentas configuradas, con el estado de conexión
  // que devuelve el puente cuando ya ha leído Mail.
  const mailAccounts: MailAccount[] = configuredMailAccounts.map((account) => {
    const live = mailOverview?.accounts?.find((value) => value.key === account.key);
    return { key: account.key, label: account.label, address: account.address, connected: live?.connected ?? true, unread_count: live?.unread_count ?? 0, error: live?.error ?? '' };
  });
  const mailAccountLabel = (key: string) => mailAccounts.find((account) => account.key === key)?.label ?? key;
  const selectedSenderAccount = mailAccounts.find((account) => account.key === mailDraft.from_account);

  const renderUtilityWindow = () => {
    return (
      <section
        className={`utility-window${activeWindow === 'mattermost' ? ' mattermost-window' : activeWindow === 'mail' ? ' mail-window' : activeWindow === 'github' ? ' github-window' : activeWindow === 'cluster' ? ' cluster-window' : activeWindow === 'projects' ? ' project-window' : activeWindow === 'calendar' ? ' calendar-window' : activeWindow === 'trips' ? ' travel-window' : activeWindow === 'daily' ? ' daily-window' : ''}`}
        hidden={!activeWindow}
        ref={utilityWindowRef}
        role="dialog"
        aria-label={activeWindow ? windowTitles[activeWindow] : undefined}
        tabIndex={-1}
      >
        {activeWindow && !['projects','github','trips','notes'].includes(activeWindow) ? <header>
          <div><span>ESPRIT / ESPACIO</span><h2 id={`utility-window-title-${activeWindow}`}>{windowTitles[activeWindow]}</h2></div>
          <button onClick={closeUtilityWindow} type="button" aria-label="Cerrar ventana">×</button>
        </header> : null}

        {activeWindow === 'notes' && modules.notes.enabled ? <NotesSpace quick={quick} projects={config.projects.map(p=>({slug:p.slug,label:p.name}))} onNew={openQuickNote} onEdit={n=>setQuickDraft({id:n.id,category:n.category,title:n.title,body:n.body,meeting:n.meeting})} onOpenMeeting={()=>modules.meetings.enabled ? toggleWindow('meetings') : setToast('Activa Reuniones en la configuración para abrir esta referencia.')} onClose={closeUtilityWindow} /> : null}
        {modules.journal.enabled && (activeWindow === 'journal' || keptSpaces.journal) ? <div className="workspace-kept" hidden={activeWindow !== 'journal'}><JournalClubSpace userName={config.user.name} active={activeWindow === 'journal'} projects={config.projects.map(p=>({slug:p.slug,label:p.name}))} libraryEnabled={libraryEnabled} notesEnabled={modules.notes.enabled} onConclusions={(title,body)=>setQuickDraft({category:'general',title,body,meeting:null})} onOpenLink={url=>void invoke('document_open_link',{url}).catch(e=>setToast(String(e)))} onStatus={setJournalStatus} /></div> : null}
        {activeWindow === 'mattermost' ? (
          <MattermostSpace projects={config.projects.map(p=>({slug:p.slug,name:p.name}))} onOpenProjectFile={(project,relativePath)=>{selectProjectExplorer(project);setProjectOpenRequest({project,relativePath,nonce:Date.now()});toggleWindow('projects');}}
            overview={mattermostOverview}
            error={mattermostError}
            loading={mattermostLoading}
            selectedChannelId={selectedMattermostChannel}
            channelData={mattermostChannelData}
            channelLoading={mattermostChannelLoading}
            avatars={mattermostAvatars}
            channelBadge={effectiveMattermostBadge}
            onRefresh={() => void refreshMattermost(true)}
            onSelectChannel={(channel) => void openMattermostChannel(channel)}
            onLoadHistory={loadMattermostHistory}
            onOpenLink={openMattermostLink}
            onReadFile={readMattermostAttachment}
            onLoadAvatars={loadMattermostAvatars}
            onCreatePost={sendMattermostMessage}
            onUpdatePost={editMattermostMessage}
          />
        ) : null}

        {activeWindow === 'mail' ? (
          <div className={`mail-space mail-layout-${mailLayout}`} style={{ '--mail-rail-track': mailSplit.track(230) } as CSSProperties}>
            <div className="mail-layout-toolbar" role="group" aria-label="Distribución de correo">
              <button type="button" aria-pressed={mailLayout === 'inbox'} onClick={() => { setMailLayout('inbox'); setMailComposerOpen(false); setMailSendConfirm(false); }}>◧ Solo bandeja</button>
              <button type="button" aria-pressed={mailLayout === 'split'} onClick={() => { mailSplit.expand(); setMailLayout('split'); }}>◫ Dividido</button>
              <button type="button" aria-pressed={mailLayout === 'message'} onClick={() => setMailLayout('message')}>◨ Solo mensaje</button>
            </div>
            <aside className="mail-rail" hidden={mailLayout === 'message'}>
              <div className="mail-account">
                <div><strong>Correo</strong><span>{mailAccounts.length} {mailAccounts.length === 1 ? 'cuenta' : 'cuentas'} de Mail</span></div>
                <button onClick={() => void refreshMail()} disabled={mailLoading} type="button" aria-label="Actualizar correo">{mailLoading ? '…' : '↻'}</button>
              </div>
              <button className="mail-compose-trigger" onClick={startMail} type="button"><span>＋</span> Redactar</button>
              <div className="mail-folder-tabs" role="tablist" aria-label="Carpeta de correo"><button className={selectedMailFolder === 'inbox' ? 'active' : ''} onClick={() => { setSelectedMailFolder('inbox'); clearMailSelection(); }} type="button">Recibidos</button><button className={selectedMailFolder === 'sent' ? 'active' : ''} onClick={() => { setSelectedMailFolder('sent'); clearMailSelection(); }} type="button">Enviados</button></div>
              <div className="mail-account-tabs" role="tablist" aria-label="Filtrar por buzón">
                <button className={selectedMailAccount === 'all' ? 'active' : ''} onClick={() => { setSelectedMailAccount('all'); clearMailSelection(); }} type="button" role="tab" aria-selected={selectedMailAccount === 'all'}><span>Todos</span>{mailNotificationCount > 0 ? <b>{mailNotificationCount}</b> : null}</button>
                {mailAccounts.map((account) => (
                  <button className={selectedMailAccount === account.key ? 'active' : ''} key={account.key} onClick={() => { setSelectedMailAccount(account.key); clearMailSelection(); }} type="button" role="tab" aria-selected={selectedMailAccount === account.key} title={account.error || account.address}>
                    <i className={account.connected ? '' : 'error'} />
                    <span>{account.label}</span>
                    {account.unread_count > 0 ? <b>{account.unread_count}</b> : null}
                  </button>
                ))}
              </div>
              <div className="mail-list">
                {mailLoading && !mailOverview ? <div className="desk-skeleton" role="status" aria-label="Leyendo Mail"><i /><i /><i /><i /><i /><i /><i /><i /></div> : null}
                {mailError && !mailOverview ? <div className="mail-list-state error">{mailError}</div> : null}
                {!mailLoading && !mailError && mailEmails.length === 0 ? <div className="mail-list-state">No hay mensajes en este buzón.</div> : null}
                {mailEmails.map((email) => (
                  <button
                    className={`${selectedMailThread === email.thread_id ? 'active ' : ''}${email.unread ? 'unread' : ''}`.trim()}
                    key={email.id}
                    onClick={() => { if (mailLayout === 'inbox') setMailLayout('message'); void openMailThread(email); }}
                    type="button"
                    aria-current={selectedMailThread === email.thread_id ? 'true' : undefined}
                  >
                    <div><strong>{email.from_name}</strong><time>{formatMailDate(email.date, true)}</time></div>
                    <h3>{email.subject}</h3>
                    <small className={`mailbox-tag ${email.mailbox}`}>{email.mailbox_label}</small>
                    <p>{email.snippet || 'Sin vista previa'}</p>
                    {email.unread ? <i aria-label="Sin leer" /> : null}
                  </button>
                ))}
              </div>
              {selectedMailFolder === 'sent' && mailOverview?.sent_accounts ? <p className="mail-source-coverage">{mailOverview.sent_source ?? 'Enviados en Mail'}{mailOverview.sent_source_count !== undefined ? ` (${mailOverview.sent_source_count} en carpeta)` : ''}: {mailOverview.sent_accounts.map((account) => `${mailAccountLabel(account.key)} · ${account.connected ? `${account.returned_count ?? 0} consultados` : 'no disponible'}`).join(' · ')}</p> : null}
              <footer><i className={mailError || mailOverview?.warnings?.length ? 'error' : ''} /><span>{mailError ? 'Sin conexión' : mailOverview?.warnings?.length ? `${mailOverview.warnings.length} ${mailOverview.warnings.length === 1 ? 'aviso' : 'avisos'} de Mail` : 'Mail.app · actualización 2 min'}</span></footer>
            </aside>
            {mailLayout === 'split' ? <SplitDivider split={mailSplit} className="mail-resizer" label="Cambiar ancho de la lista de correo" onCollapseStart={() => setMailLayout('message')} onCollapseEnd={() => { setMailLayout('inbox'); setMailComposerOpen(false); setMailSendConfirm(false); }} startPaneLabel="bandeja" endPaneLabel="mensaje" /> : null}
            <section className="mail-reader" hidden={mailLayout === 'inbox'}>
              <header>
                <div className="mail-message-actions">
                  <button onClick={startReply} disabled={!mailThread || mailThreadLoading} type="button">Responder ↩</button>
                  <button onClick={startForward} disabled={!mailThread || mailThreadLoading} type="button">Reenviar →</button>
                </div>
                <div>
                  <span>{selectedEmail ? `${selectedEmail.mailbox_label} · ${selectedEmail.from_name} · ${formatMailDate(selectedEmail.date)}` : 'CORREO / ESPRIT'}</span>
                  <h3>{selectedEmail?.subject ?? 'Selecciona un correo'}</h3>
                </div>
              </header>
              <div className="mail-thread">
                {mailThreadLoading ? <div className="mail-reader-state" role="status"><i />Cargando la conversación completa…</div> : null}
                {!mailThreadLoading && !selectedMailThread ? (
                  <div className="mail-empty"><span>@</span><h3>Tu correo, reunido.</h3><p>Esprit lee las cuentas de Mail.app que configuraste; cada mensaje conserva su buzón y su dirección.</p></div>
                ) : null}
                {mailThread?.thread_id === selectedMailThread ? <MailThreadView key={`${mailThread.thread_id}:${mailThreadLoading}`} messages={mailThread.messages} onLink={interceptMailLink} /> : null}
                {!mailThreadLoading && mailError && mailThread?.messages.length === 1 && !mailThread.messages[0].body ? <div className="mail-inline-error">No se pudo cargar el cuerpo completo. Se muestra la vista previa disponible.</div> : null}
              </div>
              <footer><span>{mailThread ? `${mailThread.message_count ?? mailThread.messages.length} mensajes en la conversación${mailThread.reconstructed ? ` · reunidos desde ${mailThread.source_thread_count ?? 2} hilos` : ''}${mailThread.truncated ? ' · vista parcial' : ''}` : 'Cada mensaje conserva su buzón y dirección.'}</span>{selectedMailThread ? <button onClick={startReply} type="button">Responder ↩</button> : null}</footer>
            </section>

            {mailComposerOpen ? (
              <form className="mail-composer" onSubmit={reviewMailSend}>
                <header><div><span>{mailComposeKind === 'forward' ? 'REENVIAR' : mailComposeKind === 'reply' ? 'RESPONDER' : 'NUEVO MENSAJE'}</span><h3>{mailComposeKind === 'forward' ? 'Reenviar mensaje' : mailComposeKind === 'reply' ? 'Escribir respuesta' : 'Redactar correo'}</h3></div><button onClick={() => { setMailComposerOpen(false); setMailSendConfirm(false); }} type="button" aria-label="Cerrar redacción">×</button></header>
                <label><span>DESDE</span><select value={mailDraft.from_account} onChange={(event) => { setMailDraft((current) => ({ ...current, from_account: event.target.value as MailAccountKey })); setMailSendConfirm(false); }} disabled={Boolean(mailDraft.reply_message_id)}>{mailAccounts.map((account) => <option disabled={!account.connected} key={account.key} value={account.key}>{account.label} · {account.address}</option>)}</select></label>
                <label><span>PARA</span><input type="text" value={mailDraft.to} onChange={(event) => { setMailDraft((current) => ({ ...current, to: event.target.value })); setMailSendConfirm(false); }} placeholder="nombre@dominio.com" autoFocus /></label>
                <label><span>ASUNTO</span><input type="text" value={mailDraft.subject} onChange={(event) => { setMailDraft((current) => ({ ...current, subject: event.target.value })); setMailSendConfirm(false); }} placeholder="Asunto" /></label>
                <textarea value={mailDraft.body} onChange={(event) => { setMailDraft((current) => ({ ...current, body: event.target.value })); setMailSendConfirm(false); }} placeholder="Escribe tu mensaje…" />
                <footer>
                  <span>{mailComposeKind === 'forward' && mailForwardHasAttachments ? 'Los adjuntos originales no se incluyen. ' : ''}Se enviará desde {selectedSenderAccount?.address || 'la identidad seleccionada'}{mailDraft.reply_message_id ? ' como respuesta.' : '.'}</span>
                  <button type="submit" disabled={mailSending}>Revisar envío →</button>
                </footer>
                {mailSendConfirm ? (
                  <div className="mail-confirm" role="dialog" aria-modal="true" aria-label="Confirmar envío">
                    <span>CONFIRMACIÓN FINAL</span>
                    <h3>¿Enviar este correo?</h3>
                    <dl><div><dt>Desde</dt><dd>{selectedSenderAccount?.address || mailDraft.from_account}</dd></div><div><dt>Para</dt><dd>{mailDraft.to}</dd></div><div><dt>Asunto</dt><dd>{mailDraft.subject}</dd></div></dl>
                    <p>Esta acción enviará el mensaje inmediatamente desde el buzón indicado.{mailComposeKind === 'forward' && mailForwardHasAttachments ? ' Se reenvía únicamente el texto; los adjuntos originales no se incluyen.' : ''}</p>
                    <div><button onClick={() => setMailSendConfirm(false)} disabled={mailSending} type="button">Volver</button><button onClick={() => void confirmMailSend()} disabled={mailSending} type="button">{mailSending ? 'Enviando…' : 'Confirmar y enviar'}</button></div>
                  </div>
                ) : null}
              </form>
            ) : null}
          </div>
        ) : null}

        {activeWindow === 'github' ? (
          <GitHubSpace onClose={closeUtilityWindow}
            overview={githubOverview}
            loading={githubLoading}
            error={githubError}
            selectedRepository={selectedGitHubRepository}
            compactPanel={githubCompactPanel}
            onSelectRepository={setSelectedGitHubRepository}
            onSelectPanel={setGitHubCompactPanel}
            onRefresh={() => void refreshGitHub()}
            onConnect={() => void connectGitHub()}
            onOpenRepository={(repository) => void openGitHubTarget(repository, 'repository')}
            onOpenItem={(repository, kind, identifier) => void openGitHubTarget(repository, kind, identifier)}
          />
        ) : null}

        {activeWindow === 'trips' && modules.travel.enabled ? <TravelSpace onClose={closeUtilityWindow} onNotice={setToast} /> : null}
        {activeWindow === 'meetings' && modules.meetings.enabled ? <ResearchSpace research={research} projects={availableProjects} onOpen={openResearchNote} onProject={(slug) => { selectProjectExplorer(slug); requestWindowTransition('projects'); }} /> : null}

        {clusterEnabled && (keptSpaces.cluster || activeWindow === 'cluster') ? <div className="workspace-kept" hidden={activeWindow !== 'cluster'}><ClusterSpace
          active={activeWindow === 'cluster'}
          label={clusterLabel}
          scheduler={modules.cluster.scheduler}
          hasJupyter={modules.cluster.has_jupyter}
          projects={config.projects.filter((project) => project.has_cluster).map((project) => ({ slug: project.slug, label: project.short_name }))}
          onOpenJupyter={() => void runAction('jupyter')}
        /></div> : null}

        {keptSpaces.projects || activeWindow === 'projects' ? (
          <div className="workspace-kept" hidden={activeWindow !== 'projects'}><ProjectSpace openRequest={projectOpenRequest}
            active={activeWindow === 'projects'}
            projects={availableProjects}
            initialProject={selectedProjectExplorer}
            onOpenFolder={(slug) => void runAction('project', slug)}
            onAskCodex={(slug) => { setActiveWindow(null); focusCodex(slug); }}
            onSelectProject={selectProjectExplorer}
            onNotice={setToast}
            showHiddenFiles={showHiddenFiles}
            onEditorStatusChange={updateProjectEditorStatus}
            latexEnabled={modules.latex.enabled}
            onClose={closeUtilityWindow}
          /></div>
        ) : null}

        {activeWindow === 'calendar' && calendarEnabled ? (
          <CalendarSpace overview={calendarOverview} loading={calendarLoading} error={calendarError} readCalendars={modules.calendar.read} writeCalendars={modules.calendar.write} onRefresh={() => void refreshCalendar(true)} onOpenCalendar={() => void runAction('calendar')} onCreateEvent={async (request) => {
            let result: { created: string[]; skipped: string[]; errors: string[] };
            try {
              result = await invoke<{ created: string[]; skipped: string[]; errors: string[] }>('calendar_create_event', { request });
            } catch (reason) {
              setCalendarError('La escritura falló; Esprit está verificando de nuevo los permisos de Calendar.');
              void refreshCalendar(true);
              throw reason;
            }
            const refreshed = await refreshCalendar(true);
            if (result.created.length > 0) {
              setToast(refreshed.overview ? 'Evento creado y sincronizado con el próximo Login / Logout.' : 'Evento creado; Calendar tardó en actualizar la vista y Esprit volverá a intentarlo.');
            } else if (result.skipped.length > 0) {
              setToast('Ese evento ya existía en Calendar; no se creó un duplicado.');
            } else {
              setToast('Calendar no creó ningún evento. Revisa el destino y vuelve a intentarlo.');
            }
          }} />
        ) : null}

        {activeWindow === 'daily' ? (
          <div className={`daily-space ${dailyMode}`}>
            <aside className="daily-rail">
              <span>RITUAL / DOCTORADO</span>
              <h3>{dailyMode === 'login' ? 'Empezar el día' : 'Cerrar el día'}</h3>
              <p>{dailyMode === 'login' ? `El modelo seleccionado reúne ${joinSpanishList(['el estado global', 'los proyectos', ...ritualSourceNames])} para decidir qué importa hoy.` : `El modelo seleccionado reconstruye primero el día documentado${githubEnabled ? ', incluida la actividad de GitHub' : ''}. Después te cuenta qué ha encontrado y te pregunta por los huecos antes de proponer el cierre.`}</p>
              <dl>
                <div><dt>ESTADO GLOBAL</dt><dd>{globalState ? globalState.updated_at : globalStateError ? 'No disponible' : 'Leyendo…'}</dd></div>
                <div><dt>ÚLTIMO LOGOUT</dt><dd>{globalState?.last_logout ?? 'Sin registrar'}</dd></div>
                <div><dt>{runningRitualProfile ? 'PERFIL EN CURSO' : 'PERFIL CONFIGURADO'}</dt><dd>{isCodexModel(displayedRitualProfile.model) ? 'Codex' : 'Claude'} · {ritualModelLabel} · {ritualEffortLabel}</dd></div>
              </dl>
              <div className="daily-mode-switch">
                <button className={dailyMode === 'login' ? 'active' : ''} onClick={() => openDailyRitual('login')} type="button" aria-pressed={dailyMode === 'login'}><i>↗</i><span>Login</span></button>
                <button className={dailyMode === 'logout' ? 'active' : ''} onClick={() => openDailyRitual('logout')} type="button" aria-pressed={dailyMode === 'logout'}><i>↘</i><span>Logout</span></button>
              </div>
              <section className="daily-login-history" aria-label="Historial de rituales">
                <header>
                  <div className="daily-history-tabs" role="tablist" aria-label="Tipo de historial"><button className={dailyHistoryTab === 'login' ? 'active' : ''} onClick={() => setDailyHistoryTab('login')} type="button" role="tab" aria-selected={dailyHistoryTab === 'login'}>LOGINS</button><button className={dailyHistoryTab === 'logout' ? 'active' : ''} onClick={() => setDailyHistoryTab('logout')} type="button" role="tab" aria-selected={dailyHistoryTab === 'logout'}>LOGOUTS</button></div>
                  <button onClick={() => void (dailyHistoryTab === 'login' ? refreshLoginHistory() : refreshLogoutHistory())} disabled={dailyHistoryTab === 'login' ? loginHistoryLoading : logoutHistoryLoading} type="button" aria-label="Actualizar historial">{(dailyHistoryTab === 'login' ? loginHistoryLoading : logoutHistoryLoading) ? '…' : '↻'}</button>
                </header>
                <div className="daily-login-history-list">
                  {dailyHistoryTab === 'login' ? loginHistory.map((entry) => (
                    <div className={`daily-login-history-entry${selectedLoginId === entry.id ? ' active' : ''}`} key={entry.id}>
                      <button className="daily-login-history-open" onClick={() => reviewLoginHistory(entry)} disabled={loginDeleting !== null} type="button">
                        <span>{entry.label}</span><time dateTime={entry.created_at}>{formatLoginHistoryTime(entry.created_at)}</time>
                      </button>
                      <button className={`daily-history-keep${entry.kept ? ' active' : ''}`} onClick={() => void toggleHistoryKeep('login', entry)} type="button" aria-label={entry.kept ? `Dejar de conservar ${entry.label}` : `Conservar ${entry.label}`}>{entry.kept ? '●' : '○'}</button>
                      {loginDeleteCandidate === entry.id ? (
                        <span className="daily-login-delete-confirm" aria-label={`Confirmar borrado de ${entry.label}`}>
                          <button onClick={() => setLoginDeleteCandidate(null)} disabled={loginDeleting !== null} type="button" aria-label="Cancelar borrado">↩</button>
                          <button onClick={() => void deleteLoginHistory(entry)} disabled={dailyBusy || loginDeleting !== null} type="button" aria-label={`Borrar ${entry.label} definitivamente`}>{loginDeleting === entry.id ? '…' : '✓'}</button>
                        </span>
                      ) : (
                        <button className="daily-login-delete" onClick={() => setLoginDeleteCandidate(entry.id)} disabled={dailyBusy || loginDeleting !== null} type="button" aria-label={`Borrar ${entry.label}`} title="Borrar Login">×</button>
                      )}
                    </div>
                  )) : logoutHistory.map((entry) => (
                    <div className={`daily-login-history-entry${dailyHistoryReview?.kind === 'logout' && dailyHistoryReview.id === entry.id ? ' active' : ''}`} key={entry.id}>
                      <button className="daily-login-history-open" onClick={() => reviewLogoutHistory(entry)} type="button"><span>{entry.label}</span><time dateTime={entry.created_at}>{formatLoginHistoryTime(entry.created_at)}</time></button>
                      <button className={`daily-history-keep${entry.kept ? ' active' : ''}`} onClick={() => void toggleHistoryKeep('logout', entry)} type="button" aria-label={entry.kept ? `Dejar de conservar ${entry.label}` : `Conservar ${entry.label}`}>{entry.kept ? '●' : '○'}</button>
                    </div>
                  ))}
                  {dailyHistoryTab === 'login' && !loginHistoryLoading && loginHistory.length === 0 ? <p title={loginHistoryError ?? undefined}>{loginHistoryError ? 'Historial no disponible.' : 'Todavía no hay logins guardados.'}</p> : null}
                  {dailyHistoryTab === 'logout' && !logoutHistoryLoading && logoutHistory.length === 0 ? <p title={logoutHistoryError ?? undefined}>{logoutHistoryError ? 'Historial no disponible.' : 'Todavía no hay logouts guardados.'}</p> : null}
                </div>
                <small className="daily-history-retention">Se eliminan tras 7 días salvo los marcados con ●.</small>
              </section>
              <footer><i /><span>Logout lee → pregunta → propone → confirma</span></footer>
            </aside>

            <section className="daily-main">
              {dailyHistoryReview ? <div className="daily-history-review"><header><div><span>{dailyHistoryReview.kind.toUpperCase()} / HISTORIAL</span><h3>{dailyHistoryReview.label}</h3><p>{formatLoginHistoryTime(dailyHistoryReview.created_at)} · registro cerrado</p></div><button onClick={() => setDailyHistoryReview(null)} type="button">Volver al ritual →</button></header><div className="daily-report"><RichText content={dailyHistoryReview.content} /></div></div> : null}
              {!dailyHistoryReview && dailySessionKind === dailyMode && dailyError ? <div className="daily-error"><strong>No se pudo completar el ritual</strong><p>{dailyError}</p></div> : null}
              {!dailyHistoryReview && dailySessionKind === dailyMode && dailyWarnings.length > 0 ? <div className="daily-warning"><strong>Cobertura parcial</strong><p>{dailyWarnings.join(' ')}</p></div> : null}

              {!dailyHistoryReview && dailyBusy && dailySessionKind !== dailyMode ? <p className="daily-warning" role="status">{dailySessionKind === 'login' ? 'Login' : 'Logout'} en curso. Puedes volver a su pestaña para seguirlo.</p> : null}

              {!dailyHistoryReview && dailyMode === 'login' ? (
                <>
                  <header><span>LOGIN / BRIEFING</span><h3>Lo que importa hoy</h3><p>Una síntesis nueva, no una copia de cada bandeja.</p></header>
                  {dailyBusy && dailySessionKind === 'login' && !selectedLoginId ? <div className="daily-loading"><i /><h3>El modelo está reuniendo el contexto</h3><p>Revisa las fuentes vivas{githubEnabled ? ', incluido GitHub,' : ''} y contrasta el estado de los proyectos.</p></div> : null}
                  {loginResult ? <div className="daily-report"><RichText content={loginResult} onOpenLink={openDocumentLink} /></div> : null}
                  {!dailyBusy ? <div className="daily-empty daily-start"><h3>{loginResult ? 'Preparar otra lectura del día' : 'Preparado para empezar cuando tú decidas.'}</h3><button onClick={() => void executeDailyRitual('login', '')} type="button">{loginResult ? 'Iniciar nuevo Login →' : 'Iniciar Login →'}</button></div> : null}
                </>
              ) : null}

              {!dailyHistoryReview && dailyMode === 'logout' && logoutPhase === 'discovering' ? (
                dailyBusy && dailySessionKind === 'logout' ? (
                  <div className="daily-loading"><i /><h3>El modelo está reconstruyendo el día</h3><p>Revisa {joinSpanishList(['el estado', 'los proyectos', ...ritualSourceNames])} antes de preguntarte nada.</p></div>
                ) : (
                  <div className="daily-empty"><h3>Revisa tu día cuando estés listo.</h3><button disabled={dailyBusy} onClick={() => void executeDailyRitual('logout_discovery', '')} type="button">Iniciar Logout →</button></div>
                )
              ) : null}

              {!dailyHistoryReview && dailyMode === 'logout' && (logoutPhase === 'interview' || logoutPhase === 'previewing') && logoutDiscovery ? (
                <div className="daily-interview">
                  <header><span>LOGOUT / REVISIÓN DOCUMENTADA</span><h3>Esto es lo que he encontrado</h3><p>Responde a las preguntas y corrige o añade cualquier trabajo que solo conozcas tú.</p></header>
                  <div className="daily-interview-body" style={{ '--interview-report-track': interviewSplit.track(96) } as CSSProperties}>
                    <div className="daily-report"><RichText content={logoutDiscovery} onOpenLink={openDocumentLink} /></div>
                    <SplitDivider split={interviewSplit} className="daily-resizer horizontal" label="Cambiar altura del área de respuestas" />
                    <form className="daily-response" onSubmit={(event) => { event.preventDefault(); void executeDailyRitual('logout_preview', composedLogoutNotes()); }}>
                      <label><span>TUS RESPUESTAS</span><strong>{logoutQuestions.length ? `${logoutAnsweredCount} de ${logoutQuestions.length} contestadas` : 'Completa el día'}</strong></label>
                      <div className="daily-question-list">
                        {logoutQuestions.map((question, index) => (
                          <div className={`daily-question${(logoutAnswers[index] ?? '').trim() ? ' answered' : ''}`} key={`${index}-${question}`}>
                            <label htmlFor={`logout-answer-${index}`}><b>{index + 1}</b><span>{question}</span></label>
                            <textarea
                              id={`logout-answer-${index}`}
                              value={logoutAnswers[index] ?? ''}
                              onChange={(event) => {
                                const next = event.target.value;
                                setLogoutAnswers((current) => current.map((answer, position) => position === index ? next : answer));
                                setDailyPlanId(null);
                              }}
                              placeholder="Sin nada que añadir aquí"
                              rows={2}
                              disabled={dailyBusy}
                              autoFocus={index === 0}
                            />
                          </div>
                        ))}
                        <div className="daily-question extra">
                          <label htmlFor="logout-extra"><b>+</b><span>Cualquier otra cosa: resultados, ideas, conversaciones o gestiones que no aparezcan arriba.</span></label>
                          <textarea
                            id="logout-extra"
                            value={logoutExtra}
                            onChange={(event) => { setLogoutExtra(event.target.value); setDailyPlanId(null); }}
                            placeholder="Opcional"
                            rows={3}
                            disabled={dailyBusy}
                          />
                        </div>
                      </div>
                      <div className="daily-response-footer"><small>La captura de fuentes no se repetirá. Todavía no se escribirá nada.</small><button type="submit" disabled={dailyBusy || !logoutDiscoveryId}>{dailyBusy ? 'Preparando propuesta…' : logoutHasNotes ? 'Integrar y preparar cierre →' : 'No hay nada más →'}</button></div>
                    </form>
                  </div>
                </div>
              ) : null}

              {!dailyHistoryReview && dailyMode === 'logout' && (logoutPhase === 'review' || logoutPhase === 'applying') && dailyPreview ? (
                <div className="daily-review">
                  <header><span>REVISIÓN ANTES DE APLICAR</span><h3>Estado y calendario propuestos</h3><p>Confirma solo si este resumen representa correctamente tu día.</p></header>
                  <div className="daily-report"><RichText content={dailyPreview} onOpenLink={openDocumentLink} /></div>
                  <footer><button onClick={() => { setLogoutPhase('interview'); setDailyPreview(''); setDailyPlanId(null); setDailyError(null); }} disabled={dailyBusy} type="button">Volver a completar</button><span>Actualizará Esprit/STATE.md{calendarEnabled && modules.calendar.write.length ? ' y únicamente los eventos CREATE mostrados' : ''}.</span><button onClick={() => void applyDailyLogout()} disabled={dailyBusy || !dailyPlanId} type="button">{dailyBusy ? 'Cerrando el día…' : 'Confirmar logout'}</button></footer>
                </div>
              ) : null}

              {!dailyHistoryReview && dailyMode === 'logout' && logoutPhase === 'complete' && dailyApplied ? (
                <div className="daily-complete">
                  <header><span>LOGOUT COMPLETADO</span><h3>El relevo de mañana está listo.</h3></header>
                  <div className="daily-report"><RichText content={dailyResult} onOpenLink={openDocumentLink} /></div>
                  <footer><button onClick={closeUtilityWindow} type="button">Cerrar</button><button disabled={dailyBusy} onClick={() => void executeDailyRitual('logout_discovery', '')} type="button">Iniciar nuevo Logout →</button></footer>
                </div>
              ) : null}
            </section>
          </div>
        ) : null}

        {libraryEnabled && (keptSpaces.library || activeWindow === 'library') ? <div className="workspace-kept" hidden={activeWindow !== 'library'}><LibrarySpace active={activeWindow === 'library'} onOpenFolder={() => void runAction('library')} onNotice={setToast} research={research} onOpenNote={openResearchNote} externalPaper={paperTarget} ritualModel={ritualModel} ritualEffort={ritualEffort} radarEnabled={modules.paper_radar.enabled} projectCollections={config.projects.filter((project) => project.has_library).map((project) => ({ slug: project.slug, label: project.name }))} /></div> : null}

        {activeWindow === 'settings' ? (
          <SettingsSpace
            ritualModel={ritualModel}
            ritualEffort={ritualEffort}
            ritualModels={chat.catalog?.engines.filter((engine) => isEngineEnabled(engine.value)).flatMap((engine) => engine.models) ?? []}
            onRitualModelChange={updateRitualModel}
            onRitualEffortChange={updateRitualEffort}
            theme={theme}
            palette={palette}
            textSize={textSize}
            showHiddenFiles={showHiddenFiles}
            onThemeChange={updateTheme}
            onPaletteChange={updatePalette}
            onTextSizeChange={updateTextSize}
            onShowHiddenFilesChange={updateShowHiddenFiles}
            onOpenSource={() => void runAction('esprit_source')}
            onRevealApp={() => void runAction('esprit_app')}
            onOpenWorkspace={() => void runAction('workspace')}
            onReset={resetAppearance}
            workspacePath={config.workspace}
            configPath={config.config_path}
            appVersion={config.app_version}
            configReloading={configReloading}
            onOpenConfig={() => void runAction('config_file')}
            onReloadConfig={() => void reloadConfiguration()}
          />
        ) : null}

        {projectExitReview ? (
          <div className="project-exit-layer">
            <div className="project-save-review discard-review" role="dialog" aria-modal="true" aria-label="Salir con cambios sin guardar">
              <span>CAMBIOS SIN GUARDAR</span><h3>¿Cerrar Esprit?</h3><p>Hay borradores sin guardar en uno o varios proyectos. Cerrar la app descarta esos borradores; cambiar de espacio los conserva.</p>
              <div><button onClick={cancelProjectExit} autoFocus type="button">Seguir editando</button><button className="danger" onClick={confirmProjectExit} type="button">Descartar y salir</button></div>
            </div>
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <main
      className={`app-shell${sidebarOpen ? '' : ' sidebar-collapsed'}`}
      data-theme={theme}
      data-palette={palette}
      data-text-size={textSize}
    >
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand"><span className="brand-mark">E</span><div><p>Esprit</p><span>Tu doctorado</span></div></div>
          <button className="sidebar-toggle" onClick={() => setSidebarOpen((open) => !open)} type="button" aria-label={sidebarOpen ? 'Cerrar barra lateral' : 'Abrir barra lateral'}>{sidebarOpen ? '‹' : '›'}</button>
        </div>

        <nav className="primary-nav" aria-label="Navegación principal">
          <p className="nav-label">ESPACIO</p><button className="nav-item" type="button" aria-label="Buscar en Esprit" title="Buscar en Esprit · Ctrl/⌘K" onClick={() => setGlobalSearchOpen(true)}><NavIcon name="search" /><span className="nav-text">Buscar <small>Ctrl/⌘K</small></span></button>
          <button className="nav-item" type="button" title="Preguntar · Ctrl/⌘J" onClick={() => setQuickOpen(true)}><NavIcon name="ask" /><span className="nav-text">Preguntar <small>Ctrl/⌘J</small></span></button>
          {navigation.map((item, index) => {
            const chord = index < 9 ? `Ctrl/⌘${index + 1}` : index === 9 ? 'Ctrl/⌘0' : '';
            const count = item.window === 'mattermost'
              ? mattermostNotificationCount
              : item.window === 'mail'
                ? mailNotificationCount
                : item.window === 'github'
                  ? githubNotificationCount
                : item.window === 'calendar'
                  ? calendarNotificationCount
                  : item.count ?? 0;
            return (
              <button className={`nav-item${item.window === activeWindow || (!item.window && !activeWindow) ? ' active' : ''}`} onClick={() => toggleWindow(item.window)} type="button" key={item.label} title={sidebarOpen ? chord : `${item.label} · ${chord}`} aria-current={item.window === activeWindow || (!item.window && !activeWindow) ? 'page' : undefined}>
                <NavIcon name={(item.window === 'cluster' ? 'compute' : item.window ?? 'home') as NavIconName} /><span className="nav-text">{item.label}</span>
                {count > 0 ? <span className="nav-count">{count}</span> : null}
              </button>
            );
          })}
        </nav>

        {config.links.length > 0 || (mattermostEnabled && modules.mattermost.has_app) ? (
          <div className="sidebar-section">
            <p className="nav-label">ABRIR</p>
            {config.links.map((link) => {
              const icon = link.icon && bundledQuickIcons.has(link.icon) ? link.icon : null;
              return (
                <button className="quick-link" onClick={() => void openConfiguredLink(link.index)} type="button" key={`${link.index}-${link.label}`} aria-label={link.label} title={link.label}>
                  <span className={`quick-app-icon${icon === 'overleaf' ? ' quick-app-icon-overleaf' : ''}${icon ? '' : ' quick-app-glyph'}`} aria-hidden="true">
                    {icon ? <Image className="quick-app-icon-image" src={`/quick-icons/${icon}.png`} alt="" width={20} height={20} /> : (link.label.trim().charAt(0) || '·').toLocaleUpperCase('es')}
                  </span>
                  <span className="quick-text">{link.label}</span>
                </button>
              );
            })}
            {mattermostEnabled && modules.mattermost.has_app ? (
              <button className="quick-link" onClick={() => void runAction('mattermost')} type="button" aria-label="App de Mattermost" title="App de Mattermost">
                <span className="quick-app-icon" aria-hidden="true"><Image className="quick-app-icon-image" src="/quick-icons/mattermost.png" alt="" width={20} height={20} /></span>
                <span className="quick-text">Mattermost</span>
              </button>
            ) : null}
          </div>
        ) : null}

        <button className={`settings-nav${activeWindow === 'settings' ? ' active' : ''}`} onClick={() => toggleWindow('settings')} type="button" aria-label="Abrir configuración" aria-current={activeWindow === 'settings' ? 'page' : undefined} title={sidebarOpen ? 'Ctrl/⌘,' : 'Configuración · Ctrl/⌘,'}>
          <NavIcon name="settings" /><b>Configuración</b>
        </button>

        <div className="sidebar-footer">
          <div className="avatar" title={config.user.name}>{config.user.initials || (config.user.short_name || config.user.name).charAt(0).toLocaleUpperCase('es')}</div><div><p>{config.user.short_name || config.user.name}</p><span>Todo local</span></div><i />
        </div>
        <p className="sidebar-credit">Esprit · A.S. Gómez</p>
      </aside>

      {quickDraft && modules.notes.enabled ? <QuickNoteComposer initial={quickDraft} quick={quick} projects={config.projects.map(p=>({slug:p.slug,label:p.name}))} meetings={[]} onClose={()=>setQuickDraft(null)} onCreateMeeting={()=>{}} /> : null}
      <section className="workspace">
        {quickOpen ? <div className="public-ask-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setQuickOpen(false); }}><section className="public-ask" role="dialog" aria-modal="true" aria-label="Pregunta rápida"><header><strong>Preguntar</strong><button type="button" onClick={() => setQuickOpen(false)} aria-label="Cerrar pregunta">×</button></header><form className="compact-composer" onSubmit={(event) => void askCodex(event)}>
            <CodexProfilePicker
              context={selectedContext}
              contexts={codexContexts}
              engine={chatEngine}
              engines={nativeEngines}
              model={activeChatModel}
              models={nativeModels}
              effort={codexEffort}
              efforts={nativeEfforts}
              disabled={isAsking}
              onContextChange={selectCodexContext}
              onEngineChange={updateChatEngine}
              onModelChange={updateCodexModel}
              onEffortChange={updateCodexEffort}
            />
            <div className="compact-field">
              <textarea autoFocus ref={compactInputRef} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={handleCompactKeyDown} onFocus={() => setComposerFocused(true)} onBlur={() => setComposerFocused(false)} placeholder={`Escribe a ${engineLabel(chatEngine)}…`} disabled={isAsking} rows={1} aria-label={`Mensaje para ${engineLabel(chatEngine)}`} />
            </div>
            <kbd>Ctrl/⌘ J</kbd>
            <button type="submit" disabled={!prompt.trim() || isAsking} aria-label={`Enviar a ${engineLabel(chatEngine)}`}>{isAsking ? '…' : '↑'}</button>
          </form><p>La respuesta se abre en tu conversación.</p></section></div> : null}

        <div className={`fixed-dashboard${activeWindow ? ' window-obscured' : ''}`} aria-hidden={activeWindow || chatOpen ? true : undefined} inert={activeWindow || chatOpen ? true : undefined}>
          {config.appearance.home_wallpaper && !activeWindow && !chatOpen ? <div className="home-wallpaper" aria-hidden="true" style={{ backgroundImage: "url('/custom/home-wallpaper.png')" }} /> : null}
          <section className="pane focus-pane">
            <div className="home-actions"><span>{now ? headerDate.toLocaleDateString('es-ES', {weekday:'long',day:'numeric',month:'long',timeZone:displayTimeZone}) : 'Inicio'}</span><button type="button" onClick={() => openDailyRitual('login')}>Login ↗</button><button type="button" onClick={() => openDailyRitual('logout')}>Logout ↘</button><button type="button" onClick={() => { if (requestWindowTransition(null)) setChatOpen(true); }}>Chat ↗</button><button type="button" onClick={toggleTheme} aria-label="Cambiar tema">{theme === 'dark' ? '☼' : '☾'}</button></div>
            <div className="pane-heading"><span><i /> EN FOCO</span><small>{(focusProject?.name ?? (activeFocus.project === 'general' ? 'Doctorado' : activeFocus.project)).toLocaleUpperCase('es')} · {activeFocus.updated}</small></div>
            <div className="focus-login-grid">
              <div className="focus-primary">
                <div className="focus-copy">
                  <h1>{activeFocus.headline}</h1>
                  <p>{activeFocus.detail}</p>
                </div>
                <div className="pane-actions">
                  <button onClick={() => focusCodex(focusHasNativeContext ? activeFocus.project : 'general', activeFocus.next ? `Ayúdame a ejecutar este siguiente paso: ${activeFocus.next}` : 'Ayúdame a decidir el siguiente paso de hoy.')} type="button">Preguntar ↗</button>
                  {focusHasNativeContext ? <button onClick={() => void runAction('project', activeFocus.project)} type="button">Abrir carpeta →</button> : null}
                </div>
              </div>
              <aside className="home-login-summary">
                <header>
                  <div><span>LOGIN DE HOY</span><strong>{homeLoginEntry ? homeLoginEntry.label : 'Aún no preparado'}</strong></div>
                  {homeLoginEntry ? <button onClick={() => reviewLoginHistory(homeLoginEntry)} type="button">Ver briefing ↗</button> : null}
                </header>
                {loginHistoryLoading && !homeLoginEntry ? <p className="home-login-state">Buscando el briefing de hoy…</p> : null}
                {!loginHistoryLoading && homeLoginEntry ? (
                  <ol>
                    {homeLoginHighlights.map((highlight, index) => <li key={`${index}-${highlight}`}><span>{String(index + 1).padStart(2, '0')}</span><p>{highlight}</p></li>)}
                  </ol>
                ) : null}
                {!loginHistoryLoading && !homeLoginEntry ? <div className="home-login-empty"><p>Haz Login para convertir las fuentes del día en tres prioridades visibles aquí.</p><button onClick={() => openDailyRitual('login')} type="button">Preparar Login →</button></div> : null}
              </aside>
            </div>
          </section>

          <section className="pane dates-pane">
            <div className="pane-title"><div><span>PRÓXIMAMENTE</span><h2>Fechas clave</h2></div>{calendarEnabled ? <button onClick={() => toggleWindow('calendar')} type="button" aria-label="Abrir calendario">↗</button> : null}</div>
            <div className="compact-deadlines">
              {!displayedDeadlines.length ? <p className="compact-deadlines-empty">Sin fechas próximas.</p> : null}
              {displayedDeadlines.map((deadline) => (
                <article key={`${deadline.day}-${deadline.month}-${deadline.title}`}><div><strong>{deadline.day}</strong><span>{deadline.month}</span></div><p>{deadline.title}<small>{deadline.meta}</small></p></article>
              ))}
            </div>
          </section>

          <section className="pane projects-pane">
            <div className="pane-title"><div><span>ÚLTIMOS ABIERTOS</span><h2>Proyectos</h2></div><button onClick={() => { const slug = homeProjects[0]?.slug ?? null; if (slug) selectProjectExplorer(slug); toggleWindow('projects'); }} type="button">↗</button></div>
            <div className="compact-projects">
              {!homeProjects.length ? <p className="compact-deadlines-empty">Todavía no hay proyectos en la configuración.</p> : null}
              {homeProjects.map((project, index) => (
                <article key={project.slug}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <div><h3>{project.name}</h3><p>{project.next}</p></div>
                  <div className="mini-progress"><i style={{ width: `${project.progress}%` }} /></div>
                  <button onClick={() => { selectProjectExplorer(project.slug); requestWindowTransition('projects'); }} type="button" aria-label={`Abrir ${project.name}`}>↗</button>
                </article>
              ))}
            </div>
          </section>

          <section className="pane inbox-pane has-waiting">
            <div className="pane-title"><div><span>ATENCIÓN</span><h2>Seguimiento</h2></div><span className="inbox-home-count">{globalNotificationCount > 0 ? globalNotificationCount : '·'}</span></div>
            <nav className="home-attention-tabs" aria-label="Seguimiento de Inicio"><button type="button" className={attentionTab === 'waiting' ? 'active' : ''} onClick={() => setAttentionTab('waiting')}>En espera · {globalState?.waiting_on?.length ?? 0}</button><button type="button" className={attentionTab === 'inbox' ? 'active' : ''} onClick={() => setAttentionTab('inbox')}>Bandeja · {globalNotificationCount}</button></nav>
            {attentionTab === 'waiting' ? <WaitingPanel compact items={globalState?.waiting_on ?? []} updated={globalState?.updated_at ?? ''} onRefresh={() => void refreshGlobalState()} research={research} projects={availableProjects} onOpen={openResearchNote} /> : <div className="compact-inbox">
              {!inboxItems.length ? <p className="compact-inbox-empty">No hay fuentes activadas. Correo, Mattermost, Calendario y GitHub se activan en la configuración.</p> : null}
              {inboxItems.map((item) => (
                <button key={item.source} onClick={() => item.window && toggleWindow(item.window)} type="button"><i className={item.tone}>{item.glyph}</i><div><span>{item.source}</span><p>{item.title}</p><small>{item.meta}</small></div></button>
              ))}
            </div>}
          </section>
        </div>

        {renderUtilityWindow()}

        {chatOpen ? <ChatWorkspace chat={chat} contextLabels={contextLabels} inputRef={chatInputRef} onOpenLink={openDocumentLink} onSubmit={(event) => void askCodex(event)} onKeyDown={handleChatKeyDown} onClose={() => setChatOpen(false)} profilePicker={
          <CodexProfilePicker context={selectedContext} contexts={codexContexts} engine={chatEngine} engines={nativeEngines} model={activeChatModel} models={nativeModels} effort={codexEffort} efforts={nativeEfforts} disabled={isAsking} variant="chat" onContextChange={selectCodexContext} onEngineChange={updateChatEngine} onModelChange={updateCodexModel} onEffortChange={updateCodexEffort} />
        } /> : null}
      </section>

      {globalSearchOpen ? <GlobalSearch entries={searchEntries} papersEnabled={libraryEnabled} onSelect={chooseSearchResult} onPaper={paper => { setChatOpen(false); setPaperTarget(current => ({ ...paper, nonce: (current?.nonce ?? 0) + 1 })); requestWindowTransition('library'); }} onClose={() => setGlobalSearchOpen(false)} /> : null}
      {noteDraftId ? <NoteEditor key={noteDraftId} draftId={noteDraftId} research={research} projects={availableProjects} onClose={() => setNoteDraftId(null)} /> : null}
      {nativeCloseError ? <div className="app-close-layer"><section role="alertdialog" aria-modal="true" aria-labelledby="close-error-title"><h2 id="close-error-title">Hay cambios que todavía no se han guardado</h2><p>{nativeCloseError}</p><p>Puedes conservar una copia antes de salir.</p><div><button type="button" autoFocus onClick={() => setNativeCloseError(null)}>Volver</button><button type="button" onClick={() => void chat.exportHistory()}>Exportar chat</button><button type="button" onClick={research.exportDrafts}>Exportar notas</button><button type="button" onClick={() => void finishNativeClose()}>Reintentar</button><button type="button" onClick={() => {
        void cancelChat().then(async () => { nativeCloseApprovedRef.current = true; await invoke('close_esprit_window'); }).catch((error) => { nativeCloseApprovedRef.current = false; setNativeCloseError(typeof error === 'object' && error && 'message' in error ? String(error.message) : String(error)); });
      }}>Cerrar sin guardar los últimos cambios</button></div></section></div> : null}
      {demoPreview ? <p className="demo-notice" role="note">Vista previa sin app nativa · datos de ejemplo</p> : null}
      {toast ? <div className="toast" role={toastIsError ? 'alert' : 'status'} data-tone={toastIsError ? 'error' : 'info'}><span>{toast.replace(/^Error:\s*/, '')}</span>{toastIsError ? <button type="button" aria-label="Cerrar aviso" onClick={() => setToast(null)}>×</button> : null}</div> : null}
    </main>
  );
}
