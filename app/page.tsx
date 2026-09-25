'use client';

import EspritHome from './EspritHome';
import ConfigPending from './components/ConfigPending';
import { AppConfigProvider, useAppConfigControls } from './appConfig';

/**
 * Primer render (y HTML exportado): un lienzo neutro mientras se lee la
 * configuración. El espacio de trabajo solo se monta con una configuración
 * válida; si falta o no es válida se explica cómo resolverlo.
 */
function ConfigGate() {
  const { config, reload, reloading } = useAppConfigControls();
  if (!config) {
    return (
      <main className="app-shell app-shell-loading" data-theme="light" data-palette="tinta" aria-busy="true">
        <aside className="sidebar" aria-hidden="true" />
        <section className="workspace" aria-label="Abriendo Esprit" />
      </main>
    );
  }
  if (config.status !== 'ok') return <ConfigPending config={config} busy={reloading} onRetry={() => void reload()} />;
  return <EspritHome />;
}

export default function Page() {
  return (
    <AppConfigProvider>
      <ConfigGate />
    </AppConfigProvider>
  );
}
