---
name: actualizar-esprit
description: Actualiza una instalación existente de Esprit a la última versión publicada en https://github.com/AlejandroSGomez/Esprit, en macOS o Windows, conservando la configuración, los datos y las personalizaciones del usuario. Úsala cuando digan «actualiza Esprit», «actualízame Esprit», «hay una versión nueva de Esprit», «trae las mejoras de Esprit» o peguen el enlace del repositorio pidiendo actualizar. Si no hay ninguna instalación, usa instalar-esprit.
---

# Actualizar Esprit

Objetivo: que la persona diga «actualiza Esprit» (con o sin el enlace) y acabe
con la última versión instalada y funcionando, sin perder nada suyo. Habla en
español, explica cada paso en una frase y pide confirmación antes de cada acción
que reemplace algo.

**Primero detecta el sistema.** En Windows sigue `references/windows.md` en los
pasos 5 y 6; el resto es común. Lee `AGENTS.md` del repositorio cuando lo tengas.

## Reglas que no se negocian

1. Nunca uses `git reset --hard`, `git clean`, `git push --force`, `git stash drop`
   ni borres archivos. Lo que haya que retirar va a la Papelera.
2. Nunca reemplaces `~/.config/esprit/config.json` (Windows:
   `%USERPROFILE%\.config\esprit\config.json`), la carpeta del doctorado, sus
   `STATE.md`, la biblioteca ni los registros. Una actualización solo **propone**
   cambios en ellos, con respaldo y confirmación.
3. Esta edición se identifica como `es.asgomez.esprit`. No toques otra app
   llamada Esprit con otro identificador (por ejemplo, la edición personal del
   autor).
4. No pidas contraseñas ni tokens. GitHub no requiere cuenta: el repositorio y
   sus Releases son públicos.
5. No publiques nada: no hagas `git push`, no cambies el remoto, no abras PRs.

## 1 · Localizar la instalación

- Configuración: `~/.config/esprit/config.json`. Si existe, su campo
  `source_repo` (si lo tiene) apunta al clon usado al instalar.
- Clon del repositorio: `source_repo`, la carpeta actual si contiene
  `config/esprit.schema.json` y `src-tauri/tauri.conf.json`, o
  `~/Developer/Esprit`. Si hay varias candidatas, pregunta cuál usar.
- App instalada (macOS): `/Applications/Esprit.app`. Comprueba
  `defaults read /Applications/Esprit.app/Contents/Info CFBundleIdentifier`
  (= `es.asgomez.esprit`) y `CFBundleShortVersionString`.
- Si no hay clon pero sí app o configuración (instalación de Windows desde el
  instalador, o un clon que se borró): en macOS clona de nuevo por HTTPS en
  `~/Developer/Esprit` (o la carpeta que elija); en Windows basta el instalador
  (ver la referencia).
- Si no hay nada instalado, explica que no es una actualización y pasa a
  `.claude/skills/instalar-esprit/SKILL.md`.

## 2 · Comparar versiones

1. `git -C <repo> fetch origin` (HTTPS, sin credenciales).
2. Versión local: `package.json` del clon y la de la app instalada. Versión
   publicada: `git -C <repo> show origin/main:package.json`. Releases:
   `https://github.com/AlejandroSGomez/Esprit/releases/latest` (o la API pública
   `https://api.github.com/repos/AlejandroSGomez/Esprit/releases/latest`).
3. Resume en lenguaje llano las novedades entre ambas versiones a partir de
   `git -C <repo> show origin/main:CHANGELOG.md` y de los
   `docs/ACTUALIZACION_*.md` nuevos: qué mejora, qué cambia de aspecto y qué
   permisos nuevos pedirá el sistema.
4. Si ya está al día, dilo y termina. Si la persona solo preguntó si hay
   novedades, informa y espera antes de aplicar nada.

## 3 · Conservar lo suyo

1. `git -C <repo> status` y `git -C <repo> log --oneline origin/main..HEAD`.
2. Si hay cambios sin guardar, enséñale el resumen (`git diff --stat`) y, con su
   visto bueno, guárdalos en la rama local `mi-esprit` con un commit descriptivo
   (créala desde la rama actual si no existe). Imágenes propias deben estar en
   `public/custom/` (ignorado por Git); no las muevas sin preguntar.
3. Sin personalizaciones (rama `main` limpia, sin commits propios):
   `git -C <repo> checkout main && git -C <repo> merge --ff-only origin/main`.
4. Con personalizaciones: en `mi-esprit`, `git -C <repo> merge origin/main`.
   Si hay conflictos, muéstralos uno a uno y resuélvelos conservando la
   intención de sus cambios y las mejoras nuevas; explica cada decisión. Si un
   conflicto no se puede resolver con seguridad, aborta la fusión
   (`git merge --abort`), cuéntale qué choca y propón cómo seguir.

## 4 · Configuración, carpeta y skills

1. Valida la configuración con la nueva versión:
   `python3 scripts/check_config.py` (Windows: `python scripts\check_config.py`).
   Si una versión nueva añade campos u opciones (lo dicen `CHANGELOG.md`,
   `docs/CONFIGURACION.md` y `docs/ACTUALIZACION_*.md`), propón el cambio exacto,
   haz copia de seguridad (`config.json.bak-<fecha>`) y escribe solo tras su
   confirmación. Los módulos nuevos empiezan apagados: ofrécelos, no los actives.
2. Skills de los rituales: compara `skills/esprit-login`, `skills/esprit-logout`
   y `skills/esprit-radar` del repositorio con las copias de
   `<workspace>/.claude/skills/`. Si difieren, enseña el diff y, con su visto
   bueno, respalda la copia antigua y copia la nueva. No toques otras skills.
3. No reescribas `STATE.md` ni documentos del doctorado.

## 5 · Compilar e instalar (macOS)

1. `bash scripts/doctor.sh`: si falta algo nuevo (por ejemplo, una versión de
   Rust más reciente), explica y resuelve como en la instalación.
2. `npm ci` y después `npm run app:build` en segundo plano con registro
   (tarda varios minutos; la primera vez tras una versión nueva, más).
3. Firma ad hoc: `codesign --force --deep --sign - src-tauri/target/release/bundle/macos/Esprit.app`.
4. Comprueba el binario nuevo con su configuración:
   `src-tauri/target/release/bundle/macos/Esprit.app/Contents/MacOS/esprit --check-config`.
5. Si Esprit está abierto, pídele que lo cierre (⌘Q) y espera. Confirma el
   identificador de la app instalada y, con su permiso, reemplázala:
   `ditto src-tauri/target/release/bundle/macos/Esprit.app /Applications/Esprit.app`.
   Verifica la versión instalada y ábrela con `open -a /Applications/Esprit.app`.
6. Avisa de los permisos que pida la versión nueva (por ejemplo, desde 0.4 macOS
   pregunta una vez por el acceso completo a Calendarios para leer todas las
   repeticiones de los eventos periódicos). Puede rechazarlo: el calendario
   seguirá funcionando por la vía lenta.

## 6 · Windows

Sigue `references/windows.md`: instalador de la última Release con su
`SHA256SUMS.txt`, o compilación local si la persona mantiene cambios de código.

## 7 · Cierre

- Qué versión tenía y cuál tiene ahora; las novedades que va a notar, en tres a
  seis líneas.
- Qué se conservó (configuración, rama `mi-esprit`, skills) y qué se respaldó.
- Si algo quedó pendiente (un conflicto, un permiso rechazado, un módulo nuevo
  sin activar), dilo con claridad y cómo retomarlo.
- Recuérdale que basta con decir «actualiza Esprit» para la próxima versión.
