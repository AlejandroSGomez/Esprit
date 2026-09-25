'use client';

import { useAppConfig } from '../appConfig';

export type AppearancePalette = 'tinta' | 'forest' | 'eucalyptus' | 'indigo' | 'atlantic';
export type AppearanceTextSize = 'small' | 'comfortable' | 'large';

export const appearancePalettes: Array<{
  id: AppearancePalette;
  label: string;
  note: string;
  swatches: string[];
}> = [
  {
    id: 'tinta',
    label: 'Papel y tinta',
    note: 'Papel cálido, índigo dibujado y un acento coral.',
    swatches: ['#14255f', '#233f8b', '#b9c6dc', '#c96f4d', '#f2e2c9'],
  },
  {
    id: 'forest',
    label: 'Bosque y arcilla',
    note: 'Orgánica, cálida y editorial.',
    swatches: ['#1f2925', '#315b4e', '#afc2b6', '#a74634', '#f3f0e8'],
  },
  {
    id: 'eucalyptus',
    label: 'Ciruela y eucalipto',
    note: 'Suave, botánica y tranquila.',
    swatches: ['#28112b', '#453643', '#788475', '#8daa91', '#f4f1ed'],
  },
  {
    id: 'indigo',
    label: 'Índigo y latón',
    note: 'Más académica, nítida y nocturna.',
    swatches: ['#20263a', '#425a85', '#b8c2d8', '#b47b2f', '#f4f1e9'],
  },
  {
    id: 'atlantic',
    label: 'Atlántico y cobre',
    note: 'Fresca, técnica y con acento cálido.',
    swatches: ['#193536', '#2e6968', '#a9c5c0', '#b85d43', '#f3efe7'],
  },
];

export const isAppearancePalette = (value: string | null): value is AppearancePalette => (
  appearancePalettes.some((palette) => palette.id === value)
);

export const isAppearanceTextSize = (value: string | null): value is AppearanceTextSize => (
  value === 'small' || value === 'comfortable' || value === 'large'
);

type SettingsSpaceProps = {
  theme: 'light' | 'dark';
  palette: AppearancePalette;
  textSize: AppearanceTextSize;
  showHiddenFiles: boolean;
  onThemeChange: (theme: 'light' | 'dark') => void;
  onPaletteChange: (palette: AppearancePalette) => void;
  onTextSizeChange: (size: AppearanceTextSize) => void;
  onShowHiddenFilesChange: (show: boolean) => void;
  onOpenSource: () => void;
  onRevealApp: () => void;
  onOpenWorkspace: () => void;
  onReset: () => void;
  /** Solo para mostrar: el lado nativo resuelve cada destino por su nombre. */
  workspacePath: string;
  configPath: string;
  appVersion: string;
  configReloading: boolean;
  onOpenConfig: () => void;
  onReloadConfig: () => void;
  /** Modelo y razonamiento de Login, Logout y el radar de papers. */
  ritualModel: string;
  ritualEffort: string;
  /** Catálogo de modelos de rituales, el mismo que valida el lado nativo. */
  ritualModels: Array<{ value: string; label: string; note: string; efforts: string[] }>;
  onRitualModelChange: (model: string) => void;
  onRitualEffortChange: (effort: string) => void;
};

const textSizes: Array<{ id: AppearanceTextSize; label: string; sample: string }> = [
  { id: 'small', label: 'Pequeño', sample: 'Aa' },
  { id: 'comfortable', label: 'Normal', sample: 'Aa' },
  { id: 'large', label: 'Grande', sample: 'Aa' },
];

const effortLabels: Record<string, string> = {
  low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Extra-high', max: 'Máximo', ultra: 'Ultra',
};

export default function SettingsSpace({
  ritualModel,
  ritualEffort,
  ritualModels,
  onRitualModelChange,
  onRitualEffortChange,
  theme,
  palette,
  textSize,
  showHiddenFiles,
  onThemeChange,
  onPaletteChange,
  onTextSizeChange,
  onShowHiddenFilesChange,
  onOpenSource,
  onRevealApp,
  onOpenWorkspace,
  onReset,
  workspacePath,
  configPath,
  appVersion,
  configReloading,
  onOpenConfig,
  onReloadConfig,
}: SettingsSpaceProps) {
  const config = useAppConfig();
  const selectedPalette = appearancePalettes.find((item) => item.id === palette) ?? appearancePalettes[0];

  return (
    <div className="settings-space">
      <aside className="settings-rail">
        <div className="settings-intro">
          <span>CONFIGURACIÓN LOCAL</span>
          <h3>Esprit a tu manera.</h3>
          <p>La apariencia cambia al instante y queda guardada únicamente en este Mac.</p>
        </div>

        <fieldset className="settings-control-group">
          <legend>MODO</legend>
          <div className="settings-segmented" role="group" aria-label="Modo de color">
            <button className={theme === 'light' ? 'active' : ''} onClick={() => onThemeChange('light')} type="button" aria-pressed={theme === 'light'}><i>☼</i> Claro</button>
            <button className={theme === 'dark' ? 'active' : ''} onClick={() => onThemeChange('dark')} type="button" aria-pressed={theme === 'dark'}><i>☾</i> Oscuro</button>
          </div>
        </fieldset>

        <fieldset className="settings-control-group">
          <legend>TAMAÑO DEL TEXTO</legend>
          <div className="settings-text-sizes" role="group" aria-label="Tamaño del texto">
            {textSizes.map((option) => (
              <button className={textSize === option.id ? `active ${option.id}` : option.id} onClick={() => onTextSizeChange(option.id)} type="button" aria-pressed={textSize === option.id} key={option.id}>
                <b>{option.sample}</b><span>{option.label}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <div className="settings-current">
          <span>ESTILO ACTIVO</span>
          <strong>{selectedPalette.label}</strong>
          <small>{theme === 'dark' ? 'Oscuro' : 'Claro'} · texto {textSizes.find((item) => item.id === textSize)?.label.toLocaleLowerCase('es')}</small>
        </div>

        <button className="settings-reset" onClick={onReset} type="button">Restaurar estilo inicial ↺</button>
      </aside>

      <section className="settings-main">
        <section className="settings-palette-section">
          <header><div><span>COLOR</span><h3>Paleta visual</h3></div><p>¿Quieres otra paleta, un fondo propio en Inicio o un icono distinto? Pídeselo a Claude.</p></header>
          <div className="settings-palettes" role="radiogroup" aria-label="Paleta visual">
            {appearancePalettes.map((option) => (
              <button className={palette === option.id ? 'active' : ''} onClick={() => onPaletteChange(option.id)} type="button" role="radio" aria-checked={palette === option.id} key={option.id}>
                <span className="settings-swatches" aria-hidden="true">
                  {option.swatches.map((color) => <i style={{ background: color }} key={color} />)}
                </span>
                <span className="settings-palette-copy"><strong>{option.label}</strong><small>{option.note}</small></span>
                <b aria-hidden="true">{palette === option.id ? '✓' : '↗'}</b>
              </button>
            ))}
          </div>
        </section>

        {config?.status === 'ok' && config.modules.claude_connectors.enabled && <section className="settings-ritual-section">
          <header><div><span>FUENTES DE LOS RITUALES</span><h3>Conectores de Claude</h3></div></header>
          <p>{[config.modules.claude_connectors.gmail && 'Gmail', config.modules.claude_connectors.calendar && 'Google Calendar'].filter(Boolean).join(' y ')} se consultan al iniciar Login o Logout. Esta beta solo lee; no envía correos ni modifica eventos.</p>
          <p>El reenvío desde Outlook cubre los nuevos mensajes recibidos que lleguen a Gmail. No incluye el historial anterior ni los enviados desde Outlook. La conexión se comprueba durante el ritual.</p>
        </section>}

        <section className="settings-ritual-section">
          <header>
            <div><span>RITUALES</span><h3>Login, Logout y radar</h3></div>
            <p>Estos tres corren solos y con validación estructurada; puedes darles más esfuerzo sin encarecer cada conversación del chat.</p>
          </header>
          {ritualModels.length === 0 ? (
            <p className="settings-ritual-empty">El catálogo de modelos aún no está disponible; los rituales usan el perfil guardado.</p>
          ) : null}
          <div className="settings-ritual-models" role="radiogroup" aria-label="Modelo de los rituales">
            {ritualModels.map((option) => (
              <button
                className={ritualModel === option.value ? 'active' : ''}
                onClick={() => onRitualModelChange(option.value)}
                type="button"
                role="radio"
                aria-checked={ritualModel === option.value}
                key={option.value}
              >
                <span><strong>{option.label}</strong><small>{option.note}</small></span>
                <b aria-hidden="true">{ritualModel === option.value ? '✓' : ''}</b>
              </button>
            ))}
          </div>
          <div className="settings-ritual-efforts" role="radiogroup" aria-label="Razonamiento de los rituales">
            {(ritualModels.find((option) => option.value === ritualModel)?.efforts ?? []).map((value) => (
              <button
                className={ritualEffort === value ? 'active' : ''}
                onClick={() => onRitualEffortChange(value)}
                type="button"
                role="radio"
                aria-checked={ritualEffort === value}
                key={value}
              >
                {effortLabels[value] ?? value}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-local-section">
          <header><div><span>ESPRIT LOCAL</span><h3>Carpetas y aplicación</h3></div><p>Destinos fijos y seguros; no se aceptan rutas escritas desde la interfaz.</p></header>
          <div className="settings-local-actions">
            <button onClick={onOpenWorkspace} type="button"><i>01</i><span><strong>Carpeta del doctorado</strong><small title={workspacePath}>{workspacePath || 'Proyectos, biblioteca y estado global'}</small></span><b>Finder ↗</b></button>
            <button onClick={onOpenSource} type="button"><i>02</i><span><strong>Código de Esprit</strong><small>Código, documentación y recursos de la app</small></span><b>Finder ↗</b></button>
            <button onClick={onRevealApp} type="button"><i>03</i><span><strong>Esprit.app instalada</strong><small>Mostrar la aplicación dentro de Aplicaciones</small></span><b>Mostrar ↗</b></button>
          </div>
          <label className="settings-switch-row">
            <span><strong>Archivos ocultos</strong><small>Ocultos por defecto en Proyectos; actívalos solo cuando los necesites.</small></span>
            <input checked={showHiddenFiles} onChange={(event) => onShowHiddenFilesChange(event.target.checked)} type="checkbox" />
            <i aria-hidden="true" />
          </label>
          <footer><i /><span>Preferencias locales · sin credenciales · el chat cotidiano mantiene su propio selector</span></footer>
        </section>

        <section className="settings-local-section settings-config-section">
          <header><div><span>CONFIGURACIÓN</span><h3>Archivo de configuración</h3></div><p>Proyectos, módulos, calendarios y enlaces viven en este archivo. Tras editarlo, recárgalo aquí.</p></header>
          <p className="settings-config-path"><code title={configPath}>{configPath}</code></p>
          <div className="settings-config-actions">
            <button onClick={onOpenConfig} type="button">Abrir configuración ↗</button>
            <button onClick={onReloadConfig} disabled={configReloading} type="button">{configReloading ? 'Recargando…' : 'Recargar configuración ↻'}</button>
          </div>
        </section>

        <section className="settings-local-section settings-about-section" aria-labelledby="settings-about-title">
          <header><div><span>ACERCA DE</span><h3 id="settings-about-title">Acerca de Esprit</h3></div></header>
          <dl className="settings-about">
            <div><dt>Aplicación</dt><dd>Esprit</dd></div>
            <div><dt>Versión</dt><dd>{appVersion || '—'}</dd></div>
            <div><dt>Autoría</dt><dd>Creada por A.S. Gómez</dd></div>
          </dl>
          <p className="settings-about-note">Esprit está pensada para personalizarse: colores, fondo, icono o espacios nuevos. Pídele a Claude los cambios que quieras.</p>
        </section>
      </section>
    </div>
  );
}
