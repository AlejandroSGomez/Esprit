'use client';

import { invoke } from '@tauri-apps/api/core';
import { createContext, createElement, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { isValidTimeZone } from './timeZone';

/**
 * Configuración que el lado nativo expone con `app_config`. La forma es un
 * contrato con Rust: no se renombran campos aquí. Nunca incluye rutas de
 * herramientas, credenciales ni datos del llavero.
 */
export type AppConfigProject = {
  slug: string;
  name: string;
  short_name: string;
  tag: string | null;
  has_github: boolean;
  has_library: boolean;
  has_cluster: boolean;
};

export type AppConfigMilestone = { title: string; date: string; meta: string | null };
export type AppConfigLink = { index: number; label: string; icon: string | null };
export type AppConfigMailAccount = { key: string; label: string; address: string };

export type AppConfigPending = {
  status: 'missing' | 'invalid';
  error: string;
  config_path: string;
  app_version: string;
};

export type AppConfigOk = {
  status: 'ok';
  config_path: string;
  app_version: string;
  user: { name: string; short_name: string; initials: string };
  time_zone: string;
  workspace: string;
  projects: AppConfigProject[];
  milestones: AppConfigMilestone[];
  links: AppConfigLink[];
  engines: { claude: boolean; codex: boolean };
  modules: {
    notes: { enabled: boolean };
    journal: { enabled: boolean };
    claude_connectors: { enabled: boolean; gmail: boolean; calendar: boolean };
    travel: { enabled: boolean };
    mail: { enabled: boolean; accounts: AppConfigMailAccount[] };
    calendar: { enabled: boolean; read: string[]; write: string[] };
    mattermost: { enabled: boolean; has_app: boolean };
    github: { enabled: boolean };
    library: { enabled: boolean };
    paper_radar: { enabled: boolean };
    cluster: { enabled: boolean; label: string; scheduler: 'slurm' | 'none'; has_jupyter: boolean };
    latex: { enabled: boolean };
    meetings: { enabled: boolean };
  };
  appearance: { palette: string; theme: 'light' | 'dark'; home_wallpaper: boolean };
};

export type AppConfig = AppConfigPending | AppConfigOk;

export const DEFAULT_CONFIG_PATH = '~/.config/esprit/config.json';

export const isNativeApp = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const systemTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

let activeTimeZone = 'UTC';

/**
 * Zona horaria configurada. Las utilidades fuera de React (formateadores de
 * fecha, notas nuevas) la leen aquí; el valor se actualiza al cargar o
 * recargar la configuración, antes de que se pinte el espacio de trabajo.
 */
export const getAppTimeZone = () => activeTimeZone;

const applyTimeZone = (config: AppConfig) => {
  if (config.status === 'ok' && isValidTimeZone(config.time_zone)) activeTimeZone = config.time_zone;
};

/**
 * Configuración de demostración para abrir la interfaz en un navegador
 * (`npm run dev`) sin la app nativa. Sigue `config/esprit.example.json`, con
 * todos los módulos activos para poder revisar cada espacio. Nunca se usa
 * dentro de Esprit.app.
 */
export const demoConfig = (): AppConfigOk => ({
  status: 'ok',
  config_path: DEFAULT_CONFIG_PATH,
  app_version: 'vista previa',
  user: { name: 'Ana Pérez', short_name: 'Ana', initials: 'AP' },
  time_zone: systemTimeZone(),
  workspace: '/Users/tu-usuario/Doctorado',
  projects: [
    { slug: 'tesis', name: 'Tesis doctoral', short_name: 'Tesis', tag: 'PRINCIPAL', has_github: true, has_library: true, has_cluster: true },
    { slug: 'articulo-1', name: 'Primer artículo', short_name: 'Artículo 1', tag: 'EN CURSO', has_github: false, has_library: false, has_cluster: false },
  ],
  milestones: [
    { title: 'Plan de investigación', date: '2026-11-15', meta: 'Doctorado · administración' },
  ],
  links: [
    { index: 0, label: 'Overleaf', icon: 'overleaf' },
    { index: 1, label: 'VS Code', icon: 'vscode' },
    { index: 2, label: 'Obsidian', icon: 'obsidian' },
  ],
  engines: { claude: true, codex: false },
  modules: {
    notes: { enabled: true },
    journal: { enabled: true },
    claude_connectors: { enabled: false, gmail: false, calendar: false },
    travel: { enabled: true },
    mail: { enabled: true, accounts: [{ key: 'm0', label: 'Universidad', address: 'ana.perez@ejemplo.org' }] },
    calendar: { enabled: true, read: ['Doctorado', 'Grupo'], write: ['Doctorado'] },
    mattermost: { enabled: true, has_app: true },
    github: { enabled: true },
    library: { enabled: true },
    paper_radar: { enabled: true },
    cluster: { enabled: true, label: 'Clúster', scheduler: 'slurm', has_jupyter: false },
    latex: { enabled: true },
    meetings: { enabled: true },
  },
  appearance: { palette: 'tinta', theme: 'light', home_wallpaper: false },
});

const pendingFromError = (error: unknown): AppConfigPending => ({
  status: 'invalid',
  error: String(error),
  config_path: DEFAULT_CONFIG_PATH,
  app_version: '',
});

/** Lee la configuración ya cargada por el lado nativo. */
export const loadAppConfig = async (): Promise<AppConfig> => {
  try {
    return await invoke<AppConfig>('app_config');
  } catch (error) {
    return pendingFromError(error);
  }
};

/** Pide al lado nativo que vuelva a leer y validar el archivo. */
export const reloadAppConfig = async (): Promise<AppConfig> => {
  try {
    return await invoke<AppConfig>('reload_app_config');
  } catch (error) {
    return pendingFromError(error);
  }
};

type AppConfigContextValue = {
  /** `null` mientras se lee por primera vez. */
  config: AppConfig | null;
  /** Vista previa en navegador con la configuración de demostración. */
  demo: boolean;
  reloading: boolean;
  /**
   * Vuelve a leer la configuración. Si la app ya funcionaba con una
   * configuración válida y la nueva no lo es, conserva la anterior en
   * pantalla (para no perder borradores abiertos) y devuelve el resultado
   * para que quien llama muestre el error.
   */
  reload: () => Promise<AppConfig>;
};

const AppConfigContext = createContext<AppConfigContextValue | null>(null);

export function AppConfigProvider({ children, initial }: { children?: ReactNode; initial?: AppConfig }) {
  const [config, setConfig] = useState<AppConfig | null>(() => {
    if (initial) applyTimeZone(initial);
    return initial ?? null;
  });
  const [demo, setDemo] = useState(false);
  const [reloading, setReloading] = useState(false);
  const configRef = useRef(config);
  useEffect(() => { configRef.current = config; }, [config]);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    const load = async () => {
      if (!isNativeApp()) {
        const preview = demoConfig();
        applyTimeZone(preview);
        if (!cancelled) { setDemo(true); setConfig(preview); }
        return;
      }
      const loaded = await loadAppConfig();
      applyTimeZone(loaded);
      if (!cancelled) setConfig(loaded);
    };
    void load();
    return () => { cancelled = true; };
  }, [initial]);

  const reload = useCallback(async () => {
    if (!isNativeApp()) {
      const preview = demoConfig();
      applyTimeZone(preview);
      setConfig(preview);
      return preview as AppConfig;
    }
    setReloading(true);
    try {
      const next = await reloadAppConfig();
      const current = configRef.current;
      if (next.status === 'ok' || current?.status !== 'ok') {
        applyTimeZone(next);
        setConfig(next);
      }
      return next;
    } finally {
      setReloading(false);
    }
  }, []);

  const value = useMemo(() => ({ config, demo, reloading, reload }), [config, demo, reloading, reload]);
  return createElement(AppConfigContext.Provider, { value }, children);
}

export function useAppConfigControls() {
  const value = useContext(AppConfigContext);
  if (!value) throw new Error('useAppConfigControls requiere AppConfigProvider.');
  return value;
}

/** Configuración válida del espacio de trabajo. Solo se usa bajo la pantalla principal. */
export function useAppConfig(): AppConfigOk {
  const { config } = useAppConfigControls();
  if (!config || config.status !== 'ok') throw new Error('La configuración de Esprit no está disponible.');
  return config;
}
