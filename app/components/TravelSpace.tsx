'use client';

/* Local previews use data URLs; there is no network image for Next to optimize. */
/* eslint-disable @next/next/no-img-element */

import { invoke } from '@tauri-apps/api/core';
import { CSSProperties, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FileTypeIcon from './FileTypeIcon';
import SplitDivider from './SplitDivider';
import { useResizableSplit } from './useResizableSplit';

type TravelStepStateName = 'pending' | 'done' | 'unknown' | 'not_applicable';
type TravelStepState = { key: string; state: TravelStepStateName };
type TravelTrip = {
  id: string;
  name: string;
  destination: string;
  start_date: string | null;
  end_date: string | null;
  project: string;
  folder: string;
  status: 'active' | 'history';
  next_action: string;
  provenance: string;
  closure_verified: boolean;
  steps: TravelStepState[];
};
type TravelWorkflowStep = {
  key: string;
  label: string;
  short_label: string;
  description: string;
  optional: boolean;
};
type TravelOverview = {
  version: number;
  revision: number;
  checked_at: number;
  official_rule: string;
  trips: TravelTrip[];
  workflow: TravelWorkflowStep[];
};
type TravelEntry = {
  id: string;
  name: string;
  kind: 'directory' | 'file' | 'symlink' | 'other';
  size: number;
  modified: number;
  sensitive: boolean;
};
type TravelDirectory = {
  session_id: string;
  directory_id: string;
  parent_id: string | null;
  display_path: string;
  entries: TravelEntry[];
  truncated: boolean;
};
type TravelFile = {
  id: string;
  name: string;
  display_path: string;
  kind: 'text' | 'pdf' | 'image' | 'external';
  mime: string;
  content: string | null;
  data_base64: string | null;
  modified: number;
  size: number;
  sensitive: boolean;
};
type NewTravelDraft = {
  name: string;
  destination: string;
  start_date: string;
  end_date: string;
  project: string;
};
type TravelCreateReply = { created_id: string; overview: TravelOverview };

const initialDraft: NewTravelDraft = {
  name: '',
  destination: '',
  start_date: '',
  end_date: '',
  project: '',
};

const managementFolders = new Set([
  'poster',
  'posters',
  'slides',
  'talks',
  'my talk',
  'papers',
  'extrafigs',
  'figs',
  'figures',
  'assets',
  'codes',
  'tmp',
]);

const stepResources: Record<string, Array<{ id: string; label: string }>> = {
  commission: [{ id: 'commission', label: 'Abrir sede' }],
  authorization: [{ id: 'commission', label: 'Ver trámite' }],
  agency: [
    { id: 'agency_mail', label: 'Correo plantilla' },
    { id: 'expense_form', label: 'Formulario' },
  ],
  advance: [
    { id: 'advance', label: 'Solicitar online' },
    { id: 'advance_chrome', label: 'Abrir en Chrome' },
    { id: 'advance_form', label: 'PDF alternativo' },
  ],
  forms: [
    { id: 'expense_form', label: 'Gastos' },
    { id: 'liquidation_form', label: 'Liquidación' },
  ],
  submission: [
    { id: 'justification', label: 'Abrir formulario' },
    { id: 'justification_chrome', label: 'Abrir en Chrome' },
  ],
};

const formatDateRange = (trip: TravelTrip) => {
  if (!trip.start_date) return 'Fechas por definir';
  const start = new Date(`${trip.start_date}T12:00:00`);
  if (!trip.end_date || trip.end_date === trip.start_date) {
    return start.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const end = new Date(`${trip.end_date}T12:00:00`);
  return `${start.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })} — ${end.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}`;
};

const formatSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1_048_576) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1_048_576).toFixed(size < 10_485_760 ? 1 : 0)} MB`;
};

const stepStateLabel = (state: TravelStepStateName) => {
  if (state === 'done') return 'Hecho';
  if (state === 'not_applicable') return 'No aplica';
  if (state === 'unknown') return 'Sin verificar';
  return 'Pendiente';
};

const tripProgress = (trip: TravelTrip) => {
  const complete = trip.steps.filter((step) => step.state === 'done' || step.state === 'not_applicable').length;
  return Math.round((complete / Math.max(1, trip.steps.length)) * 100);
};

type SensitiveAction = { entry: TravelEntry; mode: 'preview' | 'open' };
type PendingStep = { step: string; state: TravelStepStateName; label: string };

/**
 * Una superficie de trabajo a la vez. Antes convivían el rail, el ciclo, la
 * carpeta y el visor, que es la queja de "mucha info en la pantalla". El rail
 * se queda porque es la navegación entre viajes.
 */
type TravelStage = 'cycle' | 'documents';

const travelStages: Array<{ id: TravelStage; label: string }> = [
  { id: 'cycle', label: 'Ciclo del viaje' },
  { id: 'documents', label: 'Carpeta y documentos' },
];
const TRAVEL_STAGE_KEY = 'esprit.travel.stage';
const isTravelStage = (value: string | null): value is TravelStage => value === 'cycle' || value === 'documents';

export default function TravelSpace({ onNotice }: { onNotice: (message: string) => void }) {
  const [overview, setOverview] = useState<TravelOverview | null>(null);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileOpening, setFileOpening] = useState(false);
  const [stepBusy, setStepBusy] = useState<string | null>(null);
  const [directory, setDirectory] = useState<TravelDirectory | null>(null);
  const [selectedFile, setSelectedFile] = useState<TravelFile | null>(null);
  const [fileScope, setFileScope] = useState<'management' | 'all'>('management');
  const [fileLayout, setFileLayout] = useState<'list' | 'grid' | 'compact'>(() => {
    if (typeof window === 'undefined') return 'grid';
    const stored = window.localStorage.getItem('esprit-travel-file-layout');
    return stored === 'list' || stored === 'compact' || stored === 'grid' ? stored : 'grid';
  });
  const [error, setError] = useState<string | null>(null);
  const [newTravelOpen, setNewTravelOpen] = useState(false);
  const [newTravelReview, setNewTravelReview] = useState(false);
  const [newTravelBusy, setNewTravelBusy] = useState(false);
  const [draft, setDraft] = useState<NewTravelDraft>(initialDraft);
  const [sensitiveAction, setSensitiveAction] = useState<SensitiveAction | null>(null);
  const [pendingStep, setPendingStep] = useState<PendingStep | null>(null);
  const sessionRef = useRef<string | null>(null);
  const browserEpochRef = useRef(0);
  const directoryRequestRef = useRef(0);
  const fileRequestRef = useRef(0);
  const overviewRequestRef = useRef(0);
  const overviewRevisionRef = useRef(0);
  const railSplit = useResizableSplit({ collapsible: true, storageKey: 'esprit-travel-rail-split', defaultValue: 22, min: 15, max: 38 });
  const [activeStage, setActiveStage] = useState<TravelStage>(() => {
    if (typeof window === 'undefined') return 'cycle';
    const stored = window.localStorage.getItem(TRAVEL_STAGE_KEY);
    return isTravelStage(stored) ? stored : 'cycle';
  });
  const selectStage = (stage: TravelStage) => {
    setActiveStage(stage);
    window.localStorage.setItem(TRAVEL_STAGE_KEY, stage);
  };
  const fileSplit = useResizableSplit({ collapsible: true, storageKey: 'esprit-travel-file-split', defaultValue: 40, min: 24, max: 72 });

  const selectedTrip = overview?.trips.find((trip) => trip.id === selectedTripId) ?? null;
  const activeTrips = overview?.trips.filter((trip) => trip.status === 'active') ?? [];
  const historyTrips = overview?.trips.filter((trip) => trip.status === 'history') ?? [];
  const closureReady = selectedTrip?.steps
    .filter((step) => step.key !== 'closure')
    .every((step) => step.state === 'done' || step.state === 'not_applicable') ?? false;

  const acceptOverview = useCallback((result: TravelOverview, preferredTripId?: string) => {
    if (result.revision < overviewRevisionRef.current) return false;
    overviewRevisionRef.current = result.revision;
    setOverview(result);
    setSelectedTripId((current) => {
      if (preferredTripId && result.trips.some((trip) => trip.id === preferredTripId)) return preferredTripId;
      if (current && result.trips.some((trip) => trip.id === current)) return current;
      return result.trips.find((trip) => trip.status === 'active')?.id ?? result.trips[0]?.id ?? null;
    });
    return true;
  }, []);

  const refreshOverview = useCallback(async () => {
    const requestId = ++overviewRequestRef.current;
    if (!('__TAURI_INTERNALS__' in window)) {
      if (requestId === overviewRequestRef.current) {
        setError('El archivo de viajes se conecta al abrir la app Esprit.');
        setOverviewLoading(false);
      }
      return;
    }
    setOverviewLoading(true);
    try {
      const result = await invoke<TravelOverview>('travel_overview');
      if (requestId === overviewRequestRef.current && acceptOverview(result)) setError(null);
    } catch (reason) {
      if (requestId === overviewRequestRef.current) setError(String(reason));
    } finally {
      if (requestId === overviewRequestRef.current) setOverviewLoading(false);
    }
  }, [acceptOverview]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshOverview(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshOverview]);

  const releaseSession = useCallback(async (session: string | null) => {
    if (session && '__TAURI_INTERNALS__' in window) {
      try { await invoke('travel_browser_stop', { sessionId: session }); } catch { /* A stale session is already inert. */ }
    }
  }, []);

  const stopBrowser = useCallback(async () => {
    browserEpochRef.current += 1;
    directoryRequestRef.current += 1;
    fileRequestRef.current += 1;
    const session = sessionRef.current;
    sessionRef.current = null;
    await releaseSession(session);
  }, [releaseSession]);

  const startBrowser = useCallback(async (tripId: string) => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    const epoch = ++browserEpochRef.current;
    directoryRequestRef.current += 1;
    fileRequestRef.current += 1;
    const previousSession = sessionRef.current;
    sessionRef.current = null;
    setBrowserLoading(true);
    setFileLoading(false);
    setFileOpening(false);
    setDirectory(null);
    setSelectedFile(null);
    setSensitiveAction(null);
    await releaseSession(previousSession);
    if (browserEpochRef.current !== epoch) return;
    try {
      const result = await invoke<TravelDirectory>('travel_browser_start', { tripId });
      if (browserEpochRef.current !== epoch) {
        await releaseSession(result.session_id);
        return;
      }
      sessionRef.current = result.session_id;
      setDirectory(result);
      setError(null);
    } catch (reason) {
      if (browserEpochRef.current === epoch) setError(String(reason));
    } finally {
      if (browserEpochRef.current === epoch) setBrowserLoading(false);
    }
  }, [releaseSession]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (selectedTripId) void startBrowser(selectedTripId);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      void stopBrowser();
    };
  }, [selectedTripId, startBrowser, stopBrowser]);

  const loadDirectory = async (directoryId: string) => {
    const sessionId = sessionRef.current;
    if (!sessionId || browserLoading) return;
    const epoch = browserEpochRef.current;
    const requestId = ++directoryRequestRef.current;
    fileRequestRef.current += 1;
    setBrowserLoading(true);
    setFileLoading(false);
    setSelectedFile(null);
    try {
      const result = await invoke<TravelDirectory>('travel_list', { sessionId, directoryId });
      if (browserEpochRef.current === epoch && sessionRef.current === sessionId && directoryRequestRef.current === requestId) {
        setDirectory(result);
        setError(null);
      }
    } catch (reason) {
      if (browserEpochRef.current === epoch && sessionRef.current === sessionId && directoryRequestRef.current === requestId) setError(String(reason));
    } finally {
      if (browserEpochRef.current === epoch && sessionRef.current === sessionId && directoryRequestRef.current === requestId) setBrowserLoading(false);
    }
  };

  const previewEntry = async (entry: TravelEntry, revealSensitive = false) => {
    const sessionId = sessionRef.current;
    if (!sessionId || fileLoading) return;
    if (entry.kind === 'directory') {
      await loadDirectory(entry.id);
      return;
    }
    if (entry.kind !== 'file') return;
    if (entry.sensitive && !revealSensitive) {
      setSensitiveAction({ entry, mode: 'preview' });
      return;
    }
    const epoch = browserEpochRef.current;
    const requestId = ++fileRequestRef.current;
    setFileLoading(true);
    try {
      const file = await invoke<TravelFile>('travel_read_file', {
        sessionId,
        entryId: entry.id,
        revealSensitive,
      });
      if (browserEpochRef.current === epoch && sessionRef.current === sessionId && fileRequestRef.current === requestId) {
        setSelectedFile(file);
        setSensitiveAction(null);
        setError(null);
      }
    } catch (reason) {
      if (browserEpochRef.current === epoch && sessionRef.current === sessionId && fileRequestRef.current === requestId) setError(String(reason));
    } finally {
      if (browserEpochRef.current === epoch && sessionRef.current === sessionId && fileRequestRef.current === requestId) setFileLoading(false);
    }
  };

  const openEntry = async (entryId: string, confirmedSensitive: boolean) => {
    const sessionId = sessionRef.current;
    if (!sessionId || fileOpening) return;
    const epoch = browserEpochRef.current;
    setFileOpening(true);
    try {
      const message = await invoke<string>('travel_open_entry', { sessionId, entryId, confirmedSensitive });
      onNotice(message);
      if (browserEpochRef.current === epoch && sessionRef.current === sessionId) {
        setSensitiveAction(null);
        setError(null);
      }
    } catch (reason) {
      if (browserEpochRef.current === epoch && sessionRef.current === sessionId) setError(String(reason));
    } finally {
      if (browserEpochRef.current === epoch && sessionRef.current === sessionId) setFileOpening(false);
    }
  };

  const openSelectedFile = () => {
    if (!selectedFile) return;
    if (selectedFile.sensitive) {
      setSensitiveAction({
        entry: {
          id: selectedFile.id,
          name: selectedFile.name,
          kind: 'file',
          size: selectedFile.size,
          modified: selectedFile.modified,
          sensitive: true,
        },
        mode: 'open',
      });
      return;
    }
    void openEntry(selectedFile.id, false);
  };

  const openResource = async (resourceId: string) => {
    try {
      const message = resourceId === 'agency_mail'
        ? await invoke<string>('travel_open_agency_mail', { tripId: selectedTrip?.id ?? '' })
        : await invoke<string>('travel_open_resource', { resourceId });
      onNotice(message);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const openTripFolder = async () => {
    if (!selectedTrip) return;
    try {
      const message = await invoke<string>('travel_open_folder', { tripId: selectedTrip.id });
      onNotice(message);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const applyStepUpdate = async (step: string, state: TravelStepStateName) => {
    if (!selectedTrip || !overview || stepBusy) return;
    const tripId = selectedTrip.id;
    const expectedRevision = overview.revision;
    setStepBusy(step);
    try {
      const result = await invoke<TravelOverview>('travel_update_step', {
        request: { trip_id: tripId, step, state, expected_revision: expectedRevision },
      });
      acceptOverview(result);
      setPendingStep(null);
      setError(null);
      onNotice(state === 'done' && step === 'closure' ? 'Viaje cerrado y movido al historial.' : 'Estado del viaje actualizado.');
    } catch (reason) {
      const message = String(reason);
      setError(message);
      if (message.includes('cambió')) void refreshOverview();
    } finally {
      setStepBusy(null);
    }
  };

  const requestStepUpdate = (step: TravelWorkflowStep, current: TravelStepStateName) => {
    if (stepBusy) return;
    const state: TravelStepStateName = current === 'done' || current === 'not_applicable' ? 'pending' : 'done';
    if (step.key === 'closure' && state === 'done') {
      setPendingStep({ step: step.key, state, label: step.label });
      return;
    }
    void applyStepUpdate(step.key, state);
  };

  const beginNewTravel = () => {
    setDraft(initialDraft);
    setNewTravelReview(false);
    setNewTravelOpen(true);
    setError(null);
  };

  const reviewNewTravel = (event: FormEvent) => {
    event.preventDefault();
    if (draft.name.trim().length < 2) {
      setError('Escribe un nombre de viaje de al menos dos caracteres.');
      return;
    }
    if (draft.start_date && draft.end_date && draft.start_date > draft.end_date) {
      setError('La fecha final no puede ser anterior a la inicial.');
      return;
    }
    setError(null);
    setNewTravelReview(true);
  };

  const createNewTravel = async () => {
    if (!overview || newTravelBusy || stepBusy) return;
    setNewTravelBusy(true);
    try {
      const result = await invoke<TravelCreateReply>('travel_create', {
        request: { ...draft, expected_revision: overview.revision },
      });
      acceptOverview(result.overview, result.created_id);
      setNewTravelOpen(false);
      setNewTravelReview(false);
      setDraft(initialDraft);
      setError(null);
      onNotice('Viaje inicializado con su carpeta y ciclo administrativo.');
    } catch (reason) {
      const message = String(reason);
      setError(message);
      if (message.includes('cambió')) void refreshOverview();
    } finally {
      setNewTravelBusy(false);
    }
  };

  const visibleEntries = useMemo(() => {
    if (!directory || fileScope === 'all') return directory?.entries ?? [];
    return directory.entries.filter((entry) => entry.kind !== 'directory' || !managementFolders.has(entry.name.toLowerCase()));
  }, [directory, fileScope]);

  const viewerOpen = Boolean(selectedFile || fileLoading);
  const updateFileLayout = (layout: 'list' | 'grid' | 'compact') => {
    setFileLayout(layout);
    window.localStorage.setItem('esprit-travel-file-layout', layout);
  };

  const previewSource = selectedFile?.data_base64
    ? `data:${selectedFile.mime};base64,${selectedFile.data_base64}`
    : '';

  const renderTripButton = (trip: TravelTrip) => {
    const progress = tripProgress(trip);
    const current = overview?.workflow.find((workflowStep) => {
      const state = trip.steps.find((step) => step.key === workflowStep.key)?.state;
      return state !== 'done' && state !== 'not_applicable';
    });
    return (
      <button className={selectedTripId === trip.id ? 'active' : ''} onClick={() => setSelectedTripId(trip.id)} type="button" aria-pressed={selectedTripId === trip.id} key={trip.id}>
        <div><strong>{trip.name}</strong><span>{formatDateRange(trip)}</span></div>
        <small>{trip.closure_verified ? 'Cierre verificado' : current?.short_label ?? 'Ciclo completo'} · {progress}%</small>
        <i role="progressbar" aria-label={`Progreso de ${trip.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></i>
      </button>
    );
  };

  return (
    <div className="travel-space">
      <div className="travel-toolbar">
        <div><span>CICLO UAM</span><p>{overview?.official_rule ?? 'Leyendo el circuito de viajes…'}</p></div>
        <button onClick={() => void openResource('uam_overview')} type="button">Guía vigente ↗</button>
        <button onClick={() => void openTripFolder()} disabled={!selectedTrip} type="button">Carpeta completa ↗</button>
        <button className="primary" onClick={beginNewTravel} disabled={newTravelBusy || stepBusy !== null} type="button">＋ Nuevo viaje</button>
      </div>

      <div className="travel-desk" style={{ '--travel-rail-track': railSplit.track(180) } as CSSProperties}>
        <aside className="travel-rail">
          <header><div><span>VIAJES</span><h3>En curso</h3></div><button onClick={() => void refreshOverview()} disabled={overviewLoading} type="button" aria-label="Actualizar viajes">{overviewLoading ? '…' : '↻'}</button></header>
          <div className="travel-trip-list">
            <section><h4>ACTIVOS <span>{activeTrips.length}</span></h4>{activeTrips.map(renderTripButton)}{!overviewLoading && activeTrips.length === 0 ? <p>No hay viajes activos.</p> : null}</section>
            <section className="history"><h4>HISTORIAL <span>{historyTrips.length}</span></h4>{historyTrips.map(renderTripButton)}</section>
          </div>
          <footer><i className={error ? 'error' : ''} /><div><strong>{error ? 'Revisión necesaria' : 'Estado local explícito'}</strong><span>Los PDF aportan evidencia; no cierran solos el viaje.</span></div></footer>
        </aside>
        <SplitDivider split={railSplit} className="travel-resizer vertical rail" label="Cambiar ancho de los viajes" paneLabel="la lista de viajes" />
        <main className="travel-main">
          {/* Una superficie a la vez. El ciclo y la carpeta ya no se reparten
              el alto, que era lo que llenaba la pantalla de información. */}
          <div className="travel-tabs" role="tablist" aria-label="Superficie del viaje">
            {travelStages.map((stage) => (
              <button
                className={activeStage === stage.id ? 'active' : ''}
                onClick={() => selectStage(stage.id)}
                type="button"
                role="tab"
                aria-selected={activeStage === stage.id}
                key={stage.id}
              >
                {stage.label}
              </button>
            ))}
          </div>

          <div className="travel-stage">
            {activeStage === 'cycle' ? (
          <section className="travel-cycle">
            {selectedTrip ? (
              <>
                <header>
                  <div><span>{selectedTrip.status === 'active' ? 'VIAJE ACTIVO' : 'HISTORIAL'}</span><h3>{selectedTrip.name}</h3><p>{selectedTrip.destination} · {formatDateRange(selectedTrip)}{selectedTrip.project ? ` · ${selectedTrip.project}` : ''}</p></div>
                  <aside><small>SIGUIENTE</small><p>{selectedTrip.next_action}</p></aside>
                </header>
                <div className="travel-step-list">
                  {overview?.workflow.map((workflowStep, index) => {
                    const state = selectedTrip.steps.find((step) => step.key === workflowStep.key)?.state ?? 'unknown';
                    const resources = stepResources[workflowStep.key] ?? [];
                    return (
                      <article className={state} key={workflowStep.key}>
                        <b>{String(index + 1).padStart(2, '0')}</b><i aria-hidden="true" />
                        <div className="travel-step-copy"><h4>{workflowStep.label}{workflowStep.optional ? <small> OPCIONAL</small> : null}</h4><p>{workflowStep.description}</p></div>
                        <div className="travel-step-links">{resources.map((resource) => <button onClick={() => void openResource(resource.id)} type="button" key={resource.id}>{resource.label} ↗</button>)}</div>
                        <span>{stepStateLabel(state)}</span>
                        <div className="travel-step-actions">
                          {workflowStep.optional && state !== 'done' && state !== 'not_applicable' ? <button onClick={() => void applyStepUpdate(workflowStep.key, 'not_applicable')} disabled={stepBusy !== null} type="button">No aplica</button> : null}
                          <button onClick={() => requestStepUpdate(workflowStep, state)} disabled={stepBusy !== null} type="button">{stepBusy === workflowStep.key ? 'Guardando…' : state === 'done' || state === 'not_applicable' ? 'Reabrir' : 'Marcar hecho'}</button>
                        </div>
                      </article>
                    );
                  })}
                </div>
                <footer><span>PROCEDENCIA</span><p>{selectedTrip.provenance}</p></footer>
              </>
            ) : overviewLoading ? <div className="desk-skeleton" role="status" aria-label="Leyendo viajes"><i /><i /><i /><i /><i /></div> : <div className="travel-empty"><span>VIAJE</span><h3>Selecciona o crea un viaje.</h3><p>El ciclo, los documentos y el historial aparecerán aquí.</p></div>}
          </section>
            ) : null}

            {activeStage === 'documents' ? (
          <div className={`travel-browser-row${viewerOpen ? ' with-viewer' : ' files-only'}`} style={{ '--travel-files-track': fileSplit.track(220) } as CSSProperties}>
            <section className="travel-files">
              <header><div><span>CARPETA LOCAL</span><h3>{directory?.display_path ?? selectedTrip?.folder ?? 'Sin viaje'}</h3></div><div><button onClick={() => directory?.parent_id && void loadDirectory(directory.parent_id)} disabled={!directory?.parent_id || browserLoading} type="button">↑ Subir</button><button onClick={() => directory && void loadDirectory(directory.directory_id)} disabled={!directory || browserLoading} type="button">{browserLoading ? '…' : '↻'}</button></div></header>
              <div className="travel-file-modes"><button className={fileScope === 'management' ? 'active' : ''} onClick={() => setFileScope('management')} type="button" aria-pressed={fileScope === 'management'}>Gestión</button><button className={fileScope === 'all' ? 'active' : ''} onClick={() => setFileScope('all')} type="button" aria-pressed={fileScope === 'all'}>Todos</button><i /><button className={fileLayout === 'list' ? 'active' : ''} onClick={() => updateFileLayout('list')} type="button">Lista</button><button className={fileLayout === 'grid' ? 'active' : ''} onClick={() => updateFileLayout('grid')} type="button">Iconos</button><button className={fileLayout === 'compact' ? 'active' : ''} onClick={() => updateFileLayout('compact')} type="button">Compacta</button></div>
              <div className={`travel-file-list layout-${fileLayout}`}>
                {browserLoading && !directory ? <div className="travel-panel-state">Leyendo carpeta…</div> : null}
                {!browserLoading && directory && visibleEntries.length === 0 ? <div className="travel-panel-state">Esta carpeta está vacía en esta vista.</div> : null}
                {visibleEntries.map((entry) => (
                  <button className={selectedFile?.id === entry.id ? 'active' : ''} onClick={() => void previewEntry(entry)} disabled={fileLoading || entry.kind === 'symlink' || entry.kind === 'other'} type="button" title={entry.name} key={entry.id}>
                    <FileTypeIcon kind={entry.kind} name={entry.name} sensitive={entry.sensitive} />
                    <div className="file-entry-copy"><strong>{entry.name}</strong><span>{entry.sensitive ? 'Revelado explícito' : entry.kind === 'directory' ? 'Carpeta' : entry.kind === 'symlink' ? 'Enlace bloqueado' : formatSize(entry.size)}</span></div>
                    <time>{entry.modified ? new Date(entry.modified * 1000).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }) : ''}</time>
                    {entry.kind === 'file' ? <span className="travel-file-open" aria-hidden="true">↗</span> : null}
                  </button>
                ))}
              </div>
              <footer>{directory?.truncated ? 'Listado limitado a 2.000 entradas.' : fileScope === 'management' ? 'Oculta assets científicos; “Todos” conserva acceso completo.' : 'Vista completa de la carpeta actual.'}</footer>
            </section>

            {viewerOpen ? <SplitDivider split={fileSplit} className="travel-resizer vertical files" label="Cambiar ancho de los archivos" paneLabel="los archivos" /> : null}

            {viewerOpen ? <section className="travel-viewer">
              <header><div><span>VISOR LOCAL</span><h3>{selectedFile?.name ?? 'Abriendo archivo'}</h3></div><div>{selectedFile ? <button onClick={openSelectedFile} disabled={fileOpening} type="button">{fileOpening ? 'Abriendo…' : 'Abrir con app ↗'}</button> : null}<button onClick={() => setSelectedFile(null)} disabled={fileLoading} type="button" aria-label="Cerrar visor">×</button></div></header>
              {fileLoading ? <div className="travel-panel-state">Abriendo archivo…</div> : null}
              {!fileLoading && !selectedFile ? <div className="travel-viewer-empty"><span>VIEW</span><h3>Documentos del viaje.</h3><p>PDF, imágenes y texto se previsualizan sin modificar el original. Otros formatos se abren de forma supervisada.</p></div> : null}
              {!fileLoading && selectedFile?.kind === 'text' ? <pre>{selectedFile.content}</pre> : null}
              {!fileLoading && selectedFile?.kind === 'image' && previewSource ? <div className="travel-preview image"><img src={previewSource} alt={`Vista previa de ${selectedFile.name}`} /></div> : null}
              {!fileLoading && selectedFile?.kind === 'pdf' && previewSource ? <div className="travel-preview pdf"><iframe src={previewSource} title={`Vista previa de ${selectedFile.name}`} /></div> : null}
              {!fileLoading && selectedFile?.kind === 'external' ? <div className="travel-viewer-empty"><span>APP</span><h3>Vista externa.</h3><p>Los formatos autorizados se abren con su aplicación; HTML, pases y otros formatos solo se muestran en el explorador de archivos.</p><button onClick={openSelectedFile} disabled={fileOpening} type="button">{fileOpening ? 'Abriendo…' : 'Abrir de forma segura ↗'}</button></div> : null}
              <footer><span>{selectedFile ? `${selectedFile.display_path} · ${formatSize(selectedFile.size)}` : 'TEXTO 2 MB · PDF/IMAGEN 25 MB'}</span><b>{selectedFile?.sensitive ? 'SENSIBLE · SOLO ESTA VISTA' : selectedFile ? 'SOLO LECTURA' : ''}</b></footer>
            </section> : null}
          </div>
            ) : null}
          </div>
        </main>
      </div>

      {error ? <div className="travel-error" role="alert"><strong>Viajes</strong><span>{error}</span><button onClick={() => setError(null)} type="button" aria-label="Cerrar error">×</button></div> : null}

      {newTravelOpen ? (
        <div className="travel-modal-backdrop" role="presentation">
          <section className="travel-modal" role="dialog" aria-modal="true" aria-label="Nuevo viaje">
            <header><div><span>NUEVO VIAJE</span><h3>{newTravelReview ? 'Revisar inicialización' : 'Inicializar el ciclo'}</h3></div><button onClick={() => setNewTravelOpen(false)} disabled={newTravelBusy} type="button" aria-label="Cerrar">×</button></header>
            {!newTravelReview ? (
              <form onSubmit={reviewNewTravel}>
                <label><span>NOMBRE / CARPETA *</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Ej.: Congreso 2026" autoFocus /></label>
                <label><span>DESTINO / EVENTO</span><input value={draft.destination} onChange={(event) => setDraft((current) => ({ ...current, destination: event.target.value }))} placeholder="Ciudad · conferencia" /></label>
                <div><label><span>IDA</span><input type="date" value={draft.start_date} onChange={(event) => setDraft((current) => ({ ...current, start_date: event.target.value }))} /></label><label><span>VUELTA</span><input type="date" value={draft.end_date} onChange={(event) => setDraft((current) => ({ ...current, end_date: event.target.value }))} /></label></div>
                <label><span>PROYECTO / FINANCIACIÓN</span><input value={draft.project} onChange={(event) => setDraft((current) => ({ ...current, project: event.target.value }))} placeholder="Opcional; sin datos bancarios" /></label>
                <footer><p>Primero verás exactamente qué carpeta y estructura se crearán.</p><button type="submit">Revisar →</button></footer>
              </form>
            ) : (
              <div className="travel-create-review">
                <span>SE CREARÁ</span><h4>Carpeta de viajes / {draft.name.trim()}</h4>
                <p>{draft.destination.trim() || 'Destino por definir'} · {draft.start_date || 'fechas por definir'}{draft.end_date ? ` → ${draft.end_date}` : ''}</p>
                <ul><li>VIAJE.md con checklist limpio</li><li>00_Planificacion · 01_Comision · 02_Adelanto</li><li>03_Reservas · 04_Justificantes · 05_Cierre</li></ul>
                <aside>No se copiarán documentos históricos, datos bancarios ni credenciales. No se enviará ningún formulario.</aside>
                <footer><button onClick={() => setNewTravelReview(false)} disabled={newTravelBusy} type="button">Volver</button><button className="primary" onClick={() => void createNewTravel()} disabled={newTravelBusy} type="button">{newTravelBusy ? 'Creando…' : 'Confirmar y crear'}</button></footer>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {sensitiveAction ? (
        <div className="travel-modal-backdrop" role="presentation">
          <section className="travel-confirm" role="dialog" aria-modal="true" aria-label="Revelar archivo sensible">
            <span>ARCHIVO SENSIBLE</span><h3>{sensitiveAction.entry.name}</h3><p>{sensitiveAction.mode === 'preview' ? 'El nombre o formato indica que podría contener datos bancarios, credenciales o claves. Solo se mostrará localmente y nunca se añadirá a Codex, al estado global ni a logs.' : 'Ya confirmaste su vista local. Abrirlo ahora entregará el archivo a su aplicación del sistema; Esprit no copiará su contenido.'}</p>
            <div><button onClick={() => setSensitiveAction(null)} disabled={fileLoading || fileOpening} type="button">Cancelar</button><button className="primary" onClick={() => sensitiveAction.mode === 'preview' ? void previewEntry(sensitiveAction.entry, true) : void openEntry(sensitiveAction.entry.id, true)} disabled={fileLoading || fileOpening} type="button">{sensitiveAction.mode === 'preview' ? fileLoading ? 'Revelando…' : 'Revelar en el visor' : fileOpening ? 'Abriendo…' : 'Confirmar apertura'}</button></div>
          </section>
        </div>
      ) : null}

      {pendingStep ? (
        <div className="travel-modal-backdrop" role="presentation">
          <section className="travel-confirm" role="dialog" aria-modal="true" aria-label="Confirmar cierre de viaje">
            <span>CIERRE ADMINISTRATIVO</span><h3>{closureReady ? '¿Está realmente cerrado?' : 'Aún faltan pasos anteriores'}</h3><p>{closureReady ? 'Confirma solo si la justificación fue aceptada y el reembolso o saldo quedó resuelto. El viaje pasará al historial.' : 'Completa la comisión, autorización, justificantes, formularios y envío online. El anticipo puede marcarse como “No aplica”.'}</p>
            <div><button onClick={() => setPendingStep(null)} disabled={stepBusy !== null} type="button">{closureReady ? 'Todavía no' : 'Entendido'}</button>{closureReady ? <button className="primary" onClick={() => void applyStepUpdate(pendingStep.step, pendingStep.state)} disabled={stepBusy !== null} type="button">{stepBusy ? 'Cerrando…' : 'Confirmar cierre'}</button> : null}</div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
