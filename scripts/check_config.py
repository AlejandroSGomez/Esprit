#!/usr/bin/env python3
"""Esprit · comprobación previa de la configuración (solo lectura).

Uso:
  /usr/bin/python3 scripts/check_config.py [ruta] [--json] [--sin-estado]

Ruta: el argumento, o $ESPRIT_CONFIG, o ~/.config/esprit/config.json.

Comprueba la sintaxis JSON, los campos del esquema (config/esprit.schema.json),
que las rutas existan y, si existe, el formato de <workspace>/Esprit/STATE.md.
Es una comprobación previa: la validación definitiva es la de la propia app
(`Esprit.app/Contents/MacOS/esprit --check-config`). Solo biblioteca estándar.
Sale con 0 si no hay errores (los avisos no cuentan) y con 1 si los hay.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,47}$")
TZ = re.compile(r"^[A-Za-z_]+(/[A-Za-z0-9_+\-]+){0,2}$")
REPO = re.compile(r"^[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+$")
URL = re.compile(r"^(https?|obsidian|zotero|vscode)://")
APP = re.compile(r"^[^/\\:]{1,60}$")
COLLECTION = re.compile(r"^[^/\\]{1,60}$")
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+$")
ARXIV = re.compile(r"^[a-z\-]+(\.[A-Za-z\-]+)?$")
ALIAS = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")
PALETTE = re.compile(r"^[a-z0-9\-]{1,32}$")
ICONS = {"overleaf", "vscode", "obsidian", "mattermost", "chatgpt", "zotero", "github",
         "drive", "notion", "slack", None}
TOP_KEYS = {"version", "user", "time_zone", "workspace", "source_repo", "tools", "projects",
            "milestones", "links", "modules", "appearance"}
REQUIRED_TOP = ["version", "user", "time_zone", "workspace", "tools", "projects", "modules"]
MODULE_KEYS = {
    "claude_connectors": {"enabled", "gmail", "calendar", "gmail_query", "calendar_ids", "read_tools"},
    "travel": {"enabled", "folder"},
    "mail": {"enabled", "accounts"},
    "calendar": {"enabled", "read", "write"},
    "mattermost": {"enabled", "server", "team", "username", "auth", "keychain_service", "channels", "app"},
    "github": {"enabled"},
    "library": {"enabled", "folder"},
    "paper_radar": {"enabled", "arxiv_categories", "keywords", "profile"},
    "cluster": {"enabled", "label", "ssh_alias", "remote_home", "scheduler", "jupyter_url"},
    "latex": {"enabled"},
    "meetings": {"enabled"},
}

# Contrato del estado global en español (docs/ESTADO_GLOBAL.md).
STATE_SECTIONS = ["Foco", "Radar de proyectos", "No olvidar", "Esperando a",
                  "Administración y logística", "Ideas y proyectos candidatos",
                  "Relevo para mañana", "Cierres diarios recientes", "Salud de las fuentes"]
HUMAN_SECTIONS = STATE_SECTIONS[2:]
FOCUS_FIELDS = ["Proyecto", "Titular", "Detalle", "Siguiente", "Actualizado"]
PROJECT_FIELDS = ["Nombre", "Estado", "Resumen", "Siguiente", "Plazo", "Progreso", "Fuente"]
STATES = {"activo", "esperando", "exploratorio", "pausado", "candidato"}
STAMP = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Za-z_]+(/[A-Za-z0-9_+\-]+){0,2}$")


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)


def is_relative_ok(value: object) -> bool:
    if not isinstance(value, str) or not (1 <= len(value) <= 200) or value.startswith("/"):
        return False
    return ".." not in value.split("/")


def check_str(r: Report, where: str, value: object, lo: int = 1, hi: int = 80, required: bool = True) -> bool:
    if value is None and not required:
        return True
    if not isinstance(value, str):
        r.error(f"{where}: debe ser texto.")
        return False
    if not (lo <= len(value) <= hi):
        r.error(f"{where}: debe tener entre {lo} y {hi} caracteres (tiene {len(value)}).")
        return False
    return True


def check_unknown(r: Report, where: str, obj: dict, allowed: set) -> None:
    for key in obj:
        if key not in allowed:
            r.error(f"{where}: campo desconocido «{key}» (revisa la ortografía en docs/CONFIGURACION.md).")


def check_list(r: Report, where: str, value: object, max_items: int) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        r.error(f"{where}: debe ser una lista.")
        return []
    if len(value) > max_items:
        r.error(f"{where}: como máximo {max_items} elementos (hay {len(value)}).")
    return value


def check_executable(r: Report, where: str, value: object, required: bool) -> None:
    if value is None:
        if required:
            r.error(f"{where}: es obligatorio.")
        return
    if not isinstance(value, str) or not Path(value).is_absolute():
        r.error(f"{where}: debe ser una ruta absoluta o null.")
        return
    path = Path(value)
    if not path.is_file() or not os.access(path, os.X_OK):
        r.error(f"{where}: {value} no existe o no es ejecutable.")
        return
    try:
        first = path.open("rb").readline(200)
    except OSError:
        return
    if first.startswith(b"#!") and b"env" in first and b"node" in first:
        r.warn(f"{where}: {value} es un script de Node; lanzado desde la app puede no encontrar "
               "node. Mejor una instalación nativa (docs/INSTALACION.md).")


def check_config(cfg: dict, r: Report) -> Path | None:
    check_unknown(r, "raíz", cfg, TOP_KEYS)
    for key in REQUIRED_TOP:
        if key not in cfg:
            r.error(f"Falta el campo obligatorio «{key}».")
    if cfg.get("version") != 1:
        r.error("version: debe ser 1.")

    user = cfg.get("user")
    if isinstance(user, dict):
        check_unknown(r, "user", user, {"name", "short_name", "initials"})
        check_str(r, "user.name", user.get("name"), 1, 80)
        check_str(r, "user.short_name", user.get("short_name"), 1, 40)
        check_str(r, "user.initials", user.get("initials"), 1, 3)
    elif "user" in cfg:
        r.error("user: debe ser un objeto con name, short_name e initials.")

    tz = cfg.get("time_zone")
    if isinstance(tz, str) and TZ.match(tz):
        if not Path("/usr/share/zoneinfo", tz).is_file():
            r.warn(f"time_zone: «{tz}» no aparece en /usr/share/zoneinfo; comprueba que sea una zona IANA real.")
    elif "time_zone" in cfg:
        r.error("time_zone: debe ser una zona IANA como Europe/Madrid.")

    workspace = None
    ws = cfg.get("workspace")
    if isinstance(ws, str) and Path(ws).is_absolute():
        p = Path(ws)
        if p.is_symlink():
            r.error(f"workspace: {ws} es un enlace simbólico; usa la ruta real ({os.path.realpath(ws)}).")
        elif not p.is_dir():
            r.error(f"workspace: {ws} no existe o no es una carpeta.")
        elif os.path.realpath(ws) == "/":
            r.error("workspace: no puede ser la raíz del disco.")
        else:
            workspace = p
            if os.path.realpath(ws) != os.path.normpath(ws):
                r.warn(f"workspace: alguna carpeta de la ruta es un enlace; la ruta real es {os.path.realpath(ws)}.")
    elif "workspace" in cfg:
        r.error("workspace: debe ser una ruta absoluta.")

    src = cfg.get("source_repo")
    if src is not None:
        if not isinstance(src, str) or not Path(src).is_absolute():
            r.error("source_repo: debe ser una ruta absoluta o null.")
        elif not Path(src, "src-tauri").is_dir():
            r.warn(f"source_repo: {src} no parece el repositorio de Esprit (falta src-tauri/).")

    tools = cfg.get("tools")
    if isinstance(tools, dict):
        check_unknown(r, "tools", tools, {"claude", "codex", "gh", "python3", "latexmk"})
        check_executable(r, "tools.claude", tools.get("claude"), True)
        for name in ("codex", "gh", "python3", "latexmk"):
            check_executable(r, f"tools.{name}", tools.get(name), False)
    elif "tools" in cfg:
        r.error("tools: debe ser un objeto.")
    tools = tools if isinstance(tools, dict) else {}

    slugs: set[str] = set()
    for i, proj in enumerate(check_list(r, "projects", cfg.get("projects"), 24)):
        where = f"projects[{i}]"
        if not isinstance(proj, dict):
            r.error(f"{where}: debe ser un objeto.")
            continue
        check_unknown(r, where, proj, {"slug", "name", "short_name", "tag", "folder", "github_repos",
                                       "library_collection", "cluster_dir"})
        slug = proj.get("slug")
        if not isinstance(slug, str) or not SLUG.match(slug):
            r.error(f"{where}.slug: «{slug}» no es válido (minúsculas, números y guiones; empieza por letra o número).")
        elif slug == "general":
            r.error(f"{where}.slug: «general» está reservado (es el foco sin proyecto).")
        elif slug in slugs:
            r.error(f"{where}.slug: «{slug}» está repetido.")
        else:
            slugs.add(slug)
            where = f"projects[{slug}]"
        check_str(r, f"{where}.name", proj.get("name"), 1, 80)
        if "short_name" in proj:
            check_str(r, f"{where}.short_name", proj.get("short_name"), 1, 28)
        if proj.get("tag") is not None:
            check_str(r, f"{where}.tag", proj.get("tag"), 0, 28)
        folder = proj.get("folder")
        if not is_relative_ok(folder):
            r.error(f"{where}.folder: debe ser una ruta relativa al workspace, sin «..» ni «/» inicial.")
        elif workspace is not None:
            target = workspace / folder
            if target.is_symlink():
                r.error(f"{where}.folder: {folder} es un enlace simbólico; usa una carpeta real del workspace.")
            elif not target.is_dir():
                r.error(f"{where}.folder: {target} no existe.")
            elif not os.path.realpath(target).startswith(os.path.realpath(workspace) + os.sep):
                r.error(f"{where}.folder: {folder} sale del workspace (¿enlace simbólico?).")
            elif not (target / "STATE.md").is_file():
                r.warn(f"{where}: {folder}/STATE.md no existe todavía (el instalador puede crearlo).")
        for repo in check_list(r, f"{where}.github_repos", proj.get("github_repos"), 8):
            if not isinstance(repo, str) or not REPO.match(repo):
                r.error(f"{where}.github_repos: «{repo}» debe tener la forma usuario/repositorio.")
        coll = proj.get("library_collection")
        if coll is not None and (not isinstance(coll, str) or not COLLECTION.match(coll)
                                 or coll.startswith(".")):
            r.error(f"{where}.library_collection: nombre de subcarpeta sin «/» (máx. 60).")
        cdir = proj.get("cluster_dir")
        if cdir is not None and not is_relative_ok(cdir):
            r.error(f"{where}.cluster_dir: ruta relativa a modules.cluster.remote_home, sin «..».")

    for i, ms in enumerate(check_list(r, "milestones", cfg.get("milestones"), 12)):
        where = f"milestones[{i}]"
        if not isinstance(ms, dict):
            r.error(f"{where}: debe ser un objeto.")
            continue
        check_unknown(r, where, ms, {"title", "date", "meta"})
        check_str(r, f"{where}.title", ms.get("title"), 1, 80)
        try:
            dt.date.fromisoformat(str(ms.get("date")))
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(ms.get("date"))):
                raise ValueError
        except ValueError:
            r.error(f"{where}.date: debe ser una fecha AAAA-MM-DD válida.")
        if ms.get("meta") is not None:
            check_str(r, f"{where}.meta", ms.get("meta"), 0, 60)

    for i, link in enumerate(check_list(r, "links", cfg.get("links"), 12)):
        where = f"links[{i}]"
        if not isinstance(link, dict):
            r.error(f"{where}: debe ser un objeto.")
            continue
        check_unknown(r, where, link, {"label", "url", "app", "icon"})
        check_str(r, f"{where}.label", link.get("label"), 1, 32)
        has_url, has_app = "url" in link, "app" in link
        if has_url == has_app:
            r.error(f"{where}: necesita «url» o «app», pero no ambos.")
        if has_url and (not isinstance(link["url"], str) or not URL.match(link["url"])):
            r.error(f"{where}.url: solo se permiten https://, http://, obsidian://, zotero:// y vscode://.")
        if has_app:
            app = link["app"]
            if not isinstance(app, str) or not APP.match(app):
                r.error(f"{where}.app: nombre de aplicación sin «/» ni «:».")
            elif not any(Path(base, f"{app}.app").exists() for base in
                         ("/Applications", "/System/Applications", str(Path.home() / "Applications"))):
                r.warn(f"{where}.app: no encuentro «{app}.app» en /Applications.")
        if link.get("icon", None) not in ICONS:
            r.error(f"{where}.icon: «{link.get('icon')}» no es un icono incluido (usa null para la inicial).")

    modules = cfg.get("modules")
    if not isinstance(modules, dict):
        if "modules" in cfg:
            r.error("modules: debe ser un objeto.")
        modules = {}
    check_unknown(r, "modules", modules, set(MODULE_KEYS))
    on = {}
    for name, keys in MODULE_KEYS.items():
        mod = modules.get(name)
        if mod is None:
            on[name] = False
            continue
        if not isinstance(mod, dict) or not isinstance(mod.get("enabled"), bool):
            r.error(f"modules.{name}: debe ser un objeto con «enabled»: true o false.")
            on[name] = False
            continue
        check_unknown(r, f"modules.{name}", mod, keys)
        on[name] = mod["enabled"]

    def mod(name: str) -> dict:
        value = modules.get(name)
        return value if isinstance(value, dict) else {}

    # Como la app: los campos presentes se validan siempre (aunque el módulo
    # esté desactivado) y los obligatorios solo se exigen si está activado.
    mail = mod("mail")
    accounts = check_list(r, "modules.mail.accounts", mail.get("accounts"), 4)
    if on["mail"] and not accounts:
        r.error("modules.mail: activado pero sin cuentas.")
    for i, acc in enumerate(accounts):
        where = f"modules.mail.accounts[{i}]"
        if not isinstance(acc, dict):
            r.error(f"{where}: debe ser un objeto.")
            continue
        check_unknown(r, where, acc, {"label", "mail_account", "address"})
        check_str(r, f"{where}.label", acc.get("label"), 1, 32)
        check_str(r, f"{where}.mail_account", acc.get("mail_account"), 1, 80)
        if not isinstance(acc.get("address"), str) or not EMAIL.match(acc["address"]):
            r.error(f"{where}.address: dirección de correo no válida.")

    cal = mod("calendar")
    read = check_list(r, "modules.calendar.read", cal.get("read"), 8)
    write = check_list(r, "modules.calendar.write", cal.get("write"), 4)
    for name in read + write:
        check_str(r, "modules.calendar", name, 1, 80)
    extra = [w for w in write if w not in read]
    if extra:
        r.error(f"modules.calendar.write: {extra} también deben estar en «read».")
    if on["calendar"] and not read:
        r.error("modules.calendar: activado pero sin calendarios en «read».")
    if on["calendar"] and not write:
        r.warn("modules.calendar: sin calendarios de escritura, el Logout no propondrá eventos.")

    mm = mod("mattermost")
    server = mm.get("server")
    if server is not None:
        if not isinstance(server, str) or not server.startswith("https://"):
            r.error("modules.mattermost.server: debe empezar por https://.")
        elif server.rstrip("/").endswith("/api/v4"):
            r.error("modules.mattermost.server: pon solo la dirección del servidor, sin /api/v4.")
    for key in ("team", "username", "keychain_service"):
        if mm.get(key) is not None:
            check_str(r, f"modules.mattermost.{key}", mm.get(key), 1, 64)
    if mm.get("auth") is not None and mm.get("auth") not in ("password", "token"):
        r.error("modules.mattermost.auth: debe ser «password» o «token».")
    for ch in check_list(r, "modules.mattermost.channels", mm.get("channels"), 40):
        check_str(r, "modules.mattermost.channels", ch, 1, 64)
    if mm.get("app") is not None and (not isinstance(mm.get("app"), str) or not APP.match(mm["app"])):
        r.error("modules.mattermost.app: nombre de la app (sin «/» ni «:») o null.")
    if on["mattermost"]:
        missing = [k for k in ("server", "team", "username", "auth", "keychain_service") if mm.get(k) is None]
        if missing:
            r.error(f"modules.mattermost: activado pero faltan {', '.join(missing)}.")

    if on["github"] and not tools.get("gh"):
        r.warn("modules.github: activado pero tools.gh es null; el módulo no podrá leer GitHub.")

    folder = mod("library").get("folder")
    if folder is not None and not is_relative_ok(folder):
        r.error("modules.library.folder: ruta relativa al workspace, sin «..».")
    if on["library"]:
        if folder is None:
            r.error("modules.library: activado pero falta «folder».")
        elif workspace is not None and is_relative_ok(folder) and not (workspace / folder).is_dir():
            r.warn(f"modules.library.folder: {workspace / folder} aún no existe.")

    pr = mod("paper_radar")
    cats = check_list(r, "modules.paper_radar.arxiv_categories", pr.get("arxiv_categories"), 8)
    for c in cats:
        if not isinstance(c, str) or not ARXIV.match(c):
            r.error(f"modules.paper_radar.arxiv_categories: «{c}» no parece una categoría de arXiv (p. ej. cs.LG).")
    for k in check_list(r, "modules.paper_radar.keywords", pr.get("keywords"), 40):
        check_str(r, "modules.paper_radar.keywords", k, 2, 80)
    profile = pr.get("profile")
    if profile is not None and not is_relative_ok(profile):
        r.error("modules.paper_radar.profile: ruta relativa al workspace (normalmente Esprit/perfil-investigacion.md).")
    if on["paper_radar"]:
        if not on["library"]:
            r.error("modules.paper_radar: necesita modules.library activado.")
        if not cats:
            r.warn("modules.paper_radar: activado pero sin categorías de arXiv.")
        if profile is None:
            r.warn("modules.paper_radar: sin «profile», el Radar se omite.")
        elif workspace is not None and is_relative_ok(profile) and not (workspace / profile).is_file():
            r.warn(f"modules.paper_radar.profile: {workspace / profile} no existe; sin perfil, el Radar se omite.")

    cl = mod("cluster")
    if cl.get("label") is not None:
        check_str(r, "modules.cluster.label", cl.get("label"), 1, 32)
    alias = cl.get("ssh_alias")
    if alias is not None and (not isinstance(alias, str) or not ALIAS.match(alias) or alias[0] in "-."):
        r.error("modules.cluster.ssh_alias: alias de ~/.ssh/config (letras, números, . _ -; sin «-» ni «.» inicial).")
    home = cl.get("remote_home")
    if home is not None and (not isinstance(home, str) or not home.startswith("/") or home == "/"
                             or ".." in home.split("/") or any(ch in home for ch in "'\"`$\\")):
        r.error("modules.cluster.remote_home: ruta absoluta en el clúster (p. ej. /home/usuario), sin comillas ni $.")
    if cl.get("scheduler") is not None and cl.get("scheduler") not in ("slurm", "none"):
        r.error("modules.cluster.scheduler: «slurm» o «none».")
    ju = cl.get("jupyter_url")
    if ju is not None and (not isinstance(ju, str) or not ju.startswith("https://")):
        r.error("modules.cluster.jupyter_url: debe empezar por https:// o ser null.")
    if on["cluster"]:
        missing = [k for k in ("ssh_alias", "remote_home", "scheduler") if cl.get(k) is None]
        if missing:
            r.error(f"modules.cluster: activado pero faltan {', '.join(missing)}.")

    if on["latex"] and not tools.get("latexmk"):
        r.warn("modules.latex: activado pero tools.latexmk es null; no se podrá compilar.")

    appearance = cfg.get("appearance")
    if isinstance(appearance, dict):
        check_unknown(r, "appearance", appearance, {"palette", "theme", "home_wallpaper"})
        if "palette" in appearance and (not isinstance(appearance["palette"], str)
                                        or not PALETTE.match(appearance["palette"])):
            r.error("appearance.palette: identificador de paleta no válido.")
        if "theme" in appearance and appearance["theme"] not in ("light", "dark"):
            r.error("appearance.theme: «light» o «dark».")
        if "home_wallpaper" in appearance and not isinstance(appearance["home_wallpaper"], bool):
            r.error("appearance.home_wallpaper: true o false.")
        if appearance.get("home_wallpaper") and isinstance(src, str):
            if not Path(src, "public/custom/home-wallpaper.png").is_file():
                r.warn("appearance.home_wallpaper: falta public/custom/home-wallpaper.png en el repo "
                       "(la imagen se incluye al compilar).")

    cfg["_slugs"] = sorted(slugs)
    return workspace


def check_state(path: Path, config_slugs: list[str], r: Report) -> None:
    where = "Esprit/STATE.md"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        r.error(f"{where}: no se pudo leer ({error}).")
        return
    updated = logout = None
    seen: list[str] = []
    section = ""
    focus: dict[str, str] = {}
    projects: list[tuple[str, dict[str, str]]] = []
    bullets: dict[str, list[str]] = {name: [] for name in HUMAN_SECTIONS}
    if not text.lstrip().startswith("# Doctorado — estado global"):
        r.warn(f"{where}: la primera línea debería ser «# Doctorado — estado global».")
    for raw in text.splitlines():
        line = raw.strip()
        for prefix, label in (("> Última actualización:", "Última actualización"),
                              ("> Último logout:", "Último logout")):
            if line.startswith(prefix):
                value = line[len(prefix):].strip()
                if (updated if label.startswith("Última") else logout) is not None:
                    r.error(f"{where}: «{label}» aparece más de una vez.")
                if label.startswith("Última"):
                    updated = value
                else:
                    logout = value
        if line.startswith("## "):
            heading = line[3:].strip()
            if heading in seen:
                r.error(f"{where}: la sección «{heading}» aparece más de una vez.")
            seen.append(heading)
            section = heading
            continue
        if section == "Radar de proyectos" and line.startswith("### "):
            projects.append((line[4:].strip(), {}))
            continue
        m = re.match(r"^- ([^:]+):(.*)$", line)
        if section == "Foco" and m:
            focus[m.group(1).strip()] = m.group(2).strip()
        elif section == "Radar de proyectos" and m and projects:
            projects[-1][1][m.group(1).strip()] = m.group(2).strip()
        elif section in bullets and line.startswith("- "):
            bullets[section].append(line[2:])
        elif section in bullets and line and raw[:1] in (" ", "\t") and bullets[section]:
            bullets[section][-1] += " " + line

    if not updated:
        r.error(f"{where}: falta «> Última actualización: AAAA-MM-DD HH:MM Zona/IANA».")
    elif not STAMP.match(updated):
        r.error(f"{where}: «Última actualización» debe tener la forma AAAA-MM-DD HH:MM Zona/IANA.")
    if not logout:
        r.error(f"{where}: falta «> Último logout: AAAA-MM-DD HH:MM Zona/IANA» (o «nunca»).")
    elif logout != "nunca" and not STAMP.match(logout):
        r.error(f"{where}: «Último logout» debe ser «nunca» o AAAA-MM-DD HH:MM Zona/IANA.")
    for name in STATE_SECTIONS:
        if name not in seen:
            r.error(f"{where}: falta la sección «## {name}».")
    for key in FOCUS_FIELDS:
        if not focus.get(key):
            r.error(f"{where}: falta «- {key}:» en Foco.")
    radar_slugs = []
    for slug, fields in projects:
        if not slug:
            r.error(f"{where}: hay un proyecto sin slug en el Radar.")
            continue
        if slug in radar_slugs:
            r.error(f"{where}: el proyecto «{slug}» aparece más de una vez.")
        radar_slugs.append(slug)
        for key in PROJECT_FIELDS:
            if not fields.get(key):
                r.error(f"{where}: falta «- {key}:» en el proyecto «{slug}».")
        if fields.get("Estado") and fields["Estado"] not in STATES:
            r.error(f"{where}: Estado «{fields['Estado']}» de «{slug}» no es uno de {sorted(STATES)}.")
        prog = fields.get("Progreso")
        if prog and (not prog.isdigit() or int(prog) > 100):
            r.error(f"{where}: Progreso de «{slug}» debe ser un entero de 0 a 100.")
    if not projects:
        r.error(f"{where}: el Radar de proyectos no tiene ningún proyecto.")
    if focus.get("Proyecto") and focus["Proyecto"] != "general" and focus["Proyecto"] not in radar_slugs:
        r.error(f"{where}: el proyecto en Foco «{focus['Proyecto']}» no está en el Radar.")
    for name, items in bullets.items():
        if name in seen and not items:
            r.error(f"{where}: la sección «{name}» necesita al menos una viñeta «- ».")
    if len(bullets["Cierres diarios recientes"]) > 10:
        r.error(f"{where}: «Cierres diarios recientes» admite como máximo 10 entradas.")
    for item in bullets["Esperando a"]:
        if " — " not in item and " – " not in item:
            r.warn(f"{where}: en «Esperando a», usa «- Responsable — detalle» («{item[:50]}»).")
    missing = [s for s in config_slugs if s not in radar_slugs]
    if missing:
        r.warn(f"{where}: proyectos de la configuración que no están en el Radar: {', '.join(missing)}.")


def main(argv: list[str]) -> int:
    if any(a in ("-h", "--help") for a in argv):
        print(__doc__)
        return 0
    as_json = "--json" in argv
    skip_state = "--sin-estado" in argv
    args = [a for a in argv if not a.startswith("--")]
    path = Path(args[0] if args else os.environ.get("ESPRIT_CONFIG") or
                Path.home() / ".config/esprit/config.json").expanduser()
    r = Report()
    workspace = None
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as error:
        r.error(f"No se pudo leer {path}: {error.strerror or error}.")
        raw = None
    if raw is not None:
        try:
            cfg = json.loads(raw)
        except json.JSONDecodeError as error:
            r.error(f"JSON no válido en la línea {error.lineno}, columna {error.colno}: {error.msg}.")
            cfg = None
        if cfg is not None and not isinstance(cfg, dict):
            r.error("La configuración debe ser un objeto JSON.")
        elif cfg is not None:
            workspace = check_config(cfg, r)
            state = workspace / "Esprit" / "STATE.md" if workspace else None
            if not skip_state and state is not None:
                if state.is_file():
                    check_state(state, cfg.get("_slugs", []), r)
                else:
                    r.warn(f"{state} no existe todavía (lo crea el instalador).")

    if as_json:
        print(json.dumps({"ok": not r.errors, "path": str(path), "errors": r.errors,
                          "warnings": r.warnings}, ensure_ascii=False, indent=2))
    else:
        print(f"Configuración: {path}")
        for msg in r.errors:
            print(f"  ERROR  {msg}")
        for msg in r.warnings:
            print(f"  AVISO  {msg}")
        if not r.errors:
            print("Sin errores." + (" Revisa los avisos." if r.warnings else "")
                  + " La validación definitiva es `esprit --check-config`.")
    return 1 if r.errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
