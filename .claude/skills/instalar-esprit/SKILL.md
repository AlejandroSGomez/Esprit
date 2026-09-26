---
name: instalar-esprit
description: Instala Esprit en macOS o Windows desde este repositorio. Comprueba requisitos, entrevista al usuario, prepara su configuración y carpeta del doctorado, compila en macOS o usa la beta precompilada de Windows y acompaña el primer Login. Úsala cuando digan «instálame esto», «instala Esprit», «configura Esprit», «quiero usar Esprit» o peguen la URL del repositorio de Esprit.
---

# Instalar Esprit

**Primero detecta el sistema. En Windows sigue `references/windows.md`: sustituye
los pasos macOS de abajo y conserva la entrevista y las confirmaciones.**

Esprit es una app de macOS y Windows (Tauri 2 + Next.js) que hace de centro local del
doctorado: proyectos, estado global, rituales de Login y Logout con Claude
Code, chat, calendario, correo, Mattermost, GitHub, biblioteca con radar de
arXiv, clúster por SSH y LaTeX. La creó **A.S. Gómez** y la comparte con amigos
doctorandos. En macOS se compila en el equipo de cada uno; Windows dispone de
una beta precompilada con el alcance descrito en su referencia.

Tu papel: guía paciente y proactivo. El usuario hace un doctorado, no tiene por
qué ser programador. Habla en español, explica cada paso en una frase, detecta
todo lo que puedas antes de preguntar y propón en lugar de interrogar.

## Reglas que no se negocian

1. **Nunca pidas contraseñas, tokens ni códigos en el chat**, ni los escribas en
   archivos. El secreto de Mattermost lo guarda el usuario en el llavero desde su
   propia Terminal (ver `references/entrevista.md`, Mattermost).
2. Lo que pide la contraseña de macOS o abre una ventana del sistema lo ejecuta
   el usuario: instalar Homebrew, `xcode-select --install`, MacTeX,
   `gh auth login`, `ssh-copy-id`, `security add-generic-password`. Dale el
   comando exacto y espera a que te diga que ha terminado.
3. Instalar con Homebrew (`brew install node rust gh`) no pide contraseña: puedes
   ejecutarlo tú, después de que el usuario diga que sí.
4. **Nunca sobrescribas archivos que ya existan** en su carpeta del doctorado:
   propón una fusión, enséñale el cambio y espera su visto bueno. Si ya hay una
   configuración, haz copia de seguridad y enséñale las diferencias antes.
5. Enseña el resumen final de la configuración y pide confirmación **antes** de
   escribirla.
6. Pregunta con la herramienta AskUserQuestion, en rondas cortas (máximo cuatro
   preguntas por llamada, de dos a cuatro opciones cada una, encabezados de
   hasta 12 caracteres). Pon primero la opción recomendada y añade
   «(recomendado)» a su etiqueta. La opción «Otro» ya viene incluida para
   respuestas libres. Para datos abiertos (una URL, un nombre) pregunta en el
   chat.
7. Durante la detección lee solo nombres (carpetas, calendarios, cuentas,
   remotos de git, apps) y como mucho el principio de los README o STATE.md de
   los proyectos elegidos. No abras correos, documentos privados ni carpetas de
   administración.
8. Avisa **antes** de lo que vaya a provocar un aviso de macOS (permiso de
   Automatización para Calendario o Mail, acceso a Documentos o Escritorio,
   llavero) y explica qué acceso solicita y que puede rechazarlo y dejar ese módulo desactivado.
9. No borres nada. Lo que haya que retirar (una app antigua, una copia de las
   habilidades) va a la Papelera con `mv … ~/.Trash/`. Pregunta antes de
   reemplazar `/Applications/Esprit.app`.
10. No hagas `git push` ni cambies el remoto. Si hay que tocar archivos
    versionados (icono, paleta propia), hazlo en una rama local `mi-esprit`
    (ver la habilidad `personalizar-esprit`).

## Plan de trabajo

Crea al empezar una lista de tareas visible con estas fases y ve marcándolas:

1. Requisitos · 2. Repositorio · 3. Entrevista · 4. Configuración ·
5. Carpeta del doctorado · 6. Compilar e instalar · 7. Primer Login · 8. Cierre

Antes de nada, dile al usuario en tres o cuatro líneas qué vas a hacer, que
tardaréis entre 30 y 60 minutos (la primera compilación es lo más lento) y que
podéis parar y seguir cuando quiera.

## 1 · Requisitos

- Si el repositorio ya está en disco, ejecuta `bash scripts/doctor.sh` desde su
  raíz. Si todavía no está (solo te dieron la URL), comprueba lo mínimo para
  clonar: `xcode-select -p` y `git --version`; el diagnóstico completo lo harás
  justo después de clonar. GitHub CLI y su autenticación no son requisitos.
- Traduce la tabla a lenguaje llano. Para cada `FALTA` explica qué es, para qué
  lo necesita Esprit, el comando exacto y quién lo ejecuta (la columna de pasos
  siguientes lo indica). Los `OPCIONAL` solo limitan módulos: dilo y sigue.
- Orden habitual si falta todo: Command Line Tools → Homebrew (el usuario debe
  ejecutar también las líneas «Next steps» que imprime, para tener `brew` en el
  PATH) → `brew install node rust`. GitHub CLI se ofrece solo si quiere su módulo.
- Si `claude` sale como script de Node (AVISO), propón la versión nativa
  (`claude install`, lo ejecuta el usuario): desde la app, un script con
  `#!/usr/bin/env node` no encuentra `node`.
- Repite el diagnóstico hasta que no quede ningún `FALTA`. Guarda las rutas del
  bloque «Rutas para la configuración» (`bash scripts/doctor.sh --json` →
  `tools`): irán tal cual a `tools` en la configuración.

## 2 · Repositorio

- **Ya estás en el repo** (existen `config/esprit.schema.json` y
  `src-tauri/tauri.conf.json`): úsalo y apunta su ruta absoluta para
  `source_repo`.
- **Solo tienes la URL**: propón `~/Developer/Esprit` (recomendado) u otra
  carpeta. Desaconseja iCloud Drive, Escritorio y Documentos si se sincronizan
  con iCloud: la compilación genera varios GB que no deben sincronizarse.
  - Usa `git clone https://github.com/AlejandroSGomez/Esprit.git ~/Developer/Esprit`
    o la carpeta que haya elegido. El repositorio es público y no requiere cuenta,
    invitación ni credenciales. No cambies ajustes globales de Git del usuario.
  - Si falla, comprueba la URL, conexión/proxy y el error concreto; no inicies
    autenticación como solución automática. También puede descargar «Code →
    Download ZIP» y trabajar en la carpeta descomprimida.
- Si la carpeta de destino ya contiene un clon de Esprit: `git -C <ruta> status`;
  si está limpia, ofrece `git -C <ruta> pull --ff-only`. En una copia ZIP sin `.git`,
  conserva los archivos y usa esa copia; no intentes `git pull`.
- A partir de aquí trabaja desde la raíz del repo y lee su `CLAUDE.md`.
  Recuérdale al usuario que, para cambios futuros, conviene abrir Claude Code en
  esa carpeta (`cd ~/Developer/Esprit && claude`): allí está la habilidad
  `personalizar-esprit`.

## 3 · Entrevista

Sigue `references/entrevista.md`: cada ronda empieza con una detección de solo
lectura y termina con una llamada a AskUserQuestion. Mantén un borrador de la
configuración y, al cerrar cada ronda, resume en una o dos líneas lo que has
decidido.

| Ronda | Qué decide |
|---|---|
| 1 · Tú | nombre, nombre corto, iniciales, zona horaria |
| 2 · Carpeta | el workspace del doctorado |
| 3 · Proyectos | carpetas, slugs, nombres, etiquetas, repos de GitHub, estado |
| 4 · Módulos | qué módulos opcionales se activan |
| 5 · Detalles | calendarios, cuentas de correo, Mattermost, clúster, biblioteca, Radar y perfil de investigación |
| 6 · Accesos | enlaces de la sección ABRIR |
| 7 · Apariencia | paleta, tema, fondo de Inicio, icono |
| 8 · Motores e hitos | Claude y, si está, Codex; fechas fijas de Inicio |

Sé proactivo: si ves un repo de GitHub, propón el módulo GitHub; si ves `.tex`,
LaTeX; si ves PDFs, la Biblioteca; si ves hosts en `~/.ssh/config`, el Clúster.
No actives nada que no pueda funcionar (por ejemplo, GitHub sin `gh`
autenticado): explícalo y deja la puerta abierta para después.

## 4 · Configuración

Sigue `references/configuracion-y-carpeta.md` (primera parte): construye el
JSON según `docs/CONFIGURACION.md`, enséñale un resumen legible y el JSON,
confirma, escribe `~/.config/esprit/config.json` (con copia de seguridad si ya
existía) y valida con `/usr/bin/python3 scripts/check_config.py`.

## 5 · Carpeta del doctorado

Sigue `references/configuracion-y-carpeta.md` (segunda parte): crea
`Esprit/STATE.md` desde `templates/workspace/` con sus proyectos y el formato
exacto en español, los `STATE.md` de proyecto que falten, el perfil del Radar,
las carpetas de la biblioteca y el `CLAUDE.md` del workspace si no existe, y
copia `skills/esprit-login` y `skills/esprit-logout` a
`<workspace>/.claude/skills/`. Nada existente se sobrescribe.

## 6 · Compilar e instalar

Sigue `references/compilar-e-instalar.md`: `npm install`, `npm run app:build`
(en segundo plano, con registro), firma ad hoc, `--check-config` con el binario
recién compilado, copia a `/Applications/Esprit.app` (preguntando si ya existe)
y `open`.

## 7 · Primer Login

Con Esprit abierto, acompáñale:

1. Si ve **«Configuración pendiente»**, la pantalla muestra la ruta y el error:
   corrige la configuración, valida con `scripts/check_config.py` y pulsa
   «Recargar configuración». No hace falta recompilar.
2. Explica lo que ve: la barra lateral con sus módulos y la sección ABRIR;
   Inicio con el Foco, el Radar de proyectos y sus hitos, leídos de
   `Esprit/STATE.md` y de la configuración. Discreto, en la barra lateral y en
   Configuración → Acerca de, pone «Creada por A.S. Gómez».
3. Avísale de los permisos antes de empezar: la primera vez que Esprit lea el
   Calendario o Mail, macOS preguntará si «Esprit» puede controlarlos. Explícale
   qué acceso implica; puede aceptarlo o rechazarlo y desactivar el módulo. Si usa
   Mattermost, macOS puede pedir permiso para usar el
   elemento del llavero: autorizarlo solo si reconoce el acceso esperado.
4. Que pulse **Login** y después **Iniciar Login**. Tarda uno o dos minutos. Las
   tres primeras viñetas del briefing aparecen luego en Inicio. Si activó el
   Radar, después del Login llegan de cero a dos artículos recomendados (cero es
   un resultado válido).
5. Explícale el **Logout** para el final del día: primero Esprit reconstruye la
   jornada y le hace unas preguntas; con sus respuestas propone el nuevo estado
   global y los eventos de calendario; nada se escribe hasta que pulsa
   confirmar.
6. Pídele que te cuente qué ve y resuelve lo que falle (tabla de problemas en
   `docs/INSTALACION.md`).

## 8 · Cierre

Termina con un mensaje breve y personal:

- Un resumen de lo instalado (módulos activos, proyectos, dónde está cada cosa:
  app, configuración, workspace, repo).
- Entre tres y seis **sugerencias proactivas** basadas en lo que has visto en la
  entrevista, no genéricas. Ejemplos: activar un módulo que dejó para después
  porque faltaba `gh` o MacTeX; crear un calendario «Doctorado» para que el
  Logout apunte ahí sus eventos; afinar el perfil del Radar tras una semana de
  recomendaciones; poner su foto favorita como fondo de Inicio; añadir el
  `cluster_dir` de cada proyecto; crear una habilidad propia en
  `<workspace>/.claude/skills/` para una tarea que repite (aparecerá en el
  selector de habilidades del chat de Esprit).
- Una invitación explícita, con tus palabras, en este sentido: «Esprit es tuyo.
  Cambia lo que quieras: proyectos, módulos, colores, el icono o funciones
  nuevas. Abre Claude Code en `<ruta del repo>` y pídemelo cuando quieras;
  también puedo traerte las mejoras que publique A.S. Gómez revisando y conservando tus
  cambios».

## Si algo falla

- Requisitos, compilación, permisos de macOS, llavero, `gh`, iCloud: tabla de
  problemas de `docs/INSTALACION.md`.
- Configuración rechazada: el mensaje de `--check-config` o de la pantalla
  «Configuración pendiente» nombra el campo; `docs/CONFIGURACION.md` explica
  cada uno.
- Si un error apunta a un fallo del propio Esprit (no de su Mac ni de su
  configuración), dilo con claridad, propón un arreglo local en la rama
  `mi-esprit` y sugiere avisar a A.S. Gómez.
