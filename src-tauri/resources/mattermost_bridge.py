#!/usr/bin/env python3
"""Mattermost bridge for Esprit.

The daily ritual remains strictly read-only. Interactive writes are exposed as
narrow, separately validated operations used only by the Mattermost window.
New posts may optionally target a validated root to create a thread reply.

Server, team, user and followed channels come from ``modules.mattermost`` in
Esprit's configuration (``ESPRIT_CONFIG``); the secret is read from the macOS
Keychain by ``mattermost_client.py`` for the duration of one invocation.
"""

from __future__ import annotations

from urllib.parse import urlsplit

import argparse
import base64
import datetime as dt
import json
import mimetypes
import re
import time
import sys
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))

import esprit_config  # noqa: E402
import mattermost_client  # noqa: E402


MAX_MESSAGE_CHARACTERS = 16_000
MAX_INPUT_BYTES = 30 * 1024 * 1024
MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_UPLOAD_TOTAL_BYTES = 20 * 1024 * 1024
MAX_BINARY_PREVIEW_BYTES = 25 * 1024 * 1024
MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024
MAX_ATTACHMENTS_PER_POST = 20
MAX_INTERACTIVE_POSTS = 1_200
MAX_INTERACTIVE_PAGES = 6
MAX_INTERACTIVE_THREAD_ROOTS = 200
MAX_AVATAR_BYTES = 512 * 1024
MAX_AVATAR_BATCH = 24
MAX_EMOJI_BATCH = 24
MAX_EMOJI_BYTES = 512 * 1024
EMOJI_CATALOG_PAGE_SIZE = 100
MAX_EMOJI_CATALOG_PAGES = 20
SAFE_IMAGE_TYPES = {
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
}
SAFE_TEXT_EXTENSIONS = {
    "c",
    "cc",
    "cpp",
    "csv",
    "h",
    "hpp",
    "jl",
    "json",
    "log",
    "md",
    "markdown",
    "py",
    "r",
    "rs",
    "sh",
    "tex",
    "toml",
    "tsv",
    "txt",
    "yaml",
    "yml",
}


def with_client(callback: Callable[[Any, dict[str, Any]], Any]) -> Any:
    """Runs ``callback(client, session)`` with a freshly authenticated client.

    ``session`` holds ``server``, ``team``, ``identity`` and the resolved
    ``channels`` allowlist for this invocation (see mattermost_client).
    """
    config = esprit_config.load_config()
    client, session = mattermost_client.open_session(config)
    try:
        return callback(client, session)
    finally:
        client.logout()


def channel_label(
    channel: dict[str, Any], api_channel: dict[str, Any] | None = None
) -> str:
    if channel.get("type") in ("D", "G") and channel.get("label"):
        return str(channel["label"])
    live_name = str((api_channel or {}).get("display_name") or "").strip()
    if live_name:
        return live_name
    return str(channel.get("label") or channel.get("name") or "Canal").replace("_", " ")


def valid_identifier(value: Any) -> bool:
    return (
        isinstance(value, str)
        and 1 <= len(value) <= 64
        and value.isascii()
        and value.isalnum()
    )


def configured_channel(config: dict[str, Any], channel_id: str) -> dict[str, Any]:
    if not valid_identifier(channel_id):
        raise RuntimeError("Identificador de canal no válido")
    configured = next(
        (item for item in config["channels"] if item["id"] == channel_id),
        None,
    )
    if configured is None:
        raise RuntimeError("Canal no autorizado")
    return configured


def validate_message(value: Any) -> str:
    if not isinstance(value, str):
        raise RuntimeError("El mensaje no es válido")
    if not value.strip() or len(value) > MAX_MESSAGE_CHARACTERS or "\0" in value:
        raise RuntimeError("El mensaje debe contener entre 1 y 16.000 caracteres")
    return value


def file_extension(name: str, explicit: Any = "") -> str:
    if isinstance(explicit, str) and explicit:
        return explicit.lower().lstrip(".")[:24]
    return Path(name).suffix.lower().lstrip(".")[:24]


def post_attachments(post: dict[str, Any]) -> list[dict[str, Any]]:
    metadata = post.get("metadata") if isinstance(post.get("metadata"), dict) else {}
    metadata_files = metadata.get("files") if isinstance(metadata.get("files"), list) else []
    details = {
        item.get("id"): item
        for item in metadata_files
        if isinstance(item, dict) and valid_identifier(item.get("id"))
    }
    values = []
    seen: set[str] = set()
    for file_id in post.get("file_ids", [])[:MAX_ATTACHMENTS_PER_POST]:
        if not valid_identifier(file_id) or file_id in seen:
            continue
        seen.add(file_id)
        detail = details.get(file_id, {})
        name = str(detail.get("name") or "Adjunto")[:255]
        mime_type = str(detail.get("mime_type") or "application/octet-stream")[:160]
        values.append(
            {
                "id": file_id,
                "name": name,
                "extension": file_extension(name, detail.get("extension")),
                "mime_type": mime_type,
                "size": max(int(detail.get("size", 0) or 0), 0),
            }
        )
    return values


def normalized_post(
    client: Any, config: dict[str, Any], post: dict[str, Any]
) -> dict[str, Any]:
    value = dict(post)
    if not value.get("username") or not value.get("created_local"):
        value = client.enrich_post(value)
    create_at = int(value.get("create_at", 0) or 0)
    update_at = int(value.get("update_at", 0) or 0)
    edit_at = int(value.get("edit_at", 0) or 0)
    delete_at = int(value.get("delete_at", 0) or 0)
    return {
        "id": value.get("id", ""),
        "channel_id": value.get("channel_id", ""),
        "root_id": value.get("root_id", ""),
        "user_id": value.get("user_id", ""),
        "username": value.get("username", ""),
        "created_local": value.get("created_local", ""),
        "message": value.get("message", ""),
        "create_at": create_at,
        "update_at": update_at,
        "edit_at": edit_at,
        "delete_at": delete_at,
        "revision": update_at or create_at,
        "edited": edit_at > 0 or update_at > create_at,
        "is_own": value.get("user_id") == config["identity"]["user_id"],
        "attachments": post_attachments(value),
        "reply_count": max(int(value.get("reply_count", 0) or 0), 0),
        "reactions": normalized_reactions(value, config["identity"]["user_id"]),
    }


def normalized_reactions(post: dict[str, Any], own_id: str) -> list[dict[str, Any]]:
    metadata = post.get("metadata") or {}
    reactions = metadata.get("reactions") or []
    grouped = {}
    for reaction in reactions[:2000]:
        name, user_id = reaction.get("emoji_name", ""), reaction.get("user_id", "")
        if not re.fullmatch(r"[A-Za-z0-9_+\-]{1,64}", name) or not valid_identifier(user_id):
            continue
        grouped.setdefault(name, set()).add(user_id)
    return [{"name": name, "count": len(users), "own": own_id in users}
            for name, users in grouped.items()]


def read_statuses(client: Any, ids: list[str]) -> dict[str, str]:
    ids = list(dict.fromkeys(item for item in ids if valid_identifier(item)))[:100]
    if not ids:
        return {}
    try:
        values, _ = client._request("POST", "/users/status/ids", payload=ids)
        return {item["user_id"]: item["status"] for item in values
                if item.get("user_id") in ids and item.get("status") in ("online", "away", "dnd", "offline")}
    except Exception:
        # Unknown is distinct from offline; a presence failure never hides messages.
        return {}


def sidebar_categories(client: Any, config: dict[str, Any]) -> list[dict[str, Any]]:
    user_id, team_id = config["identity"]["user_id"], config["team"]["id"]
    allowed = {item["id"] for item in config["channels"]}
    try:
        data = client.get(f"/users/{user_id}/teams/{team_id}/channels/categories")
        categories = {item["id"]: item for item in data.get("categories", [])}
        order = data.get("order") or list(categories)
        return [{"id": key, "label": str(categories[key].get("display_name") or "Canales")[:100],
                 "collapsed": bool(categories[key].get("collapsed")),
                 "channel_ids": [cid for cid in categories[key].get("channel_ids", []) if cid in allowed]}
                for key in order if key in categories]
    except Exception:
        return []


def overview(client: Any, config: dict[str, Any]) -> dict[str, Any]:
    user_id = config["identity"]["user_id"]
    team_id = config["team"]["id"]
    channel_by_id = config.get("api_channels")
    if not isinstance(channel_by_id, dict):
        api_channels = client.get(f"/users/{user_id}/teams/{team_id}/channels")
        channel_by_id = {item.get("id"): item for item in api_channels}
    memberships = client.get(f"/users/{user_id}/teams/{team_id}/channels/members")
    member_by_id = {item.get("channel_id"): item for item in memberships}

    values = []
    notification_count = 0
    for configured in config["channels"]:
        channel_id = configured["id"]
        api_channel = channel_by_id.get(channel_id, {})
        member = member_by_id.get(channel_id, {})
        total_messages = int(api_channel.get("total_msg_count", 0) or 0)
        viewed_messages = int(member.get("msg_count", 0) or 0)
        unread_messages = max(total_messages - viewed_messages, 0)
        mentions = int(member.get("mention_count", 0) or 0)
        badge = max(unread_messages, mentions) if configured["type"] in ("D", "G") else mentions
        notification_count += badge
        values.append(
            {
                "id": channel_id,
                "name": str(api_channel.get("name") or configured["name"]),
                "label": channel_label(configured, api_channel),
                "type": configured["type"],
                "registry_slug": configured.get("registry_slug"),
                "counterpart_user_id": (
                    configured.get("counterpart_user_id")
                    or next(
                        (
                            item
                            for item in str(api_channel.get("name") or "").split("__")
                            if item and item != user_id and valid_identifier(item)
                        ),
                        None,
                    )
                )
                if configured["type"] == "D"
                else None,
                "last_post_at": int(api_channel.get("last_post_at", 0) or 0),
                "unread_messages": unread_messages,
                "mentions": mentions,
                "badge": badge,
                "restricted": False,
            }
        )

    selection = config.get("selection") if isinstance(config.get("selection"), dict) else {}
    return {
        "connected": True,
        "server": config["server"]["url"],
        "team": config["team"]["name"],
        "identity": config["identity"]["username"],
        "checked_at": int(dt.datetime.now().timestamp() * 1000),
        "notification_count": notification_count,
        "channels": values,
        "categories": sidebar_categories(client, config),
        "statuses": read_statuses(client, [item.get("counterpart_user_id") for item in values]),
        "channel_selection": selection.get("mode", "configured"),
        "warnings": list(selection.get("warnings", []))
        + (
            [
                f"Se muestran los {selection.get('limit')} canales con actividad más reciente; "
                "indica canales concretos en modules.mattermost.channels para elegir otros."
            ]
            if selection.get("excluded")
            else []
        ),
    }


def prefetch_usernames(client: Any, user_ids: Any) -> None:
    """Resolve unknown authors with one bulk read before posts are normalized.

    `enrich_post` otherwise issues one `GET /users/{id}` per unknown author.
    Any failure leaves those per-author reads as the fallback.
    """
    cache = getattr(client, "user_cache", None)
    if not isinstance(cache, dict):
        return
    missing = sorted({user_id for user_id in user_ids if valid_identifier(user_id) and user_id not in cache})[:200]
    if not missing:
        return
    try:
        users, _ = client._request("POST", "/users/ids", payload=missing)
    except Exception:
        return
    for user in users if isinstance(users, list) else []:
        if isinstance(user, dict) and user.get("id") in missing and user.get("username"):
            cache[user["id"]] = user["username"]


def fetch_posts_by_id(client: Any, post_ids: list[str]) -> list[dict[str, Any]]:
    """Read posts in one bulk request, falling back to one read per post.

    Callers still validate channel, root and deletion state for every result.
    """
    if not post_ids:
        return []
    try:
        values, _ = client._request("POST", "/posts/ids", payload=post_ids)
        if isinstance(values, list):
            return [value for value in values if isinstance(value, dict)]
    except Exception:
        pass
    posts = []
    for post_id in post_ids:
        try:
            posts.append(client.get(f"/posts/{quote(post_id)}"))
        except Exception:
            continue
    return [post for post in posts if isinstance(post, dict)]


def interactive_channel_history(
    client: Any,
    config: dict[str, Any],
    channel_id: str,
    *,
    full: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    raw: dict[str, dict[str, Any]] = {}
    complete = False
    pages_read = 0
    page_limit = MAX_INTERACTIVE_PAGES if full else 2
    post_limit = MAX_INTERACTIVE_POSTS if full else 400
    for page in range(page_limit):
        query = urlencode({"page": page, "per_page": 200})
        data = client.get(f"/channels/{quote(channel_id)}/posts?{query}")
        posts_by_id = data.get("posts", {})
        order = data.get("order", [])
        pages_read += 1
        if not order:
            complete = True
            break
        for post_id in order:
            post = posts_by_id.get(post_id, {})
            if post.get("type", "") or int(post.get("delete_at", 0) or 0) > 0:
                continue
            raw[post_id] = post
        if len(order) < 200:
            complete = True
            break

    prefetch_usernames(client, (post.get("user_id") for post in raw.values()))
    selected = {post_id: normalized_post(client, config, post) for post_id, post in raw.items()}
    posts = sorted(
        selected.values(),
        key=lambda post: (int(post.get("create_at", 0) or 0), post.get("id", "")),
    )[-post_limit:]
    observed_ids = {post.get("id") for post in posts}
    missing_roots = sorted(
        {
            post.get("root_id")
            for post in posts
            if post.get("root_id") and post.get("root_id") not in observed_ids
        }
    )[:MAX_INTERACTIVE_THREAD_ROOTS]
    roots_added = 0
    fetched_roots = fetch_posts_by_id(client, missing_roots)
    prefetch_usernames(client, (root.get("user_id") for root in fetched_roots))
    wanted_roots = set(missing_roots)
    for root in fetched_roots:
        root_id = root.get("id")
        if (
            root_id not in wanted_roots
            or root.get("channel_id") != channel_id
            or root.get("root_id")
            or root.get("type", "")
            or int(root.get("delete_at", 0) or 0) > 0
        ):
            continue
        wanted_roots.discard(root_id)
        posts.append(normalized_post(client, config, root))
        roots_added += 1
    posts.sort(
        key=lambda post: (int(post.get("create_at", 0) or 0), post.get("id", ""))
    )
    return posts, {
        "complete": complete,
        "truncated": not complete,
        "pages_read": pages_read,
        "post_limit": post_limit,
        "mode": "full" if full else "recent",
        "returned_count": len(posts),
        "thread_roots_added": roots_added,
        "oldest_included_at": posts[0].get("created_local") if posts else None,
    }


def channel_posts(
    client: Any, config: dict[str, Any], channel_id: str, *, full: bool = False
) -> dict[str, Any]:
    configured = configured_channel(config, channel_id)

    # Consecutive ordinary pages keep edits/deletes authoritative and expose a
    # useful bounded history. `since` is intentionally not mixed with paging.
    posts, history = interactive_channel_history(client, config, channel_id, full=full)
    return {
        "channel": {
            "id": channel_id,
            "label": channel_label(configured),
            "type": configured["type"],
            "restricted": False,
        },
        "posts": posts,
        "history": history,
        "statuses": read_statuses(client, [post.get("user_id") for post in posts]),
    }


def complete_channel_posts(
    client: Any,
    module: Any,
    channel_id: str,
    since_ms: int,
    *,
    per_page: int = 200,
    max_pages: int = 50,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Page consecutive channel history until the requested time boundary.

    Mattermost's `since` mode is server-capped and may contain holes, so the
    ritual uses ordinary consecutive pages and stops only after crossing the
    requested creation timestamp. A high explicit guard prevents an unbounded
    response; hitting it is reported as partial coverage, never as complete.
    """

    selected: dict[str, dict[str, Any]] = {}
    complete = False
    pages_read = 0
    for page in range(max_pages):
        query = urlencode({"page": page, "per_page": per_page})
        data = client.get(f"/channels/{quote(channel_id)}/posts?{query}")
        posts = data.get("posts", {})
        order = data.get("order", [])
        pages_read += 1
        if not order:
            complete = True
            break

        crossed_boundary = False
        for post_id in order:
            post = posts.get(post_id, {})
            created_at = int(post.get("create_at", 0) or 0)
            if created_at < since_ms:
                crossed_boundary = True
                continue
            if post.get("type", "") or int(post.get("delete_at", 0) or 0) > 0:
                continue
            selected[post_id] = module.public_post(client.enrich_post(post))

        if crossed_boundary or len(order) < per_page:
            complete = True
            break

    values = sorted(
        selected.values(),
        key=lambda post: (post.get("created_local", ""), post.get("id", "")),
    )
    return values, {
        "complete": complete,
        "truncated": not complete,
        "page_limit": max_pages,
        "pages_read": pages_read,
        "returned_count": len(values),
        "oldest_included_at": values[0].get("created_local") if values else None,
        "basis": "consecutive_create_at_pages",
    }


def daily_sweep(client: Any, config: dict[str, Any], since: str) -> dict[str, Any]:
    """Read every followed channel for a user-confirmed daily ritual.

    This intentionally fetches message metadata and text only. File identifiers
    are retained as context, but attachments and links are never opened.
    """

    module = mattermost_client
    timezone_name = config["identity"]["timezone"]
    since_ms = module.parse_since(since, timezone_name)
    if since_ms is None:
        raise RuntimeError("El ritual diario necesita un rango temporal acotado")

    channels = []
    channel_coverage = []
    observed_post_ids: set[str] = set()
    missing_roots: set[str] = set()
    for configured in config["channels"]:
        public, coverage = complete_channel_posts(
            client,
            module,
            configured["id"],
            since_ms,
        )
        observed_post_ids.update(
            post_id for post_id in (post.get("id") for post in public) if post_id
        )
        missing_roots.update(
            root_id for root_id in (post.get("root_id") for post in public) if root_id
        )
        channels.append(
            {
                "id": configured["id"],
                "name": configured["name"],
                "label": channel_label(configured),
                "type": configured["type"],
                "registry_slug": configured.get("registry_slug"),
                "posts": public,
            }
        )
        channel_coverage.append(
            {
                "id": configured["id"],
                "name": configured["name"],
                "label": channel_label(configured),
                **coverage,
            }
        )

    thread_context = []
    for root_id in sorted(missing_roots - observed_post_ids):
        posts = client.thread(root_id)
        thread_context.append(
            {
                "root_id": root_id,
                "posts": [
                    module.public_post(post)
                    for post in posts
                    if int(post.get("delete_at", 0) or 0) == 0
                ],
            }
        )

    timezone = ZoneInfo(timezone_name)
    since_date = dt.datetime.fromtimestamp(since_ms / 1000, tz=timezone).date().isoformat()
    username = config["identity"]["username"]
    mentions = client.search_team(config["team"]["id"], f"@{username} after:{since_date}", False)

    # With an automatic (bounded) selection, a channel left out is a coverage
    # gap only if it had activity inside the requested window.
    selection = config.get("selection") if isinstance(config.get("selection"), dict) else {}
    excluded_recent = [
        item.get("name", "")
        for item in selection.get("excluded", [])
        if int(item.get("last_post_at", 0) or 0) >= since_ms
    ]
    complete_channels = all(item["complete"] for item in channel_coverage)
    return {
        "status": "fresh" if complete_channels and not excluded_recent else "partial",
        "authorization": "Esprit Login/Logout button",
        "read_only": True,
        "since": since,
        "checked_at": dt.datetime.now(timezone).isoformat(timespec="seconds"),
        "coverage": {
            "configured_channel_posts_complete": complete_channels,
            "configured_direct_messages": True,
            "configured_channel_mentions_complete": complete_channels,
            "supplemental_team_mention_search": "server_bounded",
            "missing_thread_roots": True,
            "attachments_opened": False,
            "channel_selection": selection.get("mode", "configured"),
            "excluded_active_channels": len(excluded_recent),
            "channels": channel_coverage,
        },
        "channels": channels,
        "mentions": [
            module.public_post(post)
            for post in mentions
            if int(post.get("delete_at", 0) or 0) == 0
        ],
        "thread_context": thread_context,
    }


def module_parse_since(value: str, timezone_name: str) -> int:
    parsed = mattermost_client.parse_since(value, timezone_name)
    if parsed is None:
        raise RuntimeError("Rango temporal inválido")
    return parsed


def read_stdin_payload() -> dict[str, Any]:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise RuntimeError("La solicitud de Mattermost supera el límite seguro")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("La solicitud de Mattermost no es JSON válido") from error
    if not isinstance(value, dict):
        raise RuntimeError("La solicitud de Mattermost no es un objeto")
    return value


def send_message(
    client: Any, config: dict[str, Any], payload: dict[str, Any]
) -> dict[str, Any]:
    channel_id = payload.get("channel_id")
    configured_channel(config, channel_id)
    message = validate_message(payload.get("message"))
    root_id = payload.get("root_id")
    request_payload = {"channel_id": channel_id, "message": message}
    if root_id not in (None, ""):
        if not valid_identifier(root_id):
            raise RuntimeError("Identificador de hilo no válido")
        root = client.get(f"/posts/{quote(root_id)}")
        if not isinstance(root, dict) or root.get("id") != root_id:
            raise RuntimeError("Mattermost no devolvió el mensaje raíz")
        if root.get("channel_id") != channel_id:
            raise RuntimeError("El hilo no pertenece al canal seleccionado")
        if int(root.get("delete_at", 0) or 0) > 0:
            raise RuntimeError("El mensaje raíz fue eliminado")
        if root.get("root_id"):
            raise RuntimeError("La respuesta debe apuntar al inicio del hilo")
        request_payload["root_id"] = root_id
    value, _ = client._request(
        "POST",
        "/posts",
        payload=request_payload,
    )
    if not isinstance(value, dict):
        raise RuntimeError("Mattermost no devolvió el mensaje publicado")
    return normalized_post(client, config, value)


def require_live_post(client: Any, config: dict[str, Any], channel_id: str, post_id: str) -> dict[str, Any]:
    configured_channel(config, channel_id)
    if not valid_identifier(post_id):
        raise RuntimeError("Identificador de mensaje no válido")
    post = client.get(f"/posts/{post_id}")
    if not isinstance(post, dict) or post.get("id") != post_id or post.get("channel_id") != channel_id or post.get("delete_at", 0):
        raise RuntimeError("El mensaje ya no está disponible en este canal")
    return post


def post_links(message: str) -> list[str]:
    links = []
    for match in re.finditer(r"https?://(?:\[[0-9a-fA-F:]+\]|[^\s<>\"\x00-\x1f\[\]])+", message, re.IGNORECASE):
        url = match.group().rstrip(".,;:!?'*")
        for opening, closing in (("(", ")"), ("[", "]"), ("{", "}")):
            while url.endswith(closing) and url.count(closing) > url.count(opening):
                url = url[:-1]
        try:
            parsed = urlsplit(url)
            if parsed.hostname and not parsed.username and not parsed.password and len(url) <= 4096 and url not in links:
                links.append(url)
        except ValueError:
            continue
    return links


def channel_resources(client: Any, config: dict[str, Any], channel_id: str, cursor: Any) -> dict[str, Any]:
    configured_channel(config, channel_id)
    query: dict[str, Any] = {"per_page": 200}
    if cursor is not None:
        require_live_post(client, config, channel_id, cursor)
        query["before"] = cursor
    data = client.get(f"/channels/{channel_id}/posts?{urlencode(query)}")
    order = data.get("order", [])
    raw = data.get("posts", {})
    selected = []
    for post_id in order:
        post = raw.get(post_id, {})
        if post.get("channel_id") != channel_id or post.get("delete_at") or post.get("type"):
            continue
        links = post_links(str(post.get("message") or ""))
        if post.get("file_ids") or links:
            selected.append((post, links))
    posts = []
    for post, links in selected:
        value = normalized_post(client, config, post)
        value["links"] = links
        value["message"] = value["message"][:2000]
        posts.append(value)
    next_cursor = order[-1] if len(order) >= 200 else None
    if next_cursor and (not valid_identifier(next_cursor) or next_cursor == cursor
                        or raw.get(next_cursor, {}).get("channel_id") != channel_id):
        raise RuntimeError("El historial no avanzó; vuelve a actualizar los recursos del canal")
    return {"posts": posts, "next_cursor": next_cursor, "scanned_count": len(order),
            "checked_at": int(time.time() * 1000)}


def workspace_read(client: Any, config: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    operation = payload.get("operation")
    if operation == "inbox":
        page = payload.get("page", 0)
        if type(page) is not int or not 0 <= page < 20:
            raise RuntimeError("Página de threads no válida")
        allowed = {item["id"] for item in config["channels"]}
        user_id, team_id = config["identity"]["user_id"], config["team"]["id"]
        data = client.get(f"/users/{user_id}/teams/{team_id}/threads?{urlencode({'page': page, 'per_page': 50, 'extended': 'false'})}")
        raw = data.get("threads") or []
        posts = []
        for thread in raw[:50]:
            post = thread.get("post") or {}
            # Filter before enrichment: no protected body, author lookup or file
            # is projected into the app or any ritual snapshot.
            if post.get("channel_id") not in allowed or post.get("delete_at"):
                continue
            value = normalized_post(client, config, post)
            value["reply_count"] = max(value["reply_count"], int(thread.get("reply_count", 0) or 0))
            value["unread_replies"] = max(int(thread.get("unread_replies", 0) or 0), 0)
            posts.append(value)
        return {"posts": posts, "next_page": page + 1 if len(raw) >= 50 and page < 19 else None}
    channel_id = payload.get("channel_id")
    configured_channel(config, channel_id)
    if operation == "resources":
        return channel_resources(client, config, channel_id, payload.get("cursor"))
    if operation == "thread":
        post = require_live_post(client, config, channel_id, payload.get("post_id"))
        root_id = post.get("root_id") or post["id"]
        require_live_post(client, config, channel_id, root_id)
        cursor = payload.get("cursor")
        query = {"perPage": 100, "direction": "down"}
        if cursor:
            cursor_post = require_live_post(client, config, channel_id, cursor)
            if (cursor_post.get("root_id") or cursor_post["id"]) != root_id:
                raise RuntimeError("La página no pertenece a este hilo")
            query["fromPost"] = cursor
        data = client.get(f"/posts/{root_id}/thread?{urlencode(query)}")
        raw = [value for value in data.get("posts", {}).values()
               if value.get("channel_id") == channel_id and (value.get("root_id") or value.get("id")) == root_id and not value.get("delete_at")]
        raw.sort(key=lambda item: (item.get("create_at", 0), item.get("id", "")))
        posts = [normalized_post(client, config, item) for item in raw[:101]]
        return {"posts": posts, "root_id": root_id,
                "next_cursor": posts[-1]["id"] if len(posts) >= 100 and posts[-1]["id"] != cursor else None,
                "statuses": read_statuses(client, [post.get("user_id") for post in posts])}
    if operation == "search":
        query = payload.get("query")
        if not isinstance(query, str) or not 2 <= len(query.strip()) <= 300 or any(ord(c) < 32 for c in query):
            raise RuntimeError("Escribe entre 2 y 300 caracteres")
        # This is text search in the selected channel. Never accept user-supplied
        # scope operators that could expand it to protected channels.
        if re.search(r"(?:^|\s)-?[a-zA-Z_]+:", query):
            raise RuntimeError("Busca texto sin operadores; el canal ya está seleccionado")
        live = client.get(f"/channels/{channel_id}")
        name = live.get("name", "")
        if live.get("id") != channel_id or not re.fullmatch(r"[a-zA-Z0-9_.\-]+", name):
            raise RuntimeError("No se pudo determinar el canal de búsqueda")
        data, _ = client._request("POST", f"/teams/{config['team']['id']}/posts/search", payload={
            "terms": f"in:{name} {query.strip()}", "is_or_search": False, "include_deleted_channels": False, "per_page": 100})
        raw = [item for item in data.get("posts", {}).values() if item.get("channel_id") == channel_id and not item.get("delete_at")]
        raw.sort(key=lambda item: item.get("create_at", 0), reverse=True)
        return {"posts": [normalized_post(client, config, item) for item in raw[:100]], "limited": len(raw) >= 100}
    raise RuntimeError("Operación de lectura no autorizada")


def react_message(client: Any, config: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("confirmed") is not True:
        raise RuntimeError("Confirma la reacción")
    post_id, name = payload.get("post_id"), payload.get("emoji_name")
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_+\-]{1,64}", name) or not isinstance(payload.get("remove"), bool):
        raise RuntimeError("Reacción no válida")
    require_live_post(client, config, payload.get("channel_id"), post_id)
    user_id = config["identity"]["user_id"]
    if payload["remove"]:
        client._request("DELETE", f"/users/{user_id}/posts/{post_id}/reactions/{quote(name)}")
    else:
        client._request("POST", "/reactions", payload={"user_id": user_id, "post_id": post_id, "emoji_name": name})
    reactions = client.get(f"/posts/{post_id}/reactions")
    return {"post_id": post_id, "reactions": normalized_reactions({"metadata": {"reactions": reactions}}, user_id)}


def validated_uploads(payload: dict[str, Any]) -> list[tuple[str, bytes]]:
    files = payload.get("files", [])
    if not isinstance(files, list) or len(files) > 5:
        raise RuntimeError("Adjunta como máximo 5 archivos")
    result, total = [], 0
    for file in files:
        if not isinstance(file, dict):
            raise RuntimeError("Adjunto no válido")
        name, encoded = file.get("name"), file.get("data_base64")
        if not isinstance(name, str) or not name.strip() or name in (".", "..") or len(name) > 255 or any(c in name for c in '/\\') or any(ord(c) < 32 for c in name):
            raise RuntimeError("Nombre de adjunto no válido")
        if not isinstance(encoded, str) or len(encoded) > ((MAX_UPLOAD_BYTES + 2) // 3) * 4:
            raise RuntimeError("Cada adjunto admite hasta 8 MB")
        try:
            content = base64.b64decode(encoded, validate=True)
        except Exception as error:
            raise RuntimeError("El adjunto no contiene datos válidos") from error
        total += len(content)
        if not content or len(content) > MAX_UPLOAD_BYTES or total > MAX_UPLOAD_TOTAL_BYTES:
            raise RuntimeError("Máximo 8 MB por archivo y 20 MB en total; no se admiten archivos vacíos")
        result.append((name, content))
    return result


def send_with_files(client: Any, config: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("confirmed") is not True:
        raise RuntimeError("Revisa y confirma el envío")
    channel_id = payload.get("channel_id")
    configured_channel(config, channel_id)
    files = validated_uploads(payload)
    message = payload.get("message")
    if not files or message:
        message = validate_message(message)
    elif message != "":
        raise RuntimeError("Mensaje no válido")
    root_id = payload.get("root_id")
    if root_id:
        root = require_live_post(client, config, channel_id, root_id)
        if root.get("root_id"):
            raise RuntimeError("La respuesta debe apuntar al inicio del hilo")
    # Validate own membership before the first upload, not just at post creation.
    own_id = config["identity"]["user_id"]
    member = client.get(f"/channels/{channel_id}/members/{own_id}")
    if member.get("user_id") != own_id:
        raise RuntimeError("Ya no perteneces a este canal")
    file_ids = []
    try:
        for name, content in files:
            request = Request(f"{client.base}/files?{urlencode({'channel_id': channel_id, 'filename': name})}", data=content,
                              headers={"Authorization": f"Bearer {client.token}", "Content-Type": "application/octet-stream"}, method="POST")
            with urlopen(request, timeout=40) as response:
                uploaded = json.loads(response.read(256 * 1024 + 1))
            infos = uploaded.get("file_infos", [])
            if len(infos) != 1 or not valid_identifier(infos[0].get("id")):
                raise RuntimeError("Mattermost no confirmó el adjunto")
            file_ids.append(infos[0]["id"])
        request_payload = {"channel_id": channel_id, "message": message, "file_ids": file_ids}
        if root_id:
            request_payload["root_id"] = root_id
        value, _ = client._request("POST", "/posts", payload=request_payload)
        if not isinstance(value, dict) or not valid_identifier(value.get("id")):
            raise RuntimeError("Mattermost no confirmó el mensaje")
        return normalized_post(client, config, value)
    except Exception as error:
        # A timeout can occur after the server accepted a file or post. Do not
        # silently retry any write or claim that nothing was published.
        raise RuntimeError("No se pudo confirmar el envío. Comprueba el canal antes de reintentar; pueden haberse subido archivos o publicado el mensaje.") from error


def download_user_avatar(client: Any, user_id: str) -> tuple[bytes, str]:
    request = Request(
        f"{client.base}/users/{quote(user_id)}/image",
        headers={
            "Accept": "image/png,image/jpeg,image/gif,image/webp,image/bmp",
            "Authorization": f"Bearer {client.token}",
            "User-Agent": "esprit-mattermost/1.0",
        },
        method="GET",
    )
    with urlopen(request, timeout=20.0) as response:
        declared = response.headers.get("Content-Length")
        if declared and int(declared) > MAX_AVATAR_BYTES:
            raise RuntimeError("La imagen de perfil supera el límite seguro")
        mime_type = response.headers.get_content_type().lower()
        data = response.read(MAX_AVATAR_BYTES + 1)
    if len(data) > MAX_AVATAR_BYTES:
        raise RuntimeError("La imagen de perfil supera el límite seguro")
    if mime_type not in SAFE_IMAGE_TYPES or not binary_matches_kind(data, "image"):
        raise RuntimeError("La imagen de perfil no tiene un formato compatible")
    return data, mime_type


def avatar_preview(
    client: Any, config: dict[str, Any], payload: dict[str, Any]
) -> dict[str, Any]:
    channel_id = payload.get("channel_id")
    user_id = payload.get("user_id")
    configured_channel(config, channel_id)
    if not valid_identifier(user_id):
        raise RuntimeError("Identificador de usuario no válido")
    membership = client.get(
        f"/channels/{quote(channel_id)}/members/{quote(user_id)}"
    )
    if not isinstance(membership, dict) or membership.get("user_id") != user_id:
        raise RuntimeError("El usuario no pertenece al canal seleccionado")
    data, mime_type = download_user_avatar(client, user_id)
    return {
        "user_id": user_id,
        "mime_type": mime_type,
        "data_base64": base64.b64encode(data).decode("ascii"),
    }


def avatar_batch(
    client: Any, config: dict[str, Any], payload: dict[str, Any]
) -> list[dict[str, Any]]:
    requests = payload.get("requests")
    if not isinstance(requests, list) or not 1 <= len(requests) <= MAX_AVATAR_BATCH:
        raise RuntimeError("El lote de imágenes de perfil no es válido")
    values: list[dict[str, Any]] = []
    seen: set[str] = set()
    for request in requests:
        if not isinstance(request, dict):
            raise RuntimeError("El lote de imágenes de perfil no es válido")
        user_id = request.get("user_id")
        if user_id in seen:
            continue
        seen.add(user_id)
        try:
            values.append(avatar_preview(client, config, request))
        except Exception:
            # One missing/custom avatar must not make the rest of the channel
            # repeat the authenticated request.
            continue
    return values


def emoji_catalog(
    client: Any, config: dict[str, Any], payload: dict[str, Any]
) -> dict[str, Any]:
    """One read-only, names-only page. Never return creator IDs or image URLs."""
    if set(payload) - {"channel_id", "page"}:
        raise RuntimeError("La solicitud de catálogo contiene campos no permitidos")
    channel_id = payload.get("channel_id")
    configured_channel(config, channel_id)
    page = payload.get("page", 0)
    if type(page) is not int or not 0 <= page < MAX_EMOJI_CATALOG_PAGES:
        raise RuntimeError("La página de emojis no es válida")
    user_id = config.get("identity", {}).get("user_id")
    if not valid_identifier(user_id):
        raise RuntimeError("No se pudo verificar la identidad de Mattermost")
    try:
        membership = client.get(f"/channels/{quote(channel_id)}/members/{quote(user_id)}")
    except Exception as error:
        raise RuntimeError("No se pudo verificar el acceso al canal para ver sus emojis") from error
    if (not isinstance(membership, dict) or membership.get("user_id") != user_id
            or membership.get("channel_id") != channel_id):
        raise RuntimeError("La identidad no pertenece al canal seleccionado")
    try:
        entries = client.get("/emoji?" + urlencode({"page": page, "per_page": EMOJI_CATALOG_PAGE_SIZE, "sort": "name"}))
    except Exception as error:
        # Do not label permission/network failures as an empty catalogue or
        # copy server exceptions (which may contain authentication details).
        raise RuntimeError("No se pudo cargar el catálogo de emojis personalizados") from error
    if not isinstance(entries, list) or len(entries) > EMOJI_CATALOG_PAGE_SIZE:
        raise RuntimeError("Mattermost devolvió un catálogo de emojis no válido")
    names: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise RuntimeError("Mattermost devolvió un emoji no válido")
        name = entry.get("name")
        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9_+\-]{1,64}", name):
            raise RuntimeError("Mattermost devolvió un nombre de emoji no válido")
        if entry.get("delete_at", 0):
            continue
        names.add(name)
    full_page = len(entries) == EMOJI_CATALOG_PAGE_SIZE
    next_page = page + 1 if full_page and page + 1 < MAX_EMOJI_CATALOG_PAGES else None
    return {"names": sorted(names), "next_page": next_page,
            "truncated": full_page and next_page is None}


def emoji_batch(
    client: Any, config: dict[str, Any], payload: dict[str, Any]
) -> list[dict[str, Any]]:
    channel_id = payload.get("channel_id")
    configured_channel(config, channel_id)
    names = payload.get("names")
    if not isinstance(names, list) or not 1 <= len(names) <= MAX_EMOJI_BATCH:
        raise RuntimeError("El lote de emojis no es válido")
    values: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw_name in names:
        if not isinstance(raw_name, str) or not re.fullmatch(r"[A-Za-z0-9_+-]{1,64}", raw_name):
            raise RuntimeError("El nombre de emoji no es válido")
        name = raw_name.lower()
        if name in seen:
            continue
        seen.add(name)
        try:
            info = client.get(f"/emoji/name/{quote(name)}")
            emoji_id = info.get("id") if isinstance(info, dict) else None
            if not valid_identifier(emoji_id):
                continue
            request = Request(
                f"{client.base}/emoji/{quote(emoji_id)}/image",
                headers={
                    "Accept": "image/png,image/jpeg,image/gif,image/webp,image/bmp",
                    "Authorization": f"Bearer {client.token}",
                    "User-Agent": "esprit-mattermost/1.0",
                },
                method="GET",
            )
            with urlopen(request, timeout=20.0) as response:
                declared = response.headers.get("Content-Length")
                if declared and int(declared) > MAX_EMOJI_BYTES:
                    continue
                mime_type = response.headers.get_content_type().lower()
                data = response.read(MAX_EMOJI_BYTES + 1)
            if len(data) > MAX_EMOJI_BYTES or mime_type not in SAFE_IMAGE_TYPES or not binary_matches_kind(data, "image"):
                continue
            values.append({"name": name, "mime_type": mime_type, "data_base64": base64.b64encode(data).decode("ascii")})
        except Exception:
            # Built-in or deleted shortcodes remain text and do not fail a channel.
            continue
    return values


def edit_message(
    client: Any, config: dict[str, Any], payload: dict[str, Any]
) -> dict[str, Any]:
    post_id = payload.get("post_id")
    if not valid_identifier(post_id):
        raise RuntimeError("Identificador de mensaje no válido")
    message = validate_message(payload.get("message"))
    expected_update_at = payload.get("expected_update_at")
    if not isinstance(expected_update_at, int) or expected_update_at <= 0:
        raise RuntimeError("La revisión esperada del mensaje no es válida")

    current = client.get(f"/posts/{quote(post_id)}")
    if not isinstance(current, dict):
        raise RuntimeError("Mattermost no devolvió el mensaje actual")
    configured_channel(config, str(current.get("channel_id", "")))
    if int(current.get("delete_at", 0) or 0) > 0:
        raise RuntimeError("El mensaje ya fue eliminado")
    if current.get("user_id") != config["identity"]["user_id"]:
        raise RuntimeError("Solo puedes editar tus propios mensajes")
    current_revision = int(current.get("update_at", 0) or current.get("create_at", 0) or 0)
    if current_revision != expected_update_at:
        raise RuntimeError(
            "stale_post: el mensaje cambió en Mattermost; se conserva tu borrador para revisarlo"
        )

    value, _ = client._request(
        "PUT",
        f"/posts/{quote(post_id)}/patch",
        payload={"message": message},
    )
    if not isinstance(value, dict):
        raise RuntimeError("Mattermost no devolvió el mensaje editado")
    return normalized_post(client, config, value)


def attachment_kind(name: str, mime_type: str) -> str:
    extension = file_extension(name)
    lowered_mime = mime_type.lower().split(";", 1)[0].strip()
    if lowered_mime == "application/pdf" or extension == "pdf":
        return "pdf"
    if lowered_mime in SAFE_IMAGE_TYPES:
        return "image"
    if lowered_mime.startswith("text/") and lowered_mime not in {
        "text/html",
        "text/xml",
    }:
        return "text"
    if extension in SAFE_TEXT_EXTENSIONS:
        return "text"
    return "other"


def binary_matches_kind(data: bytes, kind: str) -> bool:
    if kind == "pdf":
        return data.startswith(b"%PDF-")
    if kind != "image":
        return True
    return (
        data.startswith(b"\x89PNG\r\n\x1a\n")
        or data.startswith(b"\xff\xd8\xff")
        or data.startswith((b"GIF87a", b"GIF89a"))
        or data.startswith(b"BM")
        or (len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP")
    )


def download_attachment_bytes(client: Any, file_id: str, limit: int) -> bytes:
    request = Request(
        f"{client.base}/files/{quote(file_id)}",
        headers={
            "Accept": "application/octet-stream",
            "Authorization": f"Bearer {client.token}",
            "User-Agent": "esprit-mattermost/1.0",
        },
        method="GET",
    )
    with urlopen(request, timeout=30.0) as response:
        declared = response.headers.get("Content-Length")
        if declared and int(declared) > limit:
            raise RuntimeError("El adjunto supera el límite de vista previa")
        data = response.read(limit + 1)
    if len(data) > limit:
        raise RuntimeError("El adjunto supera el límite de vista previa")
    return data


def attachment_metadata(
    client: Any, config: dict[str, Any], file_id: str
) -> dict[str, Any]:
    if not valid_identifier(file_id):
        raise RuntimeError("Identificador de adjunto no válido")
    info = client.get(f"/files/{quote(file_id)}/info")
    if not isinstance(info, dict) or info.get("id") != file_id:
        raise RuntimeError("Mattermost no devolvió los datos del adjunto")
    if int(info.get("delete_at", 0) or 0) > 0:
        raise RuntimeError("El adjunto fue eliminado")

    post_id = info.get("post_id")
    if not valid_identifier(post_id):
        raise RuntimeError("El adjunto no pertenece a un mensaje válido")
    post = client.get(f"/posts/{quote(post_id)}")
    if not isinstance(post, dict) or post.get("id") != post_id:
        raise RuntimeError("No se pudo validar el mensaje del adjunto")
    configured_channel(config, str(post.get("channel_id", "")))
    if int(post.get("delete_at", 0) or 0) > 0:
        raise RuntimeError("El mensaje del adjunto fue eliminado")
    if file_id not in post.get("file_ids", []):
        raise RuntimeError("El adjunto no coincide con el mensaje validado")

    name = str(info.get("name") or "Adjunto")[:255]
    guessed_mime, _ = mimetypes.guess_type(name)
    mime_type = str(info.get("mime_type") or guessed_mime or "application/octet-stream")[:160]
    size = max(int(info.get("size", 0) or 0), 0)
    kind = attachment_kind(name, mime_type)
    result: dict[str, Any] = {
        "id": file_id,
        "name": name,
        "extension": file_extension(name, info.get("extension")),
        "mime_type": mime_type,
        "size": size,
        "kind": kind,
    }
    return result


def attachment_download(client: Any, config: dict[str, Any], file_id: str) -> dict[str, Any]:
    result = attachment_metadata(client, config, file_id)
    if result["size"] > MAX_BINARY_PREVIEW_BYTES:
        raise RuntimeError("El adjunto supera el límite de descarga de 25 MB")
    data = download_attachment_bytes(client, file_id, MAX_BINARY_PREVIEW_BYTES)
    if len(data) != result["size"]:
        raise RuntimeError("La descarga está incompleta o el adjunto cambió de tamaño")
    result["data_base64"] = base64.b64encode(data).decode("ascii")
    return result


def attachment_preview(client: Any, config: dict[str, Any], file_id: str) -> dict[str, Any]:
    result = attachment_metadata(client, config, file_id)
    kind, size = result["kind"], result["size"]
    if kind == "other":
        return result

    limit = MAX_TEXT_PREVIEW_BYTES if kind == "text" else MAX_BINARY_PREVIEW_BYTES
    if size > limit:
        raise RuntimeError("El adjunto supera el límite de vista previa")
    data = download_attachment_bytes(client, file_id, limit)
    if not binary_matches_kind(data, kind):
        raise RuntimeError("El contenido del adjunto no coincide con su formato declarado")
    if kind == "text":
        result["content"] = data.decode("utf-8", errors="replace")
    else:
        result["data_base64"] = base64.b64encode(data).decode("ascii")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("overview")
    channel = subparsers.add_parser("channel")
    channel.add_argument("channel_id")
    channel_history = subparsers.add_parser("channel-history")
    channel_history.add_argument("channel_id")
    sweep = subparsers.add_parser("daily-sweep")
    sweep.add_argument("since", choices=("today", "7d"))
    subparsers.add_parser("send")
    subparsers.add_parser("edit")
    subparsers.add_parser("avatar")
    subparsers.add_parser("avatar-batch")
    subparsers.add_parser("emoji-batch")
    subparsers.add_parser("emoji-catalog")
    for name in ("workspace-read", "reaction", "send-files"):
        subparsers.add_parser(name)
    download = subparsers.add_parser("download-attachment")
    download.add_argument("file_id")
    attachment = subparsers.add_parser("attachment")
    attachment.add_argument("file_id")
    args = parser.parse_args()

    try:
        if args.command == "overview":
            value = with_client(overview)
        elif args.command == "channel":
            value = with_client(
                lambda client, config: channel_posts(
                    client, config, args.channel_id
                )
            )
        elif args.command == "channel-history":
            value = with_client(
                lambda client, config: channel_posts(
                    client, config, args.channel_id, full=True
                )
            )
        elif args.command == "daily-sweep":
            value = with_client(
                lambda client, config: daily_sweep(client, config, args.since)
            )
        elif args.command in ("workspace-read", "reaction", "send-files"):
            payload = read_stdin_payload()
            operation = {"workspace-read": workspace_read, "reaction": react_message, "send-files": send_with_files}[args.command]
            value = with_client(lambda client, config: operation(client, config, payload))
        elif args.command == "send":
            payload = read_stdin_payload()
            value = with_client(
                lambda client, config: send_message(client, config, payload)
            )
        elif args.command == "edit":
            payload = read_stdin_payload()
            value = with_client(
                lambda client, config: edit_message(client, config, payload)
            )
        elif args.command == "download-attachment":
            value = with_client(lambda client, config: attachment_download(client, config, args.file_id))
        elif args.command == "avatar":
            payload = read_stdin_payload()
            value = with_client(
                lambda client, config: avatar_preview(client, config, payload)
            )
        elif args.command == "avatar-batch":
            payload = read_stdin_payload()
            value = with_client(
                lambda client, config: avatar_batch(client, config, payload)
            )
        elif args.command == "emoji-catalog":
            payload = read_stdin_payload()
            value = with_client(
                lambda client, config: emoji_catalog(client, config, payload)
            )
        elif args.command == "emoji-batch":
            payload = read_stdin_payload()
            value = with_client(
                lambda client, config: emoji_batch(client, config, payload)
            )
        else:
            value = with_client(
                lambda client, config: attachment_preview(
                    client, config, args.file_id
                )
            )
        print(json.dumps(value, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"connected": False, "error": str(error)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
