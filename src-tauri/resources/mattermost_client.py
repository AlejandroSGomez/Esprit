#!/usr/bin/env python3
"""Cliente HTTP mínimo de Mattermost para Esprit (solo biblioteca estándar).

La configuración sale de ``modules.mattermost`` de Esprit. El secreto (la
contraseña o un token de acceso personal) vive en el llavero de macOS y se lee
con ``security find-generic-password -w -s <keychain_service> -a <username>``
solo durante la ejecución del puente: nunca se escribe en disco, en registros
ni en la salida.

- ``auth: "token"``: el secreto se usa directamente como token Bearer y la
  sesión no se cierra al terminar (cerrarla revocaría el token personal).
- ``auth: "password"``: se inicia sesión con usuario y contraseña, se usa el
  token de sesión que devuelve el servidor y se cierra al terminar.
"""

from __future__ import annotations

import datetime as dt
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))

import esprit_config  # noqa: E402


USER_AGENT = "esprit-mattermost/1.0"
SECURITY_BINARY = "/usr/bin/security"
KEYCHAIN_TIMEOUT_SECONDS = 60
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
MAX_AUTO_CHANNELS = 40
MAX_USER_LOOKUP = 200
CHANNEL_TYPES = ("O", "P", "D", "G")


class MattermostError(RuntimeError):
    def __init__(self, message: str, status: Optional[int] = None) -> None:
        super().__init__(message)
        self.status = status


def valid_identifier(value: Any) -> bool:
    return isinstance(value, str) and 1 <= len(value) <= 64 and value.isascii() and value.isalnum()


def read_keychain_secret(service: str, account: str, runner: Callable[..., Any] = subprocess.run) -> str:
    try:
        result = runner(
            [SECURITY_BINARY, "find-generic-password", "-w", "-s", service, "-a", account],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=KEYCHAIN_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise MattermostError("No se pudo consultar el llavero de macOS") from None
    secret = (result.stdout or "").rstrip("\r\n")
    if result.returncode != 0 or not secret:
        raise MattermostError(
            f"No se encontró el secreto de Mattermost en el llavero (servicio «{service}», cuenta «{account}»). "
            f"Guárdalo con: security add-generic-password -s {service} -a {account} -w"
        )
    return secret


def _http_error_message(code: int, detail: str) -> str:
    detail = " ".join(detail.split())[:300]
    if code == 401:
        return (
            "Mattermost rechazó la autenticación (HTTP 401). Revisa el secreto del llavero "
            "y modules.mattermost.auth"
        )
    if code == 403:
        return f"Mattermost denegó el acceso (HTTP 403){': ' + detail if detail else ''}"
    return f"{detail or 'Mattermost devolvió un error'} (HTTP {code})"


class MattermostClient:
    def __init__(
        self,
        api_base: str,
        timezone_name: str,
        timeout: float = 20.0,
        opener: Callable[..., Any] = urlopen,
    ) -> None:
        self.base = api_base.rstrip("/")
        self.timezone_name = timezone_name
        self.timeout = timeout
        self._opener = opener
        self.token: Optional[str] = None
        self.session_login = False
        self.user_cache: Dict[str, str] = {}

    def _request(
        self,
        method: str,
        path: str,
        payload: Any = None,
        authenticate: bool = True,
        retry: bool = True,
    ) -> Tuple[Any, Dict[str, str]]:
        if not path.startswith("/") or any(character.isspace() for character in path):
            raise MattermostError("Ruta interna de Mattermost no válida")
        headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if authenticate:
            if not self.token:
                raise MattermostError("La sesión de Mattermost no está iniciada")
            headers["Authorization"] = f"Bearer {self.token}"
        request = Request(f"{self.base}{path}", data=body, headers=headers, method=method)
        try:
            with self._opener(request, timeout=self.timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                response_headers = {key.lower(): value for key, value in response.headers.items()}
        except HTTPError as error:
            if error.code == 429 and retry:
                try:
                    delay = float(error.headers.get("Retry-After", "2"))
                except (TypeError, ValueError):
                    delay = 2.0
                time.sleep(min(max(delay, 0.5), 30.0))
                return self._request(method, path, payload, authenticate, retry=False)
            try:
                detail = str(json.loads(error.read(64 * 1024)).get("message") or "")
            except Exception:
                detail = ""
            raise MattermostError(_http_error_message(error.code, detail), status=error.code) from None
        except URLError as error:
            raise MattermostError(f"No se pudo conectar con Mattermost: {error.reason}") from None
        except (OSError, ValueError):
            raise MattermostError("No se pudo conectar con Mattermost") from None
        if len(raw) > MAX_RESPONSE_BYTES:
            raise MattermostError("La respuesta de Mattermost supera el límite seguro")
        try:
            data = json.loads(raw) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise MattermostError("Mattermost devolvió una respuesta no válida") from None
        return data, response_headers

    # --- Autenticación ---------------------------------------------------

    def login(self, login_id: str, password: str) -> None:
        _, headers = self._request(
            "POST",
            "/users/login",
            payload={"login_id": login_id, "password": password},
            authenticate=False,
        )
        token = headers.get("token")
        if not token:
            raise MattermostError("Mattermost aceptó el inicio de sesión pero no devolvió un token de sesión")
        self.token = token
        self.session_login = True

    def use_token(self, token: str) -> None:
        self.token = token
        self.session_login = False

    def logout(self) -> None:
        """Closes only sessions opened by :meth:`login`; personal tokens are never revoked."""
        if not self.token:
            return
        try:
            if self.session_login:
                self._request("POST", "/users/logout", payload={})
        except MattermostError:
            pass
        finally:
            self.token = None
            self.session_login = False

    close = logout

    # --- Lecturas ----------------------------------------------------------

    def get(self, path: str) -> Any:
        return self._request("GET", path)[0]

    def post(self, path: str, payload: Dict[str, Any]) -> Any:
        # Mattermost implements search as POST; this helper exposes nothing else.
        if not path.endswith("/posts/search"):
            raise MattermostError("Operación POST no permitida")
        return self._request("POST", path, payload=payload)[0]

    def username(self, user_id: str) -> str:
        if not valid_identifier(user_id):
            return user_id
        if user_id not in self.user_cache:
            user = self.get(f"/users/{quote(user_id)}")
            self.user_cache[user_id] = str(user.get("username") or user_id) if isinstance(user, dict) else user_id
        return self.user_cache[user_id]

    def enrich_post(self, post: Dict[str, Any]) -> Dict[str, Any]:
        value = dict(post)
        value["username"] = self.username(str(post.get("user_id", "")))
        create_at = int(post.get("create_at", 0) or 0)
        if create_at:
            value["created_local"] = dt.datetime.fromtimestamp(
                create_at / 1000, tz=ZoneInfo(self.timezone_name)
            ).isoformat(timespec="minutes")
        return value

    def search_team(self, team_id: str, terms: str, is_or_search: bool = False) -> List[Dict[str, Any]]:
        data = self.post(
            f"/teams/{quote(team_id)}/posts/search",
            {"terms": terms, "is_or_search": is_or_search},
        )
        posts = data.get("posts", {}) if isinstance(data, dict) else {}
        order = data.get("order", list(posts)) if isinstance(data, dict) else []
        return [self.enrich_post(posts[post_id]) for post_id in reversed(order) if post_id in posts]

    def thread(self, post_id: str) -> List[Dict[str, Any]]:
        data = self.get(f"/posts/{quote(post_id)}/thread")
        posts = data.get("posts", {}) if isinstance(data, dict) else {}
        order = data.get("order", []) if isinstance(data, dict) else []
        return [self.enrich_post(posts[pid]) for pid in order if pid in posts]


def parse_since(value: Optional[str], timezone_name: str) -> Optional[int]:
    if value is None or value.lower() == "all":
        return None
    timezone = ZoneInfo(timezone_name)
    now = dt.datetime.now(timezone)
    lowered = value.lower()
    if lowered == "today":
        target = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif lowered == "yesterday":
        target = (now - dt.timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    elif lowered.endswith("d") and lowered[:-1].isdigit():
        target = now - dt.timedelta(days=int(lowered[:-1]))
    else:
        try:
            target = dt.datetime.fromisoformat(value)
        except ValueError as error:
            raise ValueError("El rango debe ser today, yesterday, Nd, all o ISO-8601") from error
        if target.tzinfo is None:
            target = target.replace(tzinfo=timezone)
    return int(target.timestamp() * 1000)


def public_post(post: Dict[str, Any]) -> Dict[str, Any]:
    keys = ("id", "channel_id", "root_id", "username", "created_local", "message", "file_ids", "type")
    return {key: post.get(key) for key in keys if post.get(key) not in (None, "", [])}


# --- Sesión y selección de canales ----------------------------------------


def lookup_users(client: MattermostClient, user_ids: List[str]) -> Dict[str, Dict[str, str]]:
    ids = sorted({value for value in user_ids if valid_identifier(value)})[:MAX_USER_LOOKUP]
    if not ids:
        return {}
    try:
        values, _ = client._request("POST", "/users/ids", payload=ids)
    except MattermostError:
        return {}
    users: Dict[str, Dict[str, str]] = {}
    for user in values if isinstance(values, list) else []:
        if not isinstance(user, dict) or user.get("id") not in ids or not user.get("username"):
            continue
        users[user["id"]] = {
            key: str(user.get(key) or "")[:80] for key in ("username", "first_name", "last_name", "nickname")
        }
        client.user_cache[user["id"]] = users[user["id"]]["username"]
    return users


def _direct_counterpart(channel: Dict[str, Any], own_id: str) -> Optional[str]:
    return next(
        (part for part in str(channel.get("name") or "").split("__") if part and part != own_id and valid_identifier(part)),
        None,
    )


def _channel_label(
    channel: Dict[str, Any], counterpart_id: Optional[str], counterpart: Optional[Dict[str, str]]
) -> str:
    if channel.get("type") == "D":
        if counterpart_id is None:
            return "Notas personales"
        if counterpart:
            full_name = " ".join(part for part in (counterpart.get("first_name"), counterpart.get("last_name")) if part)
            return (counterpart.get("nickname") or full_name or counterpart.get("username") or "Mensaje directo")[:100]
        return "Mensaje directo"
    return str(channel.get("display_name") or channel.get("name") or "Canal").strip()[:100]


def select_channels(
    client: MattermostClient,
    own_id: str,
    api_channels: List[Any],
    configured_names: List[str],
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Builds the channel allowlist for this run.

    ``configured_names`` holds channel names (``name``, not display name) or
    ``@usuario`` for a direct message. Empty means every channel of the team
    the user belongs to, including direct and group messages, bounded to the
    ``MAX_AUTO_CHANNELS`` most recently active ones.
    """
    candidates = [
        item
        for item in api_channels
        if isinstance(item, dict)
        and valid_identifier(item.get("id"))
        and item.get("type") in CHANNEL_TYPES
        and not int(item.get("delete_at", 0) or 0)
    ]
    counterparts = {
        item["id"]: other
        for item in candidates
        if item.get("type") == "D" and (other := _direct_counterpart(item, own_id))
    }
    users = lookup_users(client, list(counterparts.values()))

    def entry(item: Dict[str, Any]) -> Dict[str, Any]:
        counterpart_id = counterparts.get(item["id"])
        return {
            "id": item["id"],
            "name": str(item.get("name") or ""),
            "type": item["type"],
            "label": _channel_label(item, counterpart_id, users.get(counterpart_id) if counterpart_id else None),
            "registry_slug": None,
            "counterpart_user_id": counterpart_id,
            "last_post_at": int(item.get("last_post_at", 0) or 0),
        }

    warnings: List[str] = []
    excluded: List[Dict[str, Any]] = []
    if configured_names:
        by_name = {str(item.get("name") or "").lower(): item for item in candidates}
        by_direct_user = {
            users[user_id]["username"].lower(): next(item for item in candidates if item["id"] == channel_id)
            for channel_id, user_id in counterparts.items()
            if user_id in users
        }
        selected: List[Dict[str, Any]] = []
        seen: set = set()
        for name in configured_names:
            key = name.strip().lower()
            item = by_direct_user.get(key[1:]) if key.startswith("@") else by_name.get(key)
            if item is None:
                warnings.append(f"No se encontró «{name}» entre tus canales del equipo")
                continue
            if item["id"] not in seen:
                seen.add(item["id"])
                selected.append(entry(item))
        mode = "configured"
    else:
        ordered = sorted(candidates, key=lambda item: int(item.get("last_post_at", 0) or 0), reverse=True)
        selected = [entry(item) for item in ordered[:MAX_AUTO_CHANNELS]]
        excluded = [
            {"id": item["id"], "name": str(item.get("name") or ""), "last_post_at": int(item.get("last_post_at", 0) or 0)}
            for item in ordered[MAX_AUTO_CHANNELS:]
        ]
        mode = "all_member_channels"
    return selected, {
        "mode": mode,
        "warnings": warnings,
        "excluded": excluded,
        "candidate_count": len(candidates),
        "limit": MAX_AUTO_CHANNELS,
    }


def build_session(client: MattermostClient, settings: Dict[str, Any], timezone_name: str) -> Dict[str, Any]:
    me = client.get("/users/me")
    if not isinstance(me, dict) or not valid_identifier(me.get("id")):
        raise MattermostError("Mattermost no devolvió la identidad de la sesión")
    username = str(me.get("username") or "")
    if username.lower() != settings["username"].lower():
        raise MattermostError(
            "El secreto del llavero pertenece a otro usuario de Mattermost distinto de modules.mattermost.username"
        )
    client.user_cache[me["id"]] = username
    missing_team = f"No se encontró el equipo «{settings['team']}» en Mattermost (usa su nombre corto, el de la URL)"
    try:
        team = client.get(f"/teams/name/{quote(settings['team'], safe='')}")
    except MattermostError as error:
        if error.status in (403, 404):
            raise MattermostError(missing_team, status=error.status) from None
        raise
    if not isinstance(team, dict) or not valid_identifier(team.get("id")):
        raise MattermostError(missing_team)
    api_channels = client.get(f"/users/{quote(me['id'])}/teams/{quote(team['id'])}/channels")
    if not isinstance(api_channels, list):
        raise MattermostError("Mattermost no devolvió tus canales del equipo")
    channels, selection = select_channels(client, me["id"], api_channels, settings["channels"])
    return {
        "server": {"url": settings["server"]},
        "team": {
            "id": team["id"],
            "name": str(team.get("display_name") or team.get("name") or settings["team"]),
        },
        "identity": {"user_id": me["id"], "username": username, "timezone": timezone_name},
        "channels": channels,
        "api_channels": {
            item["id"]: item for item in api_channels if isinstance(item, dict) and valid_identifier(item.get("id"))
        },
        "selection": selection,
    }


def open_session(
    config: Dict[str, Any],
    *,
    runner: Callable[..., Any] = subprocess.run,
    opener: Callable[..., Any] = urlopen,
    timeout: float = 20.0,
) -> Tuple[MattermostClient, Dict[str, Any]]:
    """Authenticates with the Keychain secret and resolves team, identity and channels."""
    settings = esprit_config.mattermost_settings(config)
    timezone_name = esprit_config.time_zone_name(config)
    client = MattermostClient(settings["api_base"], timezone_name, timeout=timeout, opener=opener)
    secret = read_keychain_secret(settings["keychain_service"], settings["username"], runner=runner)
    try:
        if settings["auth"] == "token":
            client.use_token(secret)
        else:
            client.login(settings["username"], secret)
    finally:
        secret = ""
    try:
        session = build_session(client, settings, timezone_name)
    except Exception:
        client.logout()
        raise
    return client, session
