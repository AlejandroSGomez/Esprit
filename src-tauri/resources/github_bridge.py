#!/usr/bin/env python3
"""Bounded, read-only GitHub adapter for the local Esprit application.

Repository scope comes exclusively from Esprit's configuration: the union of
``projects[].github_repos``. Local Git state is read from each project's
folder (or a direct subfolder) when it is the root of a clone whose
``origin`` is one of that project's repositories. Remote reads use the GitHub
CLI configured in ``tools.gh`` so credentials remain in gh's credential store;
Esprit never reads, receives, or persists an OAuth token.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))

import esprit_config  # noqa: E402


# Set from the configuration by ``configure`` before any read.
GH_BINARY: Optional[str] = None
TIMEZONE: dt.tzinfo = dt.timezone.utc
import shutil
GIT_BINARY = shutil.which("git") or "git"
API_TIMEOUT_SECONDS = 8
MAX_REPOSITORIES = 50
MAX_PROJECT_CHILDREN = 400
MAX_LOCAL_CANDIDATES = 12
MAX_NOTIFICATIONS = 50
MAX_NOTIFICATION_PAGES = 4
MAX_EVENTS_PER_REPOSITORY = 30
MAX_WORKFLOW_RUNS_PER_REPOSITORY = 10
MAX_ACTIVITY = 200
MAX_LOCAL_LOG_RECORDS = 40
MAX_GIT_OUTPUT_BYTES = 1_048_576
MAX_GITHUB_OUTPUT_BYTES = 768 * 1024

GITHUB_COMPONENT_RE = re.compile(r"[A-Za-z0-9_.-]{1,100}")
SHA_RE = re.compile(r"[0-9a-fA-F]{7,40}")


class BridgeError(RuntimeError):
    pass


def _now_ms() -> int:
    return int(dt.datetime.now(tz=dt.timezone.utc).timestamp() * 1000)


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _run(
    arguments: list[str],
    *,
    timeout: int = API_TIMEOUT_SECONDS,
    allow_failure: bool = False,
) -> subprocess.CompletedProcess[bytes]:
    environment = os.environ.copy()
    for name in (
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_ENTERPRISE_TOKEN",
        "GH_HOST",
    ):
        environment.pop(name, None)
    try:
        result = subprocess.run(
            arguments,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise BridgeError("No se pudo completar la lectura local de GitHub") from error
    if not allow_failure and result.returncode != 0:
        raise BridgeError("GitHub rechazó una lectura read-only")
    return result


def _git(repository: Path, *arguments: str, allow_failure: bool = False) -> str:
    result = _run(
        [GIT_BINARY, "-C", str(repository), *arguments],
        timeout=15,
        allow_failure=allow_failure,
    )
    if len(result.stdout) > MAX_GIT_OUTPUT_BYTES:
        raise BridgeError("La respuesta local de Git supera el límite seguro")
    return result.stdout.decode("utf-8", "replace").strip()


def configure(config: dict[str, Any]) -> Optional[str]:
    """Loads time zone and gh path; returns a warning when gh is unusable."""
    global GH_BINARY, TIMEZONE
    TIMEZONE = esprit_config.time_zone(config)
    try:
        GH_BINARY = esprit_config.tool_path(config, "gh")
    except esprit_config.ConfigError as error:
        GH_BINARY = None
        return f"{error}; solo se ha leído el estado Git local."
    if GH_BINARY is None:
        return "Falta tools.gh en la configuración de Esprit; solo se ha leído el estado Git local."
    return None


def _gh_api(endpoint: str) -> Any:
    if not endpoint.startswith("/") or any(character.isspace() for character in endpoint):
        raise BridgeError("Endpoint interno de GitHub no válido")
    if not GH_BINARY:
        raise BridgeError("GitHub CLI no está configurado")
    result = _run(
        [
            GH_BINARY,
            "api",
            "--hostname",
            "github.com",
            "--method",
            "GET",
            "-H",
            "Accept: application/vnd.github+json",
            endpoint,
        ]
    )
    if len(result.stdout) > MAX_GITHUB_OUTPUT_BYTES:
        raise BridgeError("La respuesta de GitHub supera el límite seguro")
    try:
        return json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BridgeError("GitHub devolvió una respuesta no válida") from error


def _auth_available() -> bool:
    if not GH_BINARY or not os.path.isfile(GH_BINARY):
        return False
    result = _run(
        [GH_BINARY, "auth", "status", "--hostname", "github.com", "--active"],
        allow_failure=True,
    )
    return result.returncode == 0


def _checked_git_root(candidate: Path) -> Path:
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as error:
        raise BridgeError("No se pudo validar una carpeta Git") from error
    top_level = _git(resolved, "rev-parse", "--show-toplevel")
    try:
        if not top_level or Path(top_level).resolve(strict=True) != resolved:
            raise BridgeError("La carpeta no es la raíz de su repositorio Git")
    except OSError as error:
        raise BridgeError("No se pudo validar una raíz Git") from error
    return resolved


def _local_candidates(folder: Path) -> list[Path]:
    """The project folder and its direct, non-symlink subfolders containing ``.git``."""
    candidates: list[Path] = []
    if (folder / ".git").exists():
        candidates.append(folder)
    try:
        with os.scandir(folder) as entries:
            children = []
            for index, entry in enumerate(entries):
                if index >= MAX_PROJECT_CHILDREN:
                    break
                children.append(entry)
    except OSError:
        children = []
    for entry in sorted(children, key=lambda value: value.name):
        if entry.name.startswith(".") or entry.is_symlink():
            continue
        try:
            if entry.is_dir(follow_symlinks=False) and (Path(entry.path) / ".git").exists():
                candidates.append(Path(entry.path))
        except OSError:
            continue
    return candidates[:MAX_LOCAL_CANDIDATES]


def _github_name(remote: str) -> Optional[str]:
    remote = remote.strip()
    owner = ""
    repository = ""
    if remote.startswith("git@github.com:"):
        suffix = remote.removeprefix("git@github.com:")
        if suffix.endswith(".git"):
            suffix = suffix[:-4]
        parts = suffix.split("/")
        if len(parts) == 2:
            owner, repository = parts
    elif remote.startswith("ssh://git@github.com/"):
        suffix = remote.removeprefix("ssh://git@github.com/")
        if suffix.endswith(".git"):
            suffix = suffix[:-4]
        parts = suffix.split("/")
        if len(parts) == 2:
            owner, repository = parts
    else:
        parsed = urlsplit(remote)
        if (
            parsed.scheme == "https"
            and parsed.hostname == "github.com"
            and parsed.port is None
            and parsed.username is None
            and parsed.password is None
            and not parsed.query
            and not parsed.fragment
        ):
            parts = parsed.path.strip("/").split("/")
            if len(parts) == 2:
                owner, repository = parts
                if repository.endswith(".git"):
                    repository = repository[:-4]
    if not GITHUB_COMPONENT_RE.fullmatch(owner) or not GITHUB_COMPONENT_RE.fullmatch(repository):
        return None
    return f"{owner}/{repository}"


def configured_repositories(config: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    declared = esprit_config.github_repositories(config)
    scope = {
        "configured_repositories": len(declared),
        "repositories_over_limit": max(0, len(declared) - MAX_REPOSITORIES),
        "local_repositories": 0,
        "invalid_project_folders": 0,
        "unmatched_local_repositories": 0,
    }
    by_key: dict[str, dict[str, Any]] = {}
    for item in declared[:MAX_REPOSITORIES]:
        full_name = item["full_name"]
        by_key[full_name.lower()] = {
            "project_slug": item["project_slug"],
            "label": full_name.split("/", 1)[1],
            "full_name": full_name,
            "html_url": f"https://github.com/{full_name}",
            "local_path": None,
        }
    for project in esprit_config.projects(config):
        own = {
            value.lower()
            for value in project.get("github_repos") or []
            if isinstance(value, str) and value.lower() in by_key
        }
        if not own:
            continue
        try:
            folder = esprit_config.project_folder(config, project)
        except esprit_config.ConfigError:
            scope["invalid_project_folders"] += 1
            continue
        for candidate in _local_candidates(folder):
            try:
                root = _checked_git_root(candidate)
                remote = _git(root, "config", "--get", "remote.origin.url", allow_failure=True)
            except BridgeError:
                continue
            name = _github_name(remote)
            key = name.lower() if name else ""
            if key in own and by_key[key]["local_path"] is None:
                by_key[key]["local_path"] = root
                scope["local_repositories"] += 1
            elif key not in own:
                scope["unmatched_local_repositories"] += 1
    return list(by_key.values()), scope


def _local_repository_state(repository: Path) -> dict[str, Any]:
    branch = _git(repository, "branch", "--show-current", allow_failure=True) or None
    head = _git(repository, "rev-parse", "HEAD", allow_failure=True) or None
    status = _git(
        repository,
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
        allow_failure=True,
    )
    tracked = 0
    untracked = 0
    for line in status.splitlines():
        if line.startswith("??"):
            untracked += 1
        elif line:
            tracked += 1
    return {
        "local_branch": branch,
        "local_head": head,
        "tracked_changes": tracked,
        "untracked_changes": untracked,
    }


def _since_boundary(value: str) -> dt.datetime:
    now = dt.datetime.now(TIMEZONE)
    if value == "today":
        return now.replace(hour=0, minute=0, second=0, microsecond=0)
    if value == "7d":
        return now - dt.timedelta(days=7)
    raise BridgeError("Rango temporal de GitHub no válido")


def _parse_time(value: Any) -> Optional[dt.datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _within(value: Any, boundary: dt.datetime) -> bool:
    parsed = _parse_time(value)
    if parsed is None:
        return False
    return parsed.astimezone(dt.timezone.utc) >= boundary.astimezone(dt.timezone.utc)


def _activity_timestamp(item: dict[str, Any]) -> float:
    parsed = _parse_time(item.get("created_at"))
    return parsed.timestamp() if parsed is not None else float("-inf")


def _target_from_api_url(subject_type: str, api_url: str) -> tuple[str, Optional[str]]:
    patterns = {
        "PullRequest": ("pull_request", r"/pulls/(\d+)$"),
        "Issue": ("issue", r"/issues/(\d+)$"),
        "Commit": ("commit", r"/commits/([0-9a-fA-F]{7,40})$"),
        "CheckSuite": ("commit", r"/commits/([0-9a-fA-F]{7,40})$"),
    }
    kind_pattern = patterns.get(subject_type)
    if kind_pattern:
        match = re.search(kind_pattern[1], api_url)
        if match:
            return kind_pattern[0], match.group(1)
    return "repo", None


def _notifications(
    allowed: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], bool, int]:
    values: list[Any] = []
    complete = False
    for page in range(1, MAX_NOTIFICATION_PAGES + 1):
        page_values = _list(
            _gh_api(
                "/notifications?all=false&participating=false"
                f"&per_page={MAX_NOTIFICATIONS}&page={page}"
            )
        )
        values.extend(page_values)
        if len(page_values) < MAX_NOTIFICATIONS:
            complete = True
            break
    normalized: list[dict[str, Any]] = []
    for item in values:
        notification = _dict(item)
        repository = _dict(notification.get("repository"))
        full_name = _text(repository.get("full_name"))
        allowed_repository = allowed.get(full_name.lower())
        if not allowed_repository:
            continue
        subject = _dict(notification.get("subject"))
        target_kind, target_id = _target_from_api_url(
            _text(subject.get("type")), _text(subject.get("url"))
        )
        normalized.append(
            {
                "id": _text(notification.get("id")),
                "repo": full_name,
                "project_slug": allowed_repository["project_slug"],
                "reason": _text(notification.get("reason")) or "subscribed",
                "subject_type": _text(subject.get("type")) or "Repository",
                "title": _text(subject.get("title")) or full_name,
                "updated_at": _text(notification.get("updated_at")),
                "unread": bool(notification.get("unread", True)),
                "target_kind": target_kind,
                "target_id": target_id,
            }
        )
    return normalized, not complete, len(values)


def _event_activity(
    full_name: str,
    project_slug: str,
    boundary: dt.datetime,
) -> tuple[list[dict[str, Any]], bool]:
    events = _list(_gh_api(f"/repos/{full_name}/events?per_page={MAX_EVENTS_PER_REPOSITORY}"))
    truncated = (
        len(events) >= MAX_EVENTS_PER_REPOSITORY
        and bool(events)
        and _within(_dict(events[-1]).get("created_at"), boundary)
    )
    activity: list[dict[str, Any]] = []
    for raw in events:
        event = _dict(raw)
        created_at = _text(event.get("created_at"))
        if not _within(created_at, boundary):
            continue
        event_type = _text(event.get("type"))
        payload = _dict(event.get("payload"))
        actor = _text(_dict(event.get("actor")).get("login"))
        kind = "repository"
        title = event_type or "Actividad del repositorio"
        target_kind = "repo"
        target_id: Optional[str] = None
        if event_type == "PushEvent":
            kind = "commit"
            commits = _list(payload.get("commits"))
            head = _text(payload.get("head"))
            message = _text(_dict(commits[-1]).get("message")) if commits else ""
            branch = _text(payload.get("ref")).removeprefix("refs/heads/")
            title = message.splitlines()[0] if message else f"Push a {branch or 'una rama'}"
            if SHA_RE.fullmatch(head):
                target_kind, target_id = "commit", head
        elif event_type == "PullRequestEvent":
            pull = _dict(payload.get("pull_request"))
            kind = "pull_request"
            target_kind = "pull"
            number = pull.get("number") or payload.get("number")
            target_id = str(number) if isinstance(number, int) else None
            title = f"{_text(payload.get('action')) or 'actualizó'} PR: {_text(pull.get('title')) or 'sin título'}"
        elif event_type == "IssuesEvent":
            issue = _dict(payload.get("issue"))
            kind = "issue"
            target_kind = "issue"
            number = issue.get("number")
            target_id = str(number) if isinstance(number, int) else None
            title = f"{_text(payload.get('action')) or 'actualizó'} issue: {_text(issue.get('title')) or 'sin título'}"
        elif event_type == "ReleaseEvent":
            release = _dict(payload.get("release"))
            kind = "release"
            title = f"Release: {_text(release.get('name')) or _text(release.get('tag_name')) or 'sin nombre'}"
        elif event_type in {"CreateEvent", "DeleteEvent"}:
            kind = "repository"
            reference = _text(payload.get("ref"))
            title = f"{event_type.removesuffix('Event').lower()}: {reference or _text(payload.get('ref_type'))}"
        else:
            continue
        activity.append(
            {
                "id": _text(event.get("id")) or f"{full_name}:{created_at}:{kind}",
                "repo": full_name,
                "project_slug": project_slug,
                "kind": kind,
                "title": title[:500],
                "actor": actor,
                "created_at": created_at,
                "target_kind": target_kind,
                "target_id": target_id,
            }
        )
    return activity, truncated


def _workflow_activity(
    full_name: str,
    project_slug: str,
    boundary: dt.datetime,
) -> tuple[list[dict[str, Any]], bool]:
    boundary_day = boundary.astimezone(dt.timezone.utc).date().isoformat()
    response = _dict(
        _gh_api(
            f"/repos/{full_name}/actions/runs?per_page={MAX_WORKFLOW_RUNS_PER_REPOSITORY}"
            f"&created=%3E%3D{boundary_day}"
        )
    )
    runs = _list(response.get("workflow_runs"))
    truncated = (
        len(runs) >= MAX_WORKFLOW_RUNS_PER_REPOSITORY
        and bool(runs)
        and _within(
            _text(_dict(runs[-1]).get("updated_at"))
            or _text(_dict(runs[-1]).get("created_at")),
            boundary,
        )
    )
    activity: list[dict[str, Any]] = []
    for raw in runs:
        run = _dict(raw)
        created_at = _text(run.get("updated_at")) or _text(run.get("created_at"))
        if not _within(created_at, boundary):
            continue
        run_id = run.get("id")
        if not isinstance(run_id, int):
            continue
        conclusion = _text(run.get("conclusion")) or _text(run.get("status")) or "sin estado"
        activity.append(
            {
                "id": f"workflow:{run_id}",
                "repo": full_name,
                "project_slug": project_slug,
                "kind": "workflow",
                "title": f"{_text(run.get('name')) or 'Workflow'} · {conclusion}",
                "actor": _text(_dict(run.get("actor")).get("login")),
                "created_at": created_at,
                # The public workflow URL is intentionally not accepted as a
                # separate frontend target. Opening this row goes only to its
                # already allowlisted repository.
                "target_kind": "repo",
                "target_id": None,
            }
        )
    return activity, truncated


def _local_commit_activity(
    repository: dict[str, Any],
    boundary: dt.datetime,
) -> tuple[list[dict[str, Any]], bool]:
    local_path = repository["local_path"]
    output = _git(
        local_path,
        "log",
        "--all",
        f"--since={boundary.isoformat()}",
        f"--max-count={MAX_LOCAL_LOG_RECORDS}",
        "--format=%H%x1f%aI%x1f%an%x1f%s%x1e",
        allow_failure=True,
    )
    activity: list[dict[str, Any]] = []
    for record in output.split("\x1e"):
        fields = record.strip().split("\x1f")
        if len(fields) != 4 or not SHA_RE.fullmatch(fields[0]):
            continue
        activity.append(
            {
                "id": f"local:{repository['full_name']}:{fields[0]}",
                "repo": repository["full_name"],
                "project_slug": repository["project_slug"],
                "kind": "local_commit",
                "title": fields[3][:500],
                "actor": fields[2][:200],
                "created_at": fields[1],
                # A local commit may not exist on github.com yet. Its safe
                # external destination is therefore the allowlisted repo.
                "target_kind": "repo",
                "target_id": None,
            }
        )
    return activity, len(activity) >= MAX_LOCAL_LOG_RECORDS


def build_overview(config: dict[str, Any], since: str = "7d") -> dict[str, Any]:
    esprit_config.require_module(config, "github")
    gh_warning = configure(config)
    boundary = _since_boundary(since)
    registered, registry_scope = configured_repositories(config)
    allowed = {item["full_name"].lower(): item for item in registered}
    repositories = []
    local_activity: list[dict[str, Any]] = []
    local_activity_truncated_repositories: set[str] = set()
    local_state_failures = 0
    empty_local_state = {
        "local_branch": None,
        "local_head": None,
        "tracked_changes": 0,
        "untracked_changes": 0,
    }
    for item in registered:
        if item["local_path"] is None:
            local_state = dict(empty_local_state)
        else:
            try:
                local_state = _local_repository_state(item["local_path"])
                local_commits, local_truncated = _local_commit_activity(item, boundary)
                local_activity.extend(local_commits)
                if local_truncated:
                    local_activity_truncated_repositories.add(item["full_name"])
            except BridgeError:
                local_state_failures += 1
                local_state = dict(empty_local_state)
        repositories.append(
            {
                "full_name": item["full_name"],
                "project_slug": item["project_slug"],
                "label": item["label"],
                "private": None,
                "archived": None,
                "default_branch": None,
                "pushed_at": None,
                "open_issues_count": None,
                "html_url": item["html_url"],
                **local_state,
            }
        )

    scope_warnings = []
    if registry_scope["repositories_over_limit"]:
        scope_warnings.append(
            f"Solo se consultan los primeros {MAX_REPOSITORIES} repositorios configurados; "
            f"se omitieron {registry_scope['repositories_over_limit']}."
        )
    if registry_scope["invalid_project_folders"]:
        scope_warnings.append(
            f"No se pudo acceder a la carpeta de {registry_scope['invalid_project_folders']} proyectos con repositorios GitHub."
        )
    if local_state_failures:
        scope_warnings.append(
            f"No se pudo leer el estado Git local de {local_state_failures} repositorios configurados."
        )

    base = {
        "connected": False,
        "status": "auth_required",
        "login": None,
        "checked_at": _now_ms(),
        "notification_count": 0,
        "repositories": repositories,
        "activity": sorted(local_activity, key=_activity_timestamp, reverse=True)[
            :MAX_ACTIVITY
        ],
        "notifications": [],
        "local_changes_note": (
            "tracked_changes y untracked_changes describen el árbol de trabajo actual; "
            "no demuestran por sí solos actividad realizada hoy."
        ),
        "warnings": [
            gh_warning
            or "La sesión de GitHub CLI necesita volver a enlazarse; solo se ha leído el estado Git local.",
            *scope_warnings,
            *(
                ["La actividad Git local alcanzó el límite de resultados y está truncada."]
                if len(local_activity) > MAX_ACTIVITY
                or bool(local_activity_truncated_repositories)
                else []
            ),
        ],
        "coverage": {
            **registry_scope,
            "github_repositories": len(registered),
            "local_state_failures": local_state_failures,
            "returned_activity": min(len(local_activity), MAX_ACTIVITY),
            "returned_notifications": 0,
            "global_notifications_examined": 0,
            "notifications_complete": False,
            "notifications_truncated": False,
            "activity_truncated": len(local_activity) > MAX_ACTIVITY
            or bool(local_activity_truncated_repositories),
            "activity_truncated_repositories": sorted(
                local_activity_truncated_repositories
            ),
            "local_git_available": True,
            "local_changes_semantics": "current_worktree_state_not_dated_activity",
            "since": since,
        },
    }
    if gh_warning:
        base["status"] = "unavailable"
        return base
    if not registered:
        # Nothing to read remotely: never page global notifications for no repository.
        base.update(
            connected=True,
            status="partial" if scope_warnings else "available",
            warnings=list(scope_warnings),
        )
        base["coverage"].update(notifications_complete=True)
        return base
    if not _auth_available():
        return base

    warnings: list[str] = list(scope_warnings)
    login: Optional[str] = None
    notifications: list[dict[str, Any]] = []
    notifications_truncated = False
    notifications_failed = False
    global_notifications_examined = 0
    remote_activity: list[dict[str, Any]] = []
    remote_activity_truncated_repositories: set[str] = set()

    # Every network read has an eight-second process timeout. Running the
    # independent fixed GET endpoints through a small pool keeps a degraded
    # refresh within tens of seconds instead of multiplying that timeout by
    # every repository.
    future_context: dict[concurrent.futures.Future[Any], tuple[str, int, dict[str, Any]]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        future_context[executor.submit(_gh_api, "/user")] = ("user", -1, {})
        future_context[executor.submit(_notifications, allowed)] = (
            "notifications",
            -1,
            {},
        )
        for index, item in enumerate(registered):
            full_name = item["full_name"]
            future_context[executor.submit(_gh_api, f"/repos/{full_name}")] = (
                "metadata",
                index,
                item,
            )
            future_context[
                executor.submit(
                    _event_activity,
                    full_name,
                    item["project_slug"],
                    boundary,
                )
            ] = ("events", index, item)
            future_context[
                executor.submit(
                    _workflow_activity,
                    full_name,
                    item["project_slug"],
                    boundary,
                )
            ] = ("workflows", index, item)

        for future in concurrent.futures.as_completed(future_context):
            kind, index, item = future_context[future]
            try:
                result = future.result()
            except BridgeError:
                if kind == "user":
                    warnings.append("No se pudo verificar la identidad conectada de GitHub.")
                elif kind == "notifications":
                    notifications_failed = True
                    warnings.append("No se pudieron leer las notificaciones de GitHub.")
                elif kind == "metadata":
                    warnings.append(
                        f"No se pudo leer el resumen remoto de {item['full_name']}."
                    )
                elif kind == "events":
                    warnings.append(
                        f"No se pudo leer la actividad reciente de {item['full_name']}."
                    )
                else:
                    warnings.append(
                        f"No se pudieron leer los workflows recientes de {item['full_name']}."
                    )
                continue

            if kind == "user":
                login = _text(_dict(result).get("login")) or None
            elif kind == "notifications":
                (
                    notifications,
                    notifications_truncated,
                    global_notifications_examined,
                ) = result
            elif kind in {"events", "workflows"}:
                activity, endpoint_truncated = result
                remote_activity.extend(activity)
                if endpoint_truncated:
                    remote_activity_truncated_repositories.add(item["full_name"])
            elif kind == "metadata":
                metadata = _dict(result)
                repositories[index].update(
                    {
                        "private": bool(metadata.get("private")),
                        "archived": bool(metadata.get("archived")),
                        "default_branch": _text(metadata.get("default_branch")) or None,
                        "pushed_at": _text(metadata.get("pushed_at")) or None,
                        "open_issues_count": metadata.get("open_issues_count")
                        if isinstance(metadata.get("open_issues_count"), int)
                        else None,
                    }
                )

    combined_activity = remote_activity + local_activity
    combined_activity.sort(key=_activity_timestamp, reverse=True)
    combined_cap_reached = len(combined_activity) > MAX_ACTIVITY
    activity_truncated_repositories = (
        local_activity_truncated_repositories
        | remote_activity_truncated_repositories
    )
    activity_truncated = combined_cap_reached or bool(activity_truncated_repositories)
    combined_activity = combined_activity[:MAX_ACTIVITY]
    if notifications_truncated:
        warnings.append(
            "GitHub alcanzó el límite de 200 notificaciones globales; puede haber avisos de tus repositorios sin revisar."
        )
    if activity_truncated:
        if remote_activity_truncated_repositories:
            warnings.append(
                "La actividad remota alcanzó el límite en: "
                + ", ".join(sorted(remote_activity_truncated_repositories))
                + "."
            )
        if local_activity_truncated_repositories:
            warnings.append(
                "Los commits locales alcanzaron el límite en: "
                + ", ".join(sorted(local_activity_truncated_repositories))
                + "."
            )
        if combined_cap_reached:
            warnings.append(
                "La actividad GitHub combinada superó los 200 resultados y está truncada."
            )
    return {
        "connected": True,
        "status": "partial" if warnings else "available",
        "login": login,
        "checked_at": _now_ms(),
        "notification_count": sum(1 for item in notifications if item["unread"]),
        "repositories": repositories,
        "activity": combined_activity,
        "notifications": notifications,
        "local_changes_note": (
            "tracked_changes y untracked_changes describen el árbol de trabajo actual; "
            "no demuestran por sí solos actividad realizada hoy."
        ),
        "warnings": warnings,
        "coverage": {
            **registry_scope,
            "github_repositories": len(registered),
            "local_state_failures": local_state_failures,
            "returned_activity": len(combined_activity),
            "returned_notifications": len(notifications),
            "global_notifications_examined": global_notifications_examined,
            "notifications_complete": not notifications_truncated
            and not notifications_failed,
            "notifications_truncated": notifications_truncated,
            "activity_truncated": activity_truncated,
            "activity_truncated_repositories": sorted(activity_truncated_repositories),
            "local_git_available": True,
            "local_changes_semantics": "current_worktree_state_not_dated_activity",
            "since": since,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("overview")
    sweep = subparsers.add_parser("daily-sweep")
    sweep.add_argument("since", choices=("today", "7d"))
    args = parser.parse_args()

    try:
        config = esprit_config.load_config()
        if args.command == "daily-sweep":
            value = build_overview(config, args.since)
            value["read_only"] = True
            value["authorization"] = "Esprit Login/Logout button"
            value["since"] = args.since
        else:
            value = build_overview(config, "7d")
        print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as error:
        message = str(error).strip() or "No se pudo actualizar GitHub"
        print(
            json.dumps(
                {
                    "connected": False,
                    "status": "unavailable",
                    "error": message[:500],
                    "checked_at": _now_ms(),
                    "notification_count": 0,
                    "repositories": [],
                    "activity": [],
                    "notifications": [],
                    "warnings": [message[:500]],
                    "coverage": {
                        "configured_repositories": 0,
                        "github_repositories": 0,
                        "returned_activity": 0,
                        "returned_notifications": 0,
                        "global_notifications_examined": 0,
                        "notifications_complete": False,
                        "notifications_truncated": False,
                        "activity_truncated": False,
                        "activity_truncated_repositories": [],
                        "local_git_available": False,
                        "local_changes_semantics": "current_worktree_state_not_dated_activity",
                        "since": getattr(args, "since", "7d"),
                    },
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
