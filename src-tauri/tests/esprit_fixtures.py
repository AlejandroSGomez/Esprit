"""Fixtures compartidos por los tests de los puentes (datos ficticios, sin red)."""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

RESOURCES = Path(__file__).resolve().parents[1] / "resources"
if str(RESOURCES) not in sys.path:
    sys.path.insert(0, str(RESOURCES))

TEST_ZONE = "Atlantic/Canary"


def load_bridge(name: str) -> Any:
    """Loads ``resources/<name>.py`` as an isolated module object."""
    spec = importlib.util.spec_from_file_location(f"esprit_test_{name}", RESOURCES / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def base_config(workspace: str) -> Dict[str, Any]:
    return {
        "version": 1,
        "user": {"name": "Ana Pérez", "short_name": "Ana", "initials": "AP"},
        "time_zone": TEST_ZONE,
        "workspace": workspace,
        "tools": {"claude": None, "gh": None, "python3": None},
        "projects": [
            {
                "slug": "tesis",
                "name": "Tesis doctoral",
                "folder": "Proyectos/Tesis",
                "github_repos": ["ana-perez/tesis", "grupo-ejemplo/simulaciones"],
            },
            {
                "slug": "articulo-1",
                "name": "Primer artículo",
                "folder": "Proyectos/Articulo-1",
                "github_repos": ["Ana-Perez/Tesis", "ana-perez/articulo"],
            },
        ],
        "modules": {
            "mail": {
                "enabled": True,
                "accounts": [
                    {"label": "Universidad", "mail_account": "Universidad", "address": "ana.perez@ejemplo.org"},
                    {"label": "Personal", "mail_account": "Casa", "address": "ana@correo.ejemplo.org"},
                ],
            },
            "mattermost": {
                "enabled": True,
                "server": "https://chat.ejemplo.org",
                "team": "grupo",
                "username": "ana.perez",
                "auth": "password",
                "keychain_service": "esprit-mattermost",
                "channels": [],
            },
            "github": {"enabled": True},
            "paper_radar": {
                "enabled": True,
                "arxiv_categories": ["quant-ph", "cond-mat.stat-mech"],
                "keywords": ["open quantum systems", "nonlinear dynamics"],
            },
        },
    }


class TempWorkspace:
    """A temporary workspace with project folders and a config file on ESPRIT_CONFIG."""

    def __init__(self, mutate: Optional[Any] = None, create_folders: bool = True) -> None:
        self._mutate = mutate
        self._create_folders = create_folders
        self._previous: Optional[str] = None

    def __enter__(self) -> "TempWorkspace":
        self._directory = tempfile.TemporaryDirectory()
        self.root = Path(self._directory.name).resolve()
        self.workspace = self.root / "Doctorado"
        self.workspace.mkdir()
        self.config = base_config(str(self.workspace))
        if self._create_folders:
            for project in self.config["projects"]:
                (self.workspace / project["folder"]).mkdir(parents=True, exist_ok=True)
        if self._mutate is not None:
            self._mutate(self.config)
        self.path = self.root / "config.json"
        self.write()
        self._previous = os.environ.get("ESPRIT_CONFIG")
        os.environ["ESPRIT_CONFIG"] = str(self.path)
        return self

    def write(self, value: Optional[Dict[str, Any]] = None) -> None:
        self.path.write_text(json.dumps(value if value is not None else self.config), encoding="utf-8")

    def copy(self) -> Dict[str, Any]:
        return copy.deepcopy(self.config)

    def __exit__(self, *exc: Any) -> None:
        if self._previous is None:
            os.environ.pop("ESPRIT_CONFIG", None)
        else:
            os.environ["ESPRIT_CONFIG"] = self._previous
        self._directory.cleanup()
