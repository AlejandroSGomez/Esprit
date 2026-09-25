# Mi doctorado · guía para Claude

Esta carpeta es el workspace de mi doctorado y la usa **Esprit**, mi app local
para organizar el día (creada por A.S. Gómez). Responde siempre en español.

## Proyectos

| Slug | Carpeta |
|---|---|
{{TABLA_PROYECTOS}}

Antes de trabajar en un proyecto, lee su `STATE.md` y, si existen, su
`CLAUDE.md` o `AGENTS.md` y su `README.md`.

## Archivos de Esprit

- `Esprit/STATE.md` — estado global del doctorado. Tiene un formato estricto en
  español que Esprit lee (Foco, Radar de proyectos, No olvidar, Esperando a…).
  **Lo actualiza el Logout de Esprit. No lo edites a mano salvo que te lo pida
  expresamente**; si te lo pido, conserva exactamente el formato descrito en
  `{{SOURCE_REPO}}/docs/ESTADO_GLOBAL.md` y enséñame el cambio antes de guardarlo.
- `Esprit/perfil-investigacion.md` — lo que el Radar de lectura considera
  relevante. Puedes ayudarme a mejorarlo cuando cambien mis prioridades.
- `Esprit/login-history.json`, `Esprit/logout-history.json` y
  `.esprit-paper-radar.json` (en la biblioteca) — los genera la app. No los edites.
- `<proyecto>/STATE.md` — estado de cada proyecto, formato libre. Puedes
  proponerme actualizaciones; aplícalas cuando las confirme.
- `<proyecto>/docs/esprit/` — notas y reuniones guardadas desde Esprit.
- `.claude/skills/esprit-login/` y `.claude/skills/esprit-logout/` — las
  habilidades de los rituales. Son copias del repositorio de Esprit: para
  actualizarlas, pídelo desde el repositorio (`{{SOURCE_REPO}}`).

## Rituales

- **Login** (al empezar el día): Esprit lanza `/esprit-login` en esta carpeta,
  en solo lectura, y prepara un briefing con el estado, el correo, el calendario,
  Mattermost y GitHub (los que tenga configurados).
- **Logout** (al terminar): `/esprit-logout` reconstruye el día, me hace unas
  preguntas y propone el nuevo `Esprit/STATE.md` y los eventos de calendario.
  Solo Esprit escribe, y solo después de que yo lo confirme.

## Esprit en sí

- Configuración: `~/.config/esprit/config.json` (nunca contiene contraseñas).
- Código fuente: `{{SOURCE_REPO}}`. Para cambiar la app (módulos, proyectos,
  colores, funciones nuevas) abre Claude Code en esa carpeta y pídelo: allí está
  la habilidad `personalizar-esprit`.

## Normas

- No guardes contraseñas, tokens ni claves en ningún archivo.
- No recorras carpetas grandes o generadas (`results/`, `data/`, `figures/`,
  `logs/`, `archive/`, `node_modules/`, `.git/`) salvo que haga falta.
- No envíes correos ni mensajes, ni crees eventos, sin mi confirmación explícita.
