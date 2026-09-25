'use client';

import type { AppConfigPending } from '../appConfig';

/**
 * Pantalla completa cuando falta la configuración o no es válida. La app
 * arranca igualmente y explica cómo resolverlo sin tocar nada por su cuenta.
 */
export default function ConfigPending({ config, busy, onRetry }: { config: AppConfigPending; busy: boolean; onRetry: () => void }) {
  const missing = config.status === 'missing';
  return (
    <main className="app-shell config-pending-shell" data-theme="light" data-palette="tinta">
      <section className="config-pending" role="alertdialog" aria-labelledby="config-pending-title" aria-describedby="config-pending-help">
        <span className="config-pending-mark" aria-hidden="true">E</span>
        <p className="config-pending-eyebrow">ESPRIT</p>
        <h1 id="config-pending-title">Configuración pendiente</h1>
        <p className="config-pending-lead">
          {missing
            ? 'Esprit todavía no tiene un archivo de configuración. Cuando exista, esta pantalla dará paso a tu espacio de trabajo.'
            : 'Esprit ha encontrado el archivo de configuración, pero hay algo que corregir antes de abrir tu espacio de trabajo.'}
        </p>
        <dl className="config-pending-details">
          <div><dt>Archivo</dt><dd><code>{config.config_path}</code></dd></div>
          {config.error ? <div><dt>{missing ? 'Detalle' : 'Error'}</dt><dd>{config.error}</dd></div> : null}
        </dl>
        <div className="config-pending-help" id="config-pending-help">
          <strong>Cómo resolverlo</strong>
          <p>Abre Claude Code en la carpeta del repositorio de Esprit y dile «Configura Esprit». Claude te hará unas preguntas y preparará el archivo por ti.</p>
        </div>
        <button className="config-pending-retry" onClick={onRetry} disabled={busy} type="button">{busy ? 'Comprobando…' : 'Reintentar'}</button>
        {config.app_version ? <small className="config-pending-version">Esprit {config.app_version} · Creada por A.S. Gómez</small> : <small className="config-pending-version">Esprit · Creada por A.S. Gómez</small>}
      </section>
    </main>
  );
}
