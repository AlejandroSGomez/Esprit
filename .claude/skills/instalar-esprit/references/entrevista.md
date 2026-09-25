# Entrevista de instalación

Cada ronda: **detecta** (solo lectura) → **propón** → **pregunta** con
AskUserQuestion → **resume** en una o dos líneas. Los límites de cada campo
están en `docs/CONFIGURACION.md`. En los ejemplos, `WS` es la ruta absoluta del
workspace y los textos entre `<…>` salen de la detección.

Forma de una llamada a AskUserQuestion (hasta cuatro preguntas):

```json
{
  "questions": [
    {
      "question": "¿Cómo quieres que Esprit te llame?",
      "header": "Nombre",
      "multiSelect": false,
      "options": [
        { "label": "Ana Pérez García (recomendado)", "description": "Nombre de tu cuenta de macOS. Nombre corto «Ana», iniciales «AP»." },
        { "label": "Ana Pérez", "description": "Nombre y primer apellido." }
      ]
    }
  ]
}
```

Una opción puede llevar `preview` (texto que se muestra al señalarla): úsalo
para enseñar muestras de color o ejemplos de configuración.

---

## Ronda 1 · Tú

Detecta:

```bash
id -F                                              # nombre completo de la cuenta de macOS
readlink /etc/localtime | sed 's|.*/zoneinfo/||'   # zona horaria, p. ej. Europe/Madrid
```

Propón `name` = nombre completo, `short_name` = la primera palabra, `initials`
= iniciales de las dos primeras palabras (máximo 3, en mayúsculas).

Pregunta (una llamada, dos preguntas):

- **Nombre** (`header: "Nombre"`): el nombre completo detectado (recomendado,
  con nombre corto e iniciales en la descripción) y una variante más corta. Si
  quiere otro nombre corto o iniciales, que lo escriba en «Otro».
- **Zona horaria** (`header: "Zona"`): la detectada (recomendado) y una o dos
  plausibles. Comprueba la elegida con `test -f /usr/share/zoneinfo/<zona>`.

## Ronda 2 · Carpeta del doctorado

Explica en dos líneas: el workspace es la carpeta raíz donde viven sus
proyectos. Esprit crea dentro `Esprit/` (estado global, perfil del Radar,
historiales), lee los `STATE.md` de los proyectos y solo escribe cuando el
usuario confirma algo en la app.

Avisa antes: al buscar en Documentos o Escritorio, macOS puede preguntar si la
Terminal puede acceder a esas carpetas. Puede aceptar o denegar y decirte la
ruta.

Detecta candidatos (solo nombres):

```bash
find "$HOME" -maxdepth 3 -type d \( -iname '*doctorado*' -o -iname '*phd*' -o -iname '*tesis*' \
  -o -iname '*thesis*' -o -iname '*investigaci*' -o -iname '*research*' \) \
  -not -path "$HOME/Library/*" -not -path '*/.*' -not -path '*/node_modules/*' 2>/dev/null | head -20
ls -d "$HOME/Library/Mobile Documents/com~apple~CloudDocs"/*/ 2>/dev/null | head -40   # iCloud Drive
ls -d "$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents"/*/ 2>/dev/null     # bóvedas de Obsidian en iCloud
```

Recomienda el candidato con más subcarpetas que parezcan proyectos (repos git,
`STATE.md`, `.tex`). Si no hay ninguno, recomienda crear `~/Doctorado`.

Pregunta (`header: "Carpeta"`): hasta tres candidatos y «Crear ~/Doctorado».

Comprueba la elegida:

- `test -L "<ruta>"` → si es un enlace simbólico, usa la ruta real
  (`/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "<ruta>"`).
  La configuración exige un directorio real.
- Si está en iCloud Drive, sirve, pero explícale dos cosas: que marque la
  carpeta como «Mantener descargado» (clic derecho en Finder) para que Esprit
  no se encuentre archivos sin descargar, y que editar `Esprit/STATE.md` desde
  dos Macs a la vez puede crear copias en conflicto.
- Si tiene `CLAUDE.md` o `AGENTS.md` propios, léelos: son sus normas y debes
  respetarlas.
- Si hay que crearla: `mkdir -p "$HOME/Doctorado"` (tras su sí).

## Ronda 3 · Proyectos

Detecta las carpetas de primer nivel y, si una carpeta agrupa proyectos
(`Proyectos`, `Projects`, `Research`… o contiene varias subcarpetas con `.git`
o `STATE.md`), sus hijas:

```bash
WS="<workspace>"
for d in "$WS"/*/ "$WS"/*/*/; do
  [ -d "$d" ] || continue
  rel="${d#$WS/}"; rel="${rel%/}"
  case "$rel" in Esprit|Esprit/*|.*) continue ;; esac
  remote=$(git -C "$d" remote get-url origin 2>/dev/null)
  state=$([ -f "$d/STATE.md" ] && echo STATE || echo -)
  readme=$([ -f "$d/README.md" ] && echo README || echo -)
  tex=$(find "$d" -maxdepth 2 -name '*.tex' 2>/dev/null | head -1)
  printf '%s\t%s\t%s\t%s\t%s\n' "$rel" "${remote:--}" "$state" "$readme" "${tex:+tex}"
done
```

Descarta subcarpetas internas obvias (`src`, `data`, `figures`, `notebooks`…).
Para cada candidato propone:

- `slug`: minúsculas sin acentos, espacios y símbolos → guiones, máximo 48,
  único, nunca `general` (por ejemplo «Artículo 1» → `articulo-1`).
- `name` (≤ 80) y `short_name` (≤ 28).
- `tag` (≤ 28, en mayúsculas): `PRINCIPAL`, `EN CURSO`, `EXPLORATORIO`,
  `EN PAUSA`, `ARTÍCULO`, `DOCENCIA`…
- `github_repos`: de un remoto `github.com[:/]<propietario>/<repo>(.git)` →
  `<propietario>/<repo>`.
- Un `resumen` y un `siguiente` de una frase para el estado global, a partir de
  las primeras líneas del `README.md` o `STATE.md` del proyecto (léelas solo de
  los proyectos elegidos). Si no hay de dónde sacarlo: «Por definir en el primer
  Logout.».

Enséñale una tabla (Carpeta · GitHub · STATE.md · propuesta de slug, nombre y
etiqueta) y pregunta:

- **Proyectos** (`multiSelect: true`): qué carpetas son proyectos. Con más de
  cuatro candidatos, reparte en varias preguntas de la misma llamada
  («Proyectos 1/2», «Proyectos 2/2»). Máximo 24 proyectos.
- **Principal** (single): cuál es el principal (etiqueta `PRINCIPAL`).
- **Estado** (`multiSelect: true`, opcional): «¿Alguno está en pausa o esperando
  a alguien?» → `Estado: pausado` o `esperando` en el estado global; el resto,
  `activo`.

Si no hay ningún proyecto, propón crear `Proyectos/Tesis` (u otro nombre que
diga). El estado global necesita al menos un proyecto.

## Ronda 4 · Módulos

Detecta, sin provocar avisos de macOS:

```bash
gh auth status --hostname github.com >/dev/null 2>&1 && echo "gh con sesión"
awk 'tolower($1)=="host"{for(i=2;i<=NF;i++) print $i}' ~/.ssh/config 2>/dev/null | grep -v '[*?]' | grep -viE '^(github\.com|gitlab\.com|bitbucket\.org)$'
ls -d /Applications/Mattermost.app 2>/dev/null
test -x /Library/TeX/texbin/latexmk && echo latexmk
find "$WS" -maxdepth 4 \( -iname '*.pdf' -o -iname '*.bib' \) -not -path '*/.*' 2>/dev/null | head -200 | wc -l
ls -d "$WS"/{Biblioteca,Bib,Library,Papers,Referencias,Bibliografia,Bibliografía} 2>/dev/null
```

No consultes todavía Calendario ni Mail (eso provoca el aviso de
Automatización): recomienda Calendario casi siempre y pregunta si usa Mail.app.

Pregunta (una llamada, tres preguntas; marca «(recomendado)» según lo
detectado):

- **Comunicación** (`multiSelect: true`): Calendario (Calendar.app, lee y crea
  eventos confirmados) · Correo (Mail.app, lee y envía con confirmación; sin
  guardar credenciales) · Mattermost · GitHub (actividad y notificaciones de los
  repos de sus proyectos, con `gh`).
- **Investigación** (`multiSelect: true`): Biblioteca de PDFs · Radar de arXiv
  (necesita Biblioteca) · Clúster por SSH · LaTeX (compilar desde Esprit, con
  `latexmk`).
- **Reuniones** (single): «Sí (recomendado)» — notas de reuniones por proyecto
  en `docs/esprit/` — o «No».

Consecuencias que debes explicar si aplican: el Radar activa la Biblioteca;
GitHub sin sesión de `gh` necesita que el usuario ejecute `gh auth login --web`;
LaTeX sin `latexmk` necesita MacTeX (`brew install --cask mactex-no-gui`, unos
5 GB, lo ejecuta el usuario) o se deja para más tarde.

## Ronda 5 · Detalles de cada módulo activado

### Calendario

Avisa: «Voy a pedir a Calendario solo los nombres de tus calendarios. macOS te
preguntará si la Terminal (o la app desde la que usas Claude) puede controlar
Calendario: pulsa Aceptar».

```bash
osascript -l JavaScript -e 'const c = Application("Calendar"); JSON.stringify(c.calendars().map(k => ({name: k.name(), writable: k.writable()})))'
```

- Error `-1743` o «Not authorized»: permiso denegado. Puede activarlo en Ajustes
  del Sistema → Privacidad y seguridad → Automatización, o escribirte los
  nombres a mano.
- Quita duplicados por nombre (algunas cuentas aparecen dos veces).

Pregunta:

- **Leer** (`multiSelect: true`, máximo 8): qué calendarios verá Esprit.
- **Escribir** (single): dónde puede crear eventos el Logout. Opciones: los
  calendarios `writable` que haya elegido para leer; «Crear un calendario
  “Doctorado” (recomendado)» si no tiene uno propio; «Ninguno». Para crearlo,
  que lo haga él en Calendario → Archivo → Nuevo calendario, eligiendo la cuenta
  (iCloud o Google, para verlo también en el móvil); después vuelve a listar.
  `write` ⊆ `read`, máximo 4. Los calendarios compartidos del grupo conviene
  dejarlos solo de lectura.

### Correo

Avisa del mismo modo para Mail. Las cuentas deben estar ya configuradas en
Mail.app.

```bash
osascript -l JavaScript -e 'const m = Application("Mail"); JSON.stringify(m.accounts().map(a => ({name: a.name(), addresses: a.emailAddresses(), enabled: a.enabled()})))'
```

Pregunta (`multiSelect: true`, máximo 4) qué cuentas quiere en Esprit. Para cada
una: `mail_account` = el nombre exacto de la cuenta, `address` = su dirección
(si tiene varias, pregunta cuál), `label` corto propuesto («Universidad» para un
dominio académico, «Personal» para Gmail o iCloud).

### Mattermost

Pide en el chat la dirección que usa en el navegador, por ejemplo
`https://chat.ejemplo.org/mi-equipo/channels/town-square` → `server` =
`https://chat.ejemplo.org`, `team` = `mi-equipo`. Pide su nombre de usuario (sin
`@`). Comprueba que el servidor responde (sin credenciales):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "https://chat.ejemplo.org/api/v4/system/ping"   # 200 = bien
```

Pregunta (single, `header: "Acceso"`):

- «Tengo un token de acceso personal (recomendado)» → `auth: "token"`.
- «Entro con usuario y contraseña» → `auth: "password"`.
- «Entro con Google, GitLab, SSO o verificación en dos pasos» → necesita un
  token: Perfil → Seguridad → Tokens de acceso personal. Si no aparece, el
  administrador tiene que habilitarlos; mientras tanto, deja Mattermost
  desactivado.

Y (single) «Todos los canales en los que estás (recomendado)» → `channels: []`,
o «Solo algunos» → pide los nombres de canal de la URL (no el nombre visible).
`keychain_service`: `esprit-mattermost`. `app`: `Mattermost` si existe
`/Applications/Mattermost.app`; si no, `null`.

**El secreto** (contraseña o token) nunca pasa por el chat. Dile exactamente:

> Abre la app Terminal (no este chat) y ejecuta:
> `security add-generic-password -U -s esprit-mattermost -a <usuario> -w`
> Te pedirá el secreto dos veces; pégalo y pulsa Intro. No se verá nada mientras
> escribes: es normal.

Después comprueba que existe, sin leerlo:

```bash
security find-generic-password -s esprit-mattermost -a "<usuario>" >/dev/null 2>&1 && echo "Guardado en el llavero"
```

Nunca ejecutes `find-generic-password` con `-w`.

### Clúster

Pregunta (single) qué alias de `~/.ssh/config` usar (hasta tres detectados y
«Ninguno por ahora»). Revisa también los archivos que incluya con `Include`.
Con su permiso (se conecta al servidor, solo lee), prueba exactamente como lo
hará Esprit:

```bash
/usr/bin/ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 \
  -o PreferredAuthentications=publickey -o PasswordAuthentication=no \
  -o KbdInteractiveAuthentication=no <alias> \
  'printf "%s\n" "$HOME"; command -v squeue >/dev/null && echo slurm || echo none'
```

- Primera línea → `remote_home`; segunda → `scheduler`.
- Si falla: ¿hace falta VPN? ¿la clave no está en el servidor (`ssh-copy-id
  <alias>`, lo ejecuta el usuario)? ¿la clave tiene frase y no está en el agente
  (`ssh-add --apple-use-keychain ~/.ssh/id_ed25519`, lo ejecuta el usuario)?
  Esprit solo usa clave pública, nunca contraseña.
- `label`: corto («Clúster», o el nombre del centro).
- `cluster_dir` por proyecto (opcional): con su permiso, `ssh … <alias> 'ls -d
  */'` y propone coincidencias por nombre; rutas relativas a `remote_home`.
- `jupyter_url`: solo si menciona un JupyterHub (`https://…`).

### Biblioteca

- `folder`: la carpeta detectada (`Biblioteca`, `Bib`, `Papers`…) o crear
  `Biblioteca`. Esprit lee los PDF de ahí y solo añade uno nuevo cuando el
  usuario lo confirma desde el Radar; nunca mueve ni borra los existentes sin
  confirmación.
- `library_collection` por proyecto: propone el `short_name` sin `/` (máximo
  60). Las subcarpetas se crean en la fase 5.

### Radar de arXiv y perfil de investigación

1. Lee con moderación lo que describe cada proyecto elegido: las primeras
   líneas de `README.md` y `STATE.md`, y el `\title{…}` y el resumen del `.tex`
   principal si lo hay.
2. Pregunta en el chat: «En dos o tres frases: ¿qué investigas, con qué métodos
   y qué tipo de artículo te gustaría que Esprit te avisara? ¿Qué temas
   parecidos no te interesan?».
3. Propón hasta 8 `arxiv_categories` (identificadores reales como `cs.LG`,
   `stat.ML`, `math.AP`, `q-bio.NC`, `astro-ph.GA`, `cond-mat.soft`, `econ.EM`)
   y hasta 40 `keywords` concretas (2–80 caracteres; mejor frases específicas
   que palabras sueltas).
4. Pregunta **Categorías** (`multiSelect: true`, las recomendadas primero) y
   «¿Te valen estas palabras clave?» («Sí (recomendado)» / «Quiero cambiar
   algunas»).
5. Redacta el perfil con `templates/workspace/Esprit/perfil-investigacion.md`
   (se escribe en la fase 5) y enséñaselo. `profile` =
   `Esprit/perfil-investigacion.md`.

Explica: el Radar se ejecuta tras cada Login, recomienda de cero a dos
artículos, y descartar con un motivo le ayuda a afinar. Si su campo apenas
publica en arXiv, recomienda dejar el Radar desactivado.

### Viajes UAM

Pregunta si quiere organizar viajes de la UAM. Es opcional: conserva los enlaces
institucionales y el ciclo de nueve etapas, pero cada persona empieza con sus
propios expedientes. Usa `modules.travel.enabled` y una carpeta relativa elegida
(`Viajes` por defecto); no importes información del autor.

Antes de configurar Clúster, explica: «Puedo ayudarte a conectarlo, pero cada
centro tiene sus requisitos; podemos hacerlo ahora o dejarlo para después».
No des por hecho VPN, nombre del host, SLURM ni permisos. Si no se puede verificar
el acceso, mantén el módulo desactivado y documenta qué falta.

## Ronda 6 · Accesos directos (ABRIR)

Detecta:

```bash
ls /Applications /System/Applications "$HOME/Applications" 2>/dev/null | sed -n 's/\.app$//p' | \
  grep -xiE 'Visual Studio Code|Cursor|Obsidian|Zotero|Notion|Slack|Mattermost|ChatGPT|Claude|Microsoft Teams|Microsoft Word|Mendeley Reference Manager|Texifier|TeXShop|Skim|Zoom|RStudio|Mathematica|MATLAB.*|Julia.*'
cat "$HOME/Library/Application Support/obsidian/obsidian.json" 2>/dev/null   # bóvedas de Obsidian (rutas)
test -d "$WS/.obsidian" && echo "el workspace es una bóveda de Obsidian"
```

Propón hasta 12 enlaces, cada uno con `url` **o** `app`:

- Apps detectadas → `{"label": "Zotero", "app": "Zotero", "icon": "zotero"}`.
- VS Code con el workspace abierto → `"url": "vscode://file/<WS con espacios como %20>"`,
  `"icon": "vscode"`.
- Obsidian → `"url": "obsidian://open?vault=<nombre codificado>"`.
- Web: Overleaf (`https://www.overleaf.com/project`), GitHub
  (`https://github.com/<login de gh>`), Google Scholar
  (`https://scholar.google.com`), arXiv de su categoría principal
  (`https://arxiv.org/list/<categoría>/new`), Google Drive
  (`https://drive.google.com`) y la intranet o campus virtual de su universidad
  (pide la URL).
- `icon` solo de la lista incluida (`overleaf`, `vscode`, `obsidian`,
  `mattermost`, `chatgpt`, `zotero`, `github`, `drive`, `notion`, `slack`); si no
  encaja, `null` (se ve la inicial). `label` ≤ 32.

Pregunta en una llamada: **Apps** (`multiSelect: true`) y **Web**
(`multiSelect: true`). El orden de la configuración es el orden de la barra
lateral.

## Ronda 7 · Apariencia

Lee las paletas del código en este momento (pueden haber cambiado):

```bash
/usr/bin/python3 scripts/check_contrast.py              # id y nombre de cada paleta
grep -n "swatches" app/components/SettingsSpace.tsx     # colores de muestra de cada paleta
/usr/bin/python3 scripts/check_contrast.py --all --html "${TMPDIR:-/tmp}/esprit-paletas.html" \
  && open "${TMPDIR:-/tmp}/esprit-paletas.html"         # vista previa real en el navegador
```

La paleta por defecto es «Papel y tinta» (`tinta`). Pregunta (una llamada):

- **Paleta** (single): cuatro paletas, `tinta` primero (recomendado), cada una
  con un `preview` como este:

  ```
  Papel y tinta · tinta
  #14255f  barra lateral
  #233f8b  acento principal
  #b9c6dc  realce suave
  #c96f4d  acento cálido
  #f2e2c9  papel
  ```

  En el texto de la pregunta menciona que la quinta paleta, o una a medida, se
  eligen en «Otro», y que la vista previa está abierta en el navegador.
- **Tema** (single): «Claro (recomendado)» / «Oscuro». Se cambia cuando quiera
  con el interruptor de la barra superior.
- **Fondo** (single): «Sin imagen (recomendado)» / «Usar una imagen mía».
- **Icono** (single): «Icono de Esprit (recomendado)» / «Hacer uno con una
  imagen mía».

Si elige:

- **Fondo propio** — pide la ruta de la imagen (una tranquila y poco contrastada
  funciona mejor: se muestra tenue). Antes de compilar:
  `mkdir -p public/custom && sips -s format png -Z 2400 "<imagen>" --out public/custom/home-wallpaper.png`
  y `appearance.home_wallpaper: true`. `public/custom/` no se versiona, así que
  las actualizaciones no la tocan.
- **Icono propio** — una imagen cuadrada de al menos 1024 px (PNG, mejor con
  fondo transparente). Si no es cuadrada, recórtala al centro con `sips -c
  <lado> <lado>`. Antes de compilar, en la rama `mi-esprit`:
  `npx tauri icon "<imagen.png>"` (regenera `src-tauri/icons/`).
- **Paleta a medida** — es un cambio de código: propón hacerlo después de la
  primera instalación con la habilidad `personalizar-esprit`, salvo que insista.

`appearance.palette` es solo la paleta inicial: desde Configuración puede
cambiarla, y esa elección se recuerda en su Mac.

## Ronda 8 · Motores de IA e hitos

- Claude Code es obligatorio (`tools.claude`). Los rituales usan por defecto
  Claude Opus con esfuerzo alto; se cambia en Configuración → Rituales.
- Solo si `codex` está instalado, pregunta (single): «Solo Claude
  (recomendado)» / «Claude y Codex». Si no, `tools.codex: null` sin preguntar.
- **Hitos** (single): «No por ahora (recomendado)» / «Sí, te digo cuáles».
  Ejemplos que puedes sugerir: plan de investigación anual, depósito de la
  tesis, fin del contrato o la beca, un congreso, una estancia. Cada uno:
  `title` (≤ 80), `date` (AAAA-MM-DD), `meta` opcional (≤ 60). Máximo 12.
