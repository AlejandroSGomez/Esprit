#!/usr/bin/env python3
"""Configuración compartida por los puentes de Esprit.

Rust ejecuta cada puente con ``ESPRIT_CONFIG=<ruta absoluta de la config>``.
Este módulo solo usa la biblioteca estándar (Python >= 3.9), no escribe nada
en disco y nunca lee secretos: contraseñas y tokens viven en el llavero de
macOS. La validación es ligera y se limita a los campos que usan los puentes;
la validación completa del esquema la hace Rust al arrancar.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Union
from urllib.parse import urlsplit

try:  # Python >= 3.9
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:  # pragma: no cover - macOS trae 3.9 o posterior
    ZoneInfo = None  # type: ignore[assignment]
    ZoneInfoNotFoundError = Exception  # type: ignore[assignment,misc]


ENV_VAR = "ESPRIT_CONFIG"
MAX_CONFIG_BYTES = 512 * 1024
MAX_MAIL_ACCOUNTS = 4
MAX_MATTERMOST_CHANNELS = 40

SLUG_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")
TIME_ZONE_RE = re.compile(r"[A-Za-z_]+(?:/[A-Za-z0-9_+\-]+){0,2}")
GITHUB_REPO_RE = re.compile(r"[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+")
EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+")
ARXIV_CATEGORY_RE = re.compile(r"[a-z\-]+(?:\.[A-Za-z\-]+)?")

MODULE_LABELS = {
    "mail": "Correo",
    "calendar": "Calendario",
    "mattermost": "Mattermost",
    "github": "GitHub",
    "library": "Biblioteca",
    "paper_radar": "Radar de lectura",
    "cluster": "Clúster",
    "latex": "LaTeX",
    "meetings": "Reuniones",
}


class ConfigError(RuntimeError):
    """Configuración ausente o no válida. El mensaje está en español y no contiene secretos."""


class ModuleNotConfigured(ConfigError):
    """El módulo está desactivado o ausente en la configuración."""


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def config_path(environ: Optional[Mapping[str, str]] = None) -> Path:
    raw = (os.environ if environ is None else environ).get(ENV_VAR, "")
    if not raw or not raw.strip():
        raise ConfigError(
            "Falta la variable de entorno ESPRIT_CONFIG con la ruta de la configuración de Esprit"
        )
    path = Path(raw)
    if not path.is_absolute():
        raise ConfigError("ESPRIT_CONFIG debe ser una ruta absoluta")
    return path


def load_config(path: Optional[Union[str, Path]] = None) -> Dict[str, Any]:
    """Lee y valida por encima la configuración. Sin ruta, usa ESPRIT_CONFIG."""
    target = Path(path) if path is not None else config_path()
    try:
        if not target.is_file():
            raise ConfigError(f"No existe el archivo de configuración: {target}")
        size = target.stat().st_size
        if size > MAX_CONFIG_BYTES:
            raise ConfigError("El archivo de configuración supera el tamaño máximo")
        raw = target.read_bytes()
    except OSError as error:
        raise ConfigError(f"No se pudo leer la configuración: {target}") from error
    try:
        value = json.loads(raw.decode("utf-8"))
    except UnicodeDecodeError as error:
        raise ConfigError("La configuración no está en UTF-8") from error
    except json.JSONDecodeError as error:
        raise ConfigError(
            f"La configuración no es JSON válido (línea {error.lineno}, columna {error.colno})"
        ) from error
    validate_config(value)
    return value


def validate_config(config: Any) -> None:
    if not isinstance(config, dict):
        raise ConfigError("La configuración debe ser un objeto JSON")
    if config.get("version") != 1:
        raise ConfigError("Versión de configuración no admitida (se espera \"version\": 1)")
    time_zone_name(config)
    raw_workspace = config.get("workspace")
    if not isinstance(raw_workspace, str) or not raw_workspace.startswith("/"):
        raise ConfigError("'workspace' debe ser una ruta absoluta")
    if not isinstance(config.get("tools"), dict):
        raise ConfigError("Falta la sección 'tools'")
    if not isinstance(config.get("modules"), dict):
        raise ConfigError("Falta la sección 'modules'")
    raw_projects = config.get("projects")
    if not isinstance(raw_projects, list) or len(raw_projects) > 24:
        raise ConfigError("'projects' debe ser una lista de como máximo 24 proyectos")
    seen: set = set()
    for index, project in enumerate(raw_projects):
        if not isinstance(project, dict):
            raise ConfigError(f"El proyecto {index + 1} no es un objeto")
        slug = _text(project.get("slug"))
        if not SLUG_RE.fullmatch(slug):
            raise ConfigError(f"El proyecto {index + 1} tiene un slug no válido")
        if slug in seen:
            raise ConfigError(f"El slug de proyecto '{slug}' está repetido")
        seen.add(slug)
        if not _text(project.get("name")).strip():
            raise ConfigError(f"El proyecto '{slug}' no tiene nombre")
        _relative_parts(project.get("folder"), f"projects[{slug}].folder")
        repositories = project.get("github_repos", [])
        if not isinstance(repositories, list) or len(repositories) > 8:
            raise ConfigError(f"'github_repos' de '{slug}' debe ser una lista de como máximo 8 repositorios")
        for repository in repositories:
            if not isinstance(repository, str) or not GITHUB_REPO_RE.fullmatch(repository):
                raise ConfigError(f"Repositorio GitHub no válido en '{slug}': usa propietario/nombre")


# --- Secciones generales -------------------------------------------------


def time_zone_name(config: Mapping[str, Any]) -> str:
    value = _text(config.get("time_zone"))
    if not TIME_ZONE_RE.fullmatch(value):
        raise ConfigError("'time_zone' debe ser una zona IANA, por ejemplo Region/Ciudad")
    return value


def time_zone(config: Mapping[str, Any]) -> Any:
    name = time_zone_name(config)
    if ZoneInfo is None:  # pragma: no cover
        raise ConfigError("Esta versión de Python no incluye zoneinfo")
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise ConfigError(f"Zona horaria desconocida: {name}") from error


def workspace(config: Mapping[str, Any], *, must_exist: bool = True) -> Path:
    raw = _text(config.get("workspace"))
    if not raw.startswith("/"):
        raise ConfigError("'workspace' debe ser una ruta absoluta")
    path = Path(raw)
    if must_exist:
        if path.is_symlink():
            raise ConfigError("'workspace' no puede ser un enlace simbólico")
        if not path.is_dir():
            raise ConfigError(f"La carpeta del workspace no existe: {path}")
    return path


def tool_path(config: Mapping[str, Any], name: str) -> Optional[str]:
    """Ruta absoluta de una herramienta de ``tools``, o None si está desactivada."""
    tools = config.get("tools") if isinstance(config.get("tools"), dict) else {}
    value = tools.get(name)
    if value is None:
        return None
    if not isinstance(value, str) or not value.startswith("/"):
        raise ConfigError(f"'tools.{name}' debe ser una ruta absoluta o null")
    if not os.path.isfile(value) or not os.access(value, os.X_OK):
        raise ConfigError(f"'tools.{name}' no apunta a un ejecutable: {value}")
    return value


def projects(config: Mapping[str, Any]) -> List[Dict[str, Any]]:
    values = config.get("projects")
    return [value for value in values if isinstance(value, dict)] if isinstance(values, list) else []


def _relative_parts(value: Any, field: str) -> List[str]:
    if not isinstance(value, str) or not 1 <= len(value) <= 200:
        raise ConfigError(f"'{field}' debe ser una ruta relativa al workspace")
    if value.startswith("/") or "\x00" in value:
        raise ConfigError(f"'{field}' debe ser una ruta relativa al workspace")
    parts = [part for part in value.split("/") if part not in ("", ".")]
    if not parts or any(part == ".." for part in parts):
        raise ConfigError(f"'{field}' no puede salir del workspace")
    return parts


def workspace_path(config: Mapping[str, Any], relative: Any, field: str = "ruta") -> Path:
    """Resuelve una ruta relativa dentro del workspace, sin ``..`` ni enlaces simbólicos."""
    parts = _relative_parts(relative, field)
    root = workspace(config)
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise ConfigError(f"'{field}' pasa por un enlace simbólico")
    try:
        resolved = current.resolve(strict=True)
        resolved.relative_to(root.resolve(strict=True))
    except (OSError, ValueError) as error:
        raise ConfigError(f"'{field}' no existe dentro del workspace") from error
    return resolved


def project_folder(config: Mapping[str, Any], project: Mapping[str, Any]) -> Path:
    slug = _text(project.get("slug")) or "?"
    folder = workspace_path(config, project.get("folder"), f"projects[{slug}].folder")
    if not folder.is_dir():
        raise ConfigError(f"La carpeta del proyecto '{slug}' no es un directorio")
    return folder


# --- Módulos ---------------------------------------------------------------


def module_section(config: Mapping[str, Any], name: str) -> Dict[str, Any]:
    modules = config.get("modules") if isinstance(config.get("modules"), dict) else {}
    section = modules.get(name)
    return section if isinstance(section, dict) else {}


def module_enabled(config: Mapping[str, Any], name: str) -> bool:
    return module_section(config, name).get("enabled") is True


def require_module(config: Mapping[str, Any], name: str) -> Dict[str, Any]:
    if not module_enabled(config, name):
        label = MODULE_LABELS.get(name, name)
        raise ModuleNotConfigured(
            f"{label}: módulo no configurado. Actívalo en la configuración de Esprit (modules.{name})"
        )
    return module_section(config, name)


def mail_accounts(config: Mapping[str, Any]) -> List[Dict[str, str]]:
    """Cuentas de Mail.app con claves estables m0, m1… en el orden de la config."""
    section = require_module(config, "mail")
    raw_accounts = section.get("accounts")
    if not isinstance(raw_accounts, list) or not raw_accounts:
        raise ConfigError("El correo está activado pero modules.mail.accounts está vacío")
    if len(raw_accounts) > MAX_MAIL_ACCOUNTS:
        raise ConfigError(f"modules.mail.accounts admite como máximo {MAX_MAIL_ACCOUNTS} cuentas")
    accounts: List[Dict[str, str]] = []
    seen_names: set = set()
    for index, raw in enumerate(raw_accounts):
        if not isinstance(raw, dict):
            raise ConfigError(f"La cuenta de correo {index + 1} no es un objeto")
        label = _text(raw.get("label")).strip()
        mail_account = _text(raw.get("mail_account"))
        address = _text(raw.get("address")).strip()
        if not 1 <= len(label) <= 32:
            raise ConfigError(f"La cuenta de correo {index + 1} necesita 'label' (1–32 caracteres)")
        if not 1 <= len(mail_account) <= 80 or any(ord(character) < 32 for character in mail_account):
            raise ConfigError(f"La cuenta de correo {index + 1} necesita 'mail_account' (nombre exacto en Mail)")
        if not EMAIL_RE.fullmatch(address) or len(address) > 254:
            raise ConfigError(f"La cuenta de correo {index + 1} tiene una dirección no válida")
        if mail_account in seen_names:
            raise ConfigError(f"La cuenta de Mail '{mail_account}' está repetida")
        seen_names.add(mail_account)
        accounts.append({"key": f"m{index}", "label": label, "mail_account": mail_account, "address": address})
    return accounts


def mattermost_settings(config: Mapping[str, Any]) -> Dict[str, Any]:
    section = require_module(config, "mattermost")
    server = _text(section.get("server")).strip().rstrip("/")
    try:
        parts = urlsplit(server)
    except ValueError as error:
        raise ConfigError("modules.mattermost.server no es una URL válida") from error
    if (
        parts.scheme != "https"
        or not parts.hostname
        or parts.username
        or parts.password
        or parts.query
        or parts.fragment
        or any(character.isspace() for character in server)
    ):
        raise ConfigError("modules.mattermost.server debe ser una URL https:// sin credenciales")
    values: Dict[str, Any] = {"server": server, "api_base": f"{server}/api/v4"}
    for field in ("team", "username", "keychain_service"):
        value = _text(section.get(field)).strip()
        if not 1 <= len(value) <= 64 or any(ord(character) < 32 for character in value):
            raise ConfigError(f"Falta modules.mattermost.{field}")
        values[field] = value
    auth = section.get("auth", "password")
    if auth not in ("password", "token"):
        raise ConfigError("modules.mattermost.auth debe ser 'password' o 'token'")
    values["auth"] = auth
    channels = section.get("channels", [])
    if channels is None:
        channels = []
    if not isinstance(channels, list) or len(channels) > MAX_MATTERMOST_CHANNELS:
        raise ConfigError(f"modules.mattermost.channels admite como máximo {MAX_MATTERMOST_CHANNELS} canales")
    names: List[str] = []
    for channel in channels:
        if not isinstance(channel, str) or not 1 <= len(channel.strip()) <= 64:
            raise ConfigError("Cada canal de modules.mattermost.channels debe ser un nombre de 1–64 caracteres")
        if channel.strip() not in names:
            names.append(channel.strip())
    values["channels"] = names
    return values


def github_repositories(config: Mapping[str, Any]) -> List[Dict[str, str]]:
    """Unión ordenada de projects[].github_repos (sin duplicados, sin distinguir mayúsculas)."""
    values: List[Dict[str, str]] = []
    seen: set = set()
    for project in projects(config):
        slug = _text(project.get("slug"))
        repositories = project.get("github_repos")
        if not SLUG_RE.fullmatch(slug) or not isinstance(repositories, list):
            continue
        for repository in repositories:
            if not isinstance(repository, str) or not GITHUB_REPO_RE.fullmatch(repository):
                continue
            key = repository.lower()
            if key in seen:
                continue
            seen.add(key)
            values.append({"full_name": repository, "project_slug": slug})
    return values


def paper_radar_settings(config: Mapping[str, Any]) -> Dict[str, List[str]]:
    section = require_module(config, "paper_radar")
    categories = section.get("arxiv_categories", [])
    keywords = section.get("keywords", [])
    if not isinstance(categories, list) or len(categories) > 8:
        raise ConfigError("modules.paper_radar.arxiv_categories admite como máximo 8 categorías")
    if not isinstance(keywords, list) or len(keywords) > 40:
        raise ConfigError("modules.paper_radar.keywords admite como máximo 40 palabras clave")
    clean_categories: List[str] = []
    for category in categories:
        if not isinstance(category, str) or not ARXIV_CATEGORY_RE.fullmatch(category):
            raise ConfigError(f"Categoría de arXiv no válida: {category!r}")
        if category not in clean_categories:
            clean_categories.append(category)
    clean_keywords: List[str] = []
    for keyword in keywords:
        if not isinstance(keyword, str):
            raise ConfigError("Cada palabra clave del radar debe ser texto")
        collapsed = " ".join(keyword.split())
        if not 2 <= len(collapsed) <= 80:
            raise ConfigError("Cada palabra clave del radar debe tener entre 2 y 80 caracteres")
        if collapsed not in clean_keywords:
            clean_keywords.append(collapsed)
    if not clean_categories and not clean_keywords:
        raise ConfigError(
            "El radar de lectura necesita al menos una categoría de arXiv o una palabra clave"
        )
    return {"arxiv_categories": clean_categories, "keywords": clean_keywords}
