from __future__ import annotations

import datetime as dt
import stat
import unittest
from pathlib import Path
from unittest.mock import patch

from esprit_fixtures import TEST_ZONE, TempWorkspace, load_bridge

BRIDGE = load_bridge("github_bridge")


def notification(index: int, repository: str) -> dict:
    return {
        "id": str(index),
        "repository": {"full_name": repository},
        "reason": "mention",
        "subject": {
            "type": "Issue",
            "title": f"Issue {index}",
            "url": f"https://api.github.com/repos/{repository}/issues/{index + 1}",
        },
        "updated_at": "2026-08-23T10:00:00Z",
        "unread": True,
    }


def fake_git(origins: dict):
    """Minimal stand-in for /usr/bin/git over temporary folders."""

    def run(repository, *arguments, allow_failure=False):
        path = str(Path(repository))
        if arguments == ("rev-parse", "--show-toplevel"):
            return path
        if arguments == ("config", "--get", "remote.origin.url"):
            return origins.get(path, "")
        if arguments == ("branch", "--show-current"):
            return "main"
        if arguments == ("rev-parse", "HEAD"):
            return "a" * 40
        if arguments[0] == "status":
            return " M analisis.py\n?? notas.txt"
        if arguments[0] == "log":
            return ""
        raise AssertionError(f"unexpected git call {arguments}")

    return run


class GitHubRemoteParsingTests(unittest.TestCase):
    def test_sorts_mixed_iso_offsets_by_their_real_utc_time(self):
        values = [
            {"id": "local", "created_at": "2026-08-23T10:00:00+02:00"},
            {"id": "remote", "created_at": "2026-08-23T09:00:00Z"},
        ]
        values.sort(key=BRIDGE._activity_timestamp, reverse=True)
        self.assertEqual([value["id"] for value in values], ["remote", "local"])

    def test_accepts_only_canonical_github_origins(self):
        self.assertEqual(BRIDGE._github_name("git@github.com:Ana-Perez/Tesis.git"), "Ana-Perez/Tesis")
        self.assertEqual(
            BRIDGE._github_name("https://github.com/grupo-ejemplo/simulaciones"),
            "grupo-ejemplo/simulaciones",
        )
        self.assertIsNone(BRIDGE._github_name("https://git.overleaf.com/project"))
        self.assertIsNone(BRIDGE._github_name("https://github.com/owner/repo?redirect=attacker"))

    def test_pages_global_notifications_before_filtering_the_allowlist(self):
        def fake_api(endpoint: str):
            if "page=1" in endpoint:
                return [notification(index, "other/repo") for index in range(50)]
            if "page=2" in endpoint:
                return [notification(50, "Ana-Perez/Tesis")]
            return []

        with patch.object(BRIDGE, "_gh_api", side_effect=fake_api):
            values, truncated, examined = BRIDGE._notifications({"ana-perez/tesis": {"project_slug": "tesis"}})
        self.assertEqual(len(values), 1)
        self.assertEqual(values[0]["repo"], "Ana-Perez/Tesis")
        self.assertEqual(values[0]["project_slug"], "tesis")
        self.assertFalse(truncated)
        self.assertEqual(examined, 51)

    def test_declares_partial_coverage_at_the_global_page_guard(self):
        with patch.object(BRIDGE, "_gh_api", side_effect=lambda endpoint: [notification(index, "other/repo") for index in range(50)]):
            values, truncated, examined = BRIDGE._notifications({})
        self.assertEqual(values, [])
        self.assertTrue(truncated)
        self.assertEqual(examined, 200)

    def test_marks_repository_event_cap_when_it_still_overlaps_the_window(self):
        events = [
            {
                "id": str(index),
                "type": "CreateEvent",
                "created_at": "2026-08-23T10:00:00Z",
                "actor": {"login": "ana-perez"},
                "payload": {"ref": f"branch-{index}", "ref_type": "branch"},
            }
            for index in range(BRIDGE.MAX_EVENTS_PER_REPOSITORY)
        ]
        with patch.object(BRIDGE, "_gh_api", return_value=events):
            values, truncated = BRIDGE._event_activity(
                "ana-perez/tesis", "tesis", dt.datetime(2026, 8, 23, tzinfo=dt.timezone.utc)
            )
        self.assertEqual(len(values), BRIDGE.MAX_EVENTS_PER_REPOSITORY)
        self.assertTrue(truncated)


class ConfiguredScopeTests(unittest.TestCase):
    def test_repositories_come_from_projects_and_local_clones_are_matched_by_origin(self):
        with TempWorkspace() as fixture:
            tesis = fixture.workspace / "Proyectos/Tesis"
            (tesis / "codigo" / ".git").mkdir(parents=True)
            (tesis / "ajeno" / ".git").mkdir(parents=True)
            (tesis / "datos").mkdir()
            articulo = fixture.workspace / "Proyectos/Articulo-1"
            (articulo / ".git").mkdir()
            origins = {
                str(tesis / "codigo"): "git@github.com:grupo-ejemplo/simulaciones.git",
                str(tesis / "ajeno"): "https://github.com/otra-persona/otro",
                str(articulo): "https://github.com/ana-perez/articulo.git",
            }
            with patch.object(BRIDGE, "_git", side_effect=fake_git(origins)):
                repositories, scope = BRIDGE.configured_repositories(fixture.config)
        self.assertEqual(
            [(item["full_name"], item["project_slug"], item["label"]) for item in repositories],
            [
                ("ana-perez/tesis", "tesis", "tesis"),
                ("grupo-ejemplo/simulaciones", "tesis", "simulaciones"),
                ("ana-perez/articulo", "articulo-1", "articulo"),
            ],
        )
        by_name = {item["full_name"]: item for item in repositories}
        self.assertIsNone(by_name["ana-perez/tesis"]["local_path"])
        self.assertEqual(by_name["grupo-ejemplo/simulaciones"]["local_path"], tesis / "codigo")
        self.assertEqual(by_name["ana-perez/articulo"]["local_path"], articulo)
        self.assertEqual(by_name["ana-perez/tesis"]["html_url"], "https://github.com/ana-perez/tesis")
        self.assertEqual(scope["configured_repositories"], 3)
        self.assertEqual(scope["local_repositories"], 2)
        self.assertEqual(scope["unmatched_local_repositories"], 1)
        self.assertEqual(scope["invalid_project_folders"], 0)

    def test_missing_project_folder_is_counted_not_fatal(self):
        with TempWorkspace(create_folders=False) as fixture:
            with patch.object(BRIDGE, "_git", side_effect=AssertionError("no git outside existing folders")):
                repositories, scope = BRIDGE.configured_repositories(fixture.config)
        self.assertEqual(len(repositories), 3)
        self.assertEqual(scope["invalid_project_folders"], 2)

    def test_without_gh_only_local_state_is_read(self):
        with TempWorkspace() as fixture:
            articulo = fixture.workspace / "Proyectos/Articulo-1"
            (articulo / ".git").mkdir()
            origins = {str(articulo): "https://github.com/ana-perez/articulo"}
            with patch.object(BRIDGE, "_git", side_effect=fake_git(origins)), patch.object(
                BRIDGE, "_gh_api", side_effect=AssertionError("no remote reads")
            ):
                value = BRIDGE.build_overview(fixture.config, "today")
        self.assertEqual(value["status"], "unavailable")
        self.assertIn("tools.gh", value["warnings"][0])
        self.assertEqual(str(BRIDGE.TIMEZONE), TEST_ZONE)
        repository = next(item for item in value["repositories"] if item["full_name"] == "ana-perez/articulo")
        self.assertEqual(
            (repository["local_branch"], repository["tracked_changes"], repository["untracked_changes"]),
            ("main", 1, 1),
        )
        self.assertTrue(all("local_path" not in item for item in value["repositories"]))

    def test_no_configured_repositories_makes_no_remote_calls(self):
        def clear(config):
            for project in config["projects"]:
                project["github_repos"] = []

        with TempWorkspace(clear) as fixture:
            gh = fixture.root / "gh"
            gh.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
            gh.chmod(gh.stat().st_mode | stat.S_IXUSR)
            config = fixture.copy()
            config["tools"]["gh"] = str(gh)
            with patch.object(BRIDGE, "_gh_api", side_effect=AssertionError("no remote reads")), patch.object(
                BRIDGE, "_run", side_effect=AssertionError("no processes")
            ):
                value = BRIDGE.build_overview(config, "7d")
        self.assertEqual(value["status"], "available")
        self.assertEqual(value["repositories"], [])
        self.assertTrue(value["coverage"]["notifications_complete"])

    def test_disabled_module_is_not_configured(self):
        def disable(config):
            config["modules"]["github"]["enabled"] = False

        with TempWorkspace(disable) as fixture:
            with self.assertRaisesRegex(BRIDGE.esprit_config.ModuleNotConfigured, "no configurado"):
                BRIDGE.build_overview(fixture.config)


if __name__ == "__main__":
    unittest.main()
