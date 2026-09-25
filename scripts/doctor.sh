#!/bin/bash
# Esprit · diagnóstico previo a la instalación (solo lectura).
#
# Uso:
#   bash scripts/doctor.sh          tabla legible y pasos siguientes
#   bash scripts/doctor.sh --json   la misma información en JSON
#
# No instala, no modifica ni borra nada. Compatible con el bash 3.2 de macOS.
# Sale con 0 si todo lo obligatorio está presente y con 1 si falta algo.

MODE="table"
case "${1:-}" in
  --json) MODE="json" ;;
  ""|--table) ;;
  -h|--help)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  *) echo "Opción desconocida: $1 (usa --json o nada)" >&2; exit 2 ;;
esac

# Las apps de macOS y algunas terminales no cargan el PATH del usuario:
# buscamos también en las rutas habituales de Homebrew, cargo y ~/.local.
EXTRA_PATHS="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin:/Library/TeX/texbin"
export PATH="$PATH:$EXTRA_PATHS"

IDS=(); LABELS=(); STATUSES=(); DETAILS=(); FIXES=(); FIX_BY=(); REQUIRED=()
TOOL_CLAUDE=""; TOOL_GH=""; TOOL_CODEX=""; TOOL_PYTHON3=""; TOOL_LATEXMK=""

add() { # id etiqueta estado detalle arreglo quien obligatorio
  IDS+=("$1"); LABELS+=("$2"); STATUSES+=("$3"); DETAILS+=("$4")
  FIXES+=("$5"); FIX_BY+=("$6"); REQUIRED+=("$7")
}

# Devuelve 0 si la versión $1 >= $2 (comparación numérica por componentes).
ver_ge() {
  local IFS=.
  local a=($1) b=($2) i x y
  for i in 0 1 2; do
    x=${a[$i]:-0}; y=${b[$i]:-0}
    x=${x%%[!0-9]*}; y=${y%%[!0-9]*}
    x=${x:-0}; y=${y:-0}
    if [ "$x" -gt "$y" ]; then return 0; fi
    if [ "$x" -lt "$y" ]; then return 1; fi
  done
  return 0
}

# Primera ruta ejecutable entre `command -v` y candidatos explícitos.
find_tool() {
  local name="$1"; shift
  local found
  found=$(command -v "$name" 2>/dev/null)
  if [ -n "$found" ] && [ -x "$found" ]; then echo "$found"; return 0; fi
  for candidate in "$@"; do
    if [ -x "$candidate" ] && [ ! -d "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  return 1
}

# Un script con `#!/usr/bin/env node` falla cuando lo lanza una app de macOS,
# porque las apps no heredan el PATH de la terminal.
needs_env_node() {
  local first
  first=$(head -c 200 "$1" 2>/dev/null | head -n 1 | tr -d '\000')
  case "$first" in
    '#!'*env*node*) return 0 ;;
  esac
  return 1
}

# --- Sistema -----------------------------------------------------------------
OS_NAME=$(uname -s)
if [ "$OS_NAME" != "Darwin" ]; then
  add macos "macOS" FALTA "Este sistema es $OS_NAME; Esprit solo funciona en macOS." "" "" 1
else
  MACOS_VER=$(sw_vers -productVersion 2>/dev/null)
  if ver_ge "$MACOS_VER" 13; then
    add macos "macOS" OK "$MACOS_VER" "" "" 1
  elif ver_ge "$MACOS_VER" 11; then
    add macos "macOS" AVISO "$MACOS_VER: puede funcionar, pero se recomienda macOS 13 o posterior." "Actualiza macOS desde Ajustes del Sistema → General → Actualización de software." usuario 1
  else
    add macos "macOS" FALTA "$MACOS_VER: demasiado antiguo para compilar Esprit." "Actualiza macOS desde Ajustes del Sistema." usuario 1
  fi
fi
ARCH=$(uname -m)
case "$ARCH" in
  arm64) add arch "Arquitectura" OK "Apple Silicon (arm64)" "" "" 0 ;;
  x86_64) add arch "Arquitectura" OK "Intel (x86_64)" "" "" 0 ;;
  *) add arch "Arquitectura" AVISO "$ARCH (no probada)" "" "" 0 ;;
esac

# Espacio libre: la compilación de Rust ocupa varios GB.
FREE_GB=$(df -g "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "$FREE_GB" ]; then
  if [ "$FREE_GB" -ge 8 ]; then
    add disco "Espacio libre" OK "${FREE_GB} GB en tu carpeta de usuario" "" "" 0
  else
    add disco "Espacio libre" AVISO "${FREE_GB} GB: la compilación necesita unos 5–8 GB." "Libera espacio antes de compilar." usuario 0
  fi
fi

# --- Herramientas de compilación ---------------------------------------------
CLT_OK=0
if CLT_PATH=$(xcode-select -p 2>/dev/null) && [ -d "$CLT_PATH" ]; then
  CLT_OK=1
  add clt "Xcode Command Line Tools" OK "$CLT_PATH" "" "" 1
else
  add clt "Xcode Command Line Tools" FALTA "No instaladas (incluyen git, clang y python3)." "xcode-select --install   (abre una ventana de macOS; tarda unos minutos)" usuario 1
fi

if GIT=$(find_tool git /usr/bin/git) && [ "$CLT_OK" = 1 ]; then
  add git "git" OK "$("$GIT" --version 2>/dev/null | awk '{print $3}') · $GIT" "" "" 1
elif [ "$CLT_OK" = 0 ]; then
  add git "git" FALTA "Llega con las Command Line Tools." "Instala primero las Command Line Tools." usuario 1
else
  add git "git" FALTA "No encontrado." "xcode-select --install" usuario 1
fi

if BREW=$(find_tool brew /opt/homebrew/bin/brew /usr/local/bin/brew); then
  add brew "Homebrew" OK "$BREW" "" "" 1
else
  add brew "Homebrew" FALTA "No instalado (gestor de paquetes para instalar Node, Rust y gh)." "Instálalo tú desde https://brew.sh (pide tu contraseña de macOS) y sigue las líneas «Next steps» que imprime al terminar." usuario 1
fi

if NODE=$(find_tool node /opt/homebrew/bin/node /usr/local/bin/node); then
  NODE_VER=$("$NODE" -v 2>/dev/null | sed 's/^v//')
  if ver_ge "$NODE_VER" 22.13; then
    add node "Node.js ≥ 22.13" OK "$NODE_VER · $NODE" "" "" 1
  else
    add node "Node.js ≥ 22.13" FALTA "$NODE_VER es demasiado antiguo." "brew upgrade node   (o brew install node)" claude 1
  fi
else
  add node "Node.js ≥ 22.13" FALTA "No instalado." "brew install node" claude 1
fi

if NPM=$(find_tool npm /opt/homebrew/bin/npm /usr/local/bin/npm); then
  add npm "npm" OK "$("$NPM" -v 2>/dev/null) · $NPM" "" "" 1
else
  add npm "npm" FALTA "No instalado (llega con Node.js)." "brew install node" claude 1
fi

if CARGO=$(find_tool cargo "$HOME/.cargo/bin/cargo" /opt/homebrew/bin/cargo /usr/local/bin/cargo); then
  RUSTC=$(find_tool rustc "$(dirname "$CARGO")/rustc")
  RUST_VER=$("${RUSTC:-rustc}" --version 2>/dev/null | awk '{print $2}')
  if [ -n "$RUST_VER" ] && ver_ge "$RUST_VER" 1.80; then
    add rust "Rust (cargo)" OK "$RUST_VER · $CARGO" "" "" 1
  else
    add rust "Rust (cargo)" AVISO "Versión ${RUST_VER:-desconocida}; se recomienda 1.80 o posterior." "brew upgrade rust   (o rustup update si usas rustup)" claude 1
  fi
else
  add rust "Rust (cargo)" FALTA "No instalado." "brew install rust" claude 1
fi

# /usr/bin/python3 es un stub que abre el instalador de las Command Line Tools
# si faltan: solo lo ejecutamos cuando ya están instaladas.
if [ "$CLT_OK" = 1 ] && [ -x /usr/bin/python3 ]; then
  PY_VER=$(/usr/bin/python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null)
  if [ -n "$PY_VER" ] && ver_ge "$PY_VER" 3.9; then
    TOOL_PYTHON3="/usr/bin/python3"
    add python3 "/usr/bin/python3 ≥ 3.9" OK "$PY_VER" "" "" 1
  else
    add python3 "/usr/bin/python3 ≥ 3.9" FALTA "Versión ${PY_VER:-desconocida}." "xcode-select --install   (el python3 del sistema llega con las Command Line Tools)" usuario 1
  fi
else
  add python3 "/usr/bin/python3 ≥ 3.9" FALTA "Llega con las Command Line Tools." "Instala primero las Command Line Tools." usuario 1
fi

# --- Motores de IA -------------------------------------------------------------
if CLAUDE=$(find_tool claude "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude "$HOME/.npm-global/bin/claude"); then
  TOOL_CLAUDE="$CLAUDE"
  CLAUDE_VER=$("$CLAUDE" --version 2>/dev/null | head -n 1)
  if needs_env_node "$CLAUDE"; then
    add claude "Claude Code (CLI)" AVISO "$CLAUDE es un script de Node: desde la app puede no encontrar node." "claude install   (instala la versión nativa; después vuelve a ejecutar este diagnóstico)" usuario 1
  else
    add claude "Claude Code (CLI)" OK "${CLAUDE_VER:-versión desconocida} · $CLAUDE" "" "" 1
  fi
else
  add claude "Claude Code (CLI)" FALTA "No encontrado en las rutas habituales." "Indica a Claude dónde está el ejecutable (en Claude Code: ! which claude)." usuario 1
fi

if CODEX=$(find_tool codex /opt/homebrew/bin/codex /usr/local/bin/codex "$HOME/.local/bin/codex"); then
  TOOL_CODEX="$CODEX"
  CODEX_VER=$("$CODEX" --version 2>/dev/null | head -n 1)
  if needs_env_node "$CODEX"; then
    add codex "Codex CLI (opcional)" AVISO "$CODEX es un script de Node: desde la app puede no encontrar node." "brew install --cask codex   (versión nativa), o deja Codex desactivado" usuario 0
  else
    add codex "Codex CLI (opcional)" OK "${CODEX_VER:-versión desconocida} · $CODEX" "" "" 0
  fi
else
  add codex "Codex CLI (opcional)" OPCIONAL "No instalado: Esprit funcionará solo con Claude." "" "" 0
fi

# --- Integraciones opcionales ------------------------------------------------
if GH=$(find_tool gh /opt/homebrew/bin/gh /usr/local/bin/gh); then
  TOOL_GH="$GH"
  GH_VER=$("$GH" --version 2>/dev/null | head -n 1 | awk '{print $3}')
  if "$GH" auth status --hostname github.com >/dev/null 2>&1; then
    GH_USER=$("$GH" api user --jq .login 2>/dev/null)
    add gh "GitHub CLI (opcional)" OK "$GH_VER · sesión iniciada${GH_USER:+ como $GH_USER} · $GH" "" "" 0
  else
    add gh "GitHub CLI (opcional)" AVISO "$GH_VER · sin sesión iniciada." "gh auth login --web   (ejecútalo tú en Terminal: abre el navegador)" usuario 0
  fi
else
  add gh "GitHub CLI (opcional)" OPCIONAL "No instalado: necesario para el módulo GitHub y para clonar el repo privado." "brew install gh" claude 0
fi

if LATEXMK=$(find_tool latexmk /Library/TeX/texbin/latexmk); then
  TOOL_LATEXMK="$LATEXMK"
  add latexmk "latexmk (opcional)" OK "$LATEXMK" "" "" 0
else
  add latexmk "latexmk (opcional)" OPCIONAL "No instalado: el módulo LaTeX quedará desactivado." "brew install --cask mactex-no-gui   (grande, ~5 GB; pide tu contraseña)" usuario 0
fi

# --- Estado de Esprit en este Mac ------------------------------------------------
CONFIG_PATH="${ESPRIT_CONFIG:-$HOME/.config/esprit/config.json}"
if [ -f "$CONFIG_PATH" ]; then
  add config "Configuración de Esprit" INFO "Ya existe: $CONFIG_PATH" "" "" 0
else
  add config "Configuración de Esprit" INFO "Aún no existe ($CONFIG_PATH)." "" "" 0
fi

if [ -d /Applications/Esprit.app ]; then
  BUNDLE_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' /Applications/Esprit.app/Contents/Info.plist 2>/dev/null)
  BUNDLE_VER=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/Esprit.app/Contents/Info.plist 2>/dev/null)
  if [ "$BUNDLE_ID" = "es.asgomez.esprit" ]; then
    add app "Esprit.app instalada" INFO "Versión ${BUNDLE_VER:-?} en /Applications (se reemplazará al reinstalar)." "" "" 0
  else
    add app "Esprit.app instalada" AVISO "Hay otra app llamada Esprit en /Applications (${BUNDLE_ID:-identificador desconocido})." "Pregunta antes de reemplazarla." claude 0
  fi
else
  add app "Esprit.app instalada" INFO "No instalada todavía." "" "" 0
fi

# --- Salida --------------------------------------------------------------------
ALL_OK=1
i=0
while [ $i -lt ${#IDS[@]} ]; do
  if [ "${REQUIRED[$i]}" = 1 ] && [ "${STATUSES[$i]}" = "FALTA" ]; then ALL_OK=0; fi
  i=$((i + 1))
done

json_escape() {
  printf '%s' "$1" | /usr/bin/awk 'BEGIN { ORS="" } {
    gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "");
    if (NR > 1) printf "\\n"; print
  }'
}
json_str_or_null() {
  if [ -n "$1" ]; then printf '"%s"' "$(json_escape "$1")"; else printf 'null'; fi
}

if [ "$MODE" = "json" ]; then
  printf '{\n  "ok": %s,\n  "checks": [\n' "$([ $ALL_OK = 1 ] && echo true || echo false)"
  i=0; n=${#IDS[@]}
  while [ $i -lt $n ]; do
    printf '    {"id": "%s", "label": "%s", "status": "%s", "required": %s, "detail": "%s", "fix": %s, "fix_by": %s}' \
      "${IDS[$i]}" "$(json_escape "${LABELS[$i]}")" "${STATUSES[$i]}" \
      "$([ "${REQUIRED[$i]}" = 1 ] && echo true || echo false)" \
      "$(json_escape "${DETAILS[$i]}")" "$(json_str_or_null "${FIXES[$i]}")" "$(json_str_or_null "${FIX_BY[$i]}")"
    i=$((i + 1))
    if [ $i -lt $n ]; then printf ',\n'; else printf '\n'; fi
  done
  printf '  ],\n  "tools": {\n'
  printf '    "claude": %s,\n' "$(json_str_or_null "$TOOL_CLAUDE")"
  printf '    "codex": %s,\n' "$(json_str_or_null "$TOOL_CODEX")"
  printf '    "gh": %s,\n' "$(json_str_or_null "$TOOL_GH")"
  printf '    "python3": %s,\n' "$(json_str_or_null "$TOOL_PYTHON3")"
  printf '    "latexmk": %s\n' "$(json_str_or_null "$TOOL_LATEXMK")"
  printf '  }\n}\n'
else
  printf '\nEsprit · diagnóstico del Mac\n\n'
  row() { # printf cuenta bytes, no caracteres: rellenamos a mano por los acentos.
    local pad=$((28 - $(printf '%s' "$1" | LC_ALL=en_US.UTF-8 wc -m | tr -d ' ')))
    [ $pad -lt 1 ] && pad=1
    printf '%s%*s %-9s %s\n' "$1" "$pad" "" "$2" "$3"
  }
  row "Comprobación" "Estado" "Detalle"
  row "---------------------------" "--------" "------------------------------"
  i=0
  while [ $i -lt ${#IDS[@]} ]; do
    row "${LABELS[$i]}" "${STATUSES[$i]}" "${DETAILS[$i]}"
    i=$((i + 1))
  done
  printf '\nRutas para la configuración (tools):\n'
  printf '  claude:  %s\n' "${TOOL_CLAUDE:-(no encontrado)}"
  printf '  codex:   %s\n' "${TOOL_CODEX:-null}"
  printf '  gh:      %s\n' "${TOOL_GH:-null}"
  printf '  python3: %s\n' "${TOOL_PYTHON3:-(no disponible)}"
  printf '  latexmk: %s\n' "${TOOL_LATEXMK:-null}"
  printed=0
  i=0
  while [ $i -lt ${#IDS[@]} ]; do
    if [ -n "${FIXES[$i]}" ] && [ "${STATUSES[$i]}" != "OK" ] && [ "${STATUSES[$i]}" != "INFO" ]; then
      if [ $printed = 0 ]; then printf '\nPasos siguientes:\n'; printed=1; fi
      who="lo ejecuta Claude con tu permiso"
      [ "${FIX_BY[$i]}" = "usuario" ] && who="lo ejecutas tú"
      printf '  - %s (%s): %s\n' "${LABELS[$i]}" "$who" "${FIXES[$i]}"
    fi
    i=$((i + 1))
  done
  if [ $ALL_OK = 1 ]; then
    printf '\nTodo lo obligatorio está listo.\n\n'
  else
    printf '\nFalta algo obligatorio: resuélvelo y vuelve a ejecutar el diagnóstico.\n\n'
  fi
fi

[ $ALL_OK = 1 ] && exit 0 || exit 1
