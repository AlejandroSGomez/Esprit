"""esprit_config.py: carga, validación ligera y ayudas de cada módulo. Sin red."""

from __future__ import annotations

import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from esprit_fixtures import TEST_ZONE, TempWorkspace, load_bridge

CONFIG = load_bridge("esprit_config")


class LoadingTests(unittest.TestCase):
    def test_missing_environment_variable_is_a_clear_spanish_error(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(CONFIG.ConfigError, "ESPRIT_CONFIG"):
                CONFIG.load_config()
        with self.assertRaisesRegex(CONFIG.ConfigError, "absoluta"):
            CONFIG.config_path({"ESPRIT_CONFIG": "config.json"})

    def test_missing_or_invalid_files_name_the_problem(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "no-existe.json"
            with self.assertRaisesRegex(CONFIG.ConfigError, "No existe"):
                CONFIG.load_config(missing)
            broken = Path(directory) / "rota.json"
            broken.write_text("{\n  \"version\": 1,,\n}", encoding="utf-8")
            with self.assertRaisesRegex(CONFIG.ConfigError, "línea 2"):
                CONFIG.load_config(broken)

    def test_loads_the_path_from_the_environment(self):
        with TempWorkspace() as fixture:
            value = CONFIG.load_config()
            self.assertEqual(value["user"]["name"], "Ana Pérez")
            self.assertEqual(CONFIG.workspace(value), fixture.workspace)
            self.assertEqual(CONFIG.time_zone_name(value), TEST_ZONE)
            self.assertEqual(str(CONFIG.time_zone(value)), TEST_ZONE)

    def test_rejects_wrong_version_zone_workspace_and_projects(self):
        cases = [
            lambda c: c.update(version=2),
            lambda c: c.update(time_zone="Hora local"),
            lambda c: c.update(workspace="Doctorado"),
            lambda c: c.pop("modules"),
            lambda c: c["projects"][0].update(slug="Tesis Doctoral"),
            lambda c: c["projects"][1].update(slug="tesis"),
            lambda c: c["projects"][0].update(folder="../fuera"),
            lambda c: c["projects"][0].update(folder="/absoluta"),
            lambda c: c["projects"][0].update(github_repos=["sin-barra"]),
        ]
        for mutate in cases:
            with self.subTest(mutate=mutate), TempWorkspace() as fixture:
                value = fixture.copy()
                mutate(value)
                fixture.write(value)
                with self.assertRaises(CONFIG.ConfigError):
                    CONFIG.load_config()

    def test_unknown_time_zone_is_reported(self):
        with TempWorkspace(lambda c: c.update(time_zone="Nowhere/Nothing")) as fixture:
            with self.assertRaisesRegex(CONFIG.ConfigError, "desconocida"):
                CONFIG.time_zone(fixture.config)


class PathTests(unittest.TestCase):
    def test_workspace_must_be_a_real_directory(self):
        with TempWorkspace() as fixture:
            link = fixture.root / "enlace"
            link.symlink_to(fixture.workspace)
            with self.assertRaisesRegex(CONFIG.ConfigError, "enlace simbólico"):
                CONFIG.workspace({**fixture.config, "workspace": str(link)})
            with self.assertRaisesRegex(CONFIG.ConfigError, "no existe"):
                CONFIG.workspace({**fixture.config, "workspace": str(fixture.root / "falta")})

    def test_project_folders_stay_inside_the_workspace(self):
        with TempWorkspace() as fixture:
            project = fixture.config["projects"][0]
            self.assertEqual(CONFIG.project_folder(fixture.config, project), fixture.workspace / "Proyectos/Tesis")
            outside = fixture.root / "fuera"
            outside.mkdir()
            (fixture.workspace / "Atajo").symlink_to(outside)
            for folder, message in [("Atajo", "enlace simbólico"), ("No/Existe", "no existe"), ("a/../..", "salir")]:
                with self.subTest(folder=folder):
                    with self.assertRaisesRegex(CONFIG.ConfigError, message):
                        CONFIG.project_folder(fixture.config, {**project, "folder": folder})

    def test_tool_paths_are_absolute_executables_or_null(self):
        with TempWorkspace() as fixture:
            config = fixture.copy()
            self.assertIsNone(CONFIG.tool_path(config, "gh"))
            self.assertIsNone(CONFIG.tool_path(config, "latexmk"))
            executable = fixture.root / "gh"
            executable.write_text("#!/bin/sh\n", encoding="utf-8")
            config["tools"]["gh"] = str(executable)
            with self.assertRaisesRegex(CONFIG.ConfigError, "ejecutable"):
                CONFIG.tool_path(config, "gh")
            executable.chmod(executable.stat().st_mode | stat.S_IXUSR)
            self.assertEqual(CONFIG.tool_path(config, "gh"), str(executable))
            config["tools"]["gh"] = "gh"
            with self.assertRaisesRegex(CONFIG.ConfigError, "absoluta"):
                CONFIG.tool_path(config, "gh")


class ModuleTests(unittest.TestCase):
    def test_disabled_or_missing_modules_are_not_configured(self):
        with TempWorkspace() as fixture:
            config = fixture.copy()
            config["modules"]["mail"]["enabled"] = False
            for name in ("mail", "calendar", "cluster"):
                with self.subTest(name=name):
                    self.assertFalse(CONFIG.module_enabled(config, name))
                    with self.assertRaisesRegex(CONFIG.ModuleNotConfigured, "no configurado"):
                        CONFIG.require_module(config, name)
            self.assertTrue(CONFIG.module_enabled(config, "github"))

    def test_mail_accounts_get_stable_keys_in_config_order(self):
        with TempWorkspace() as fixture:
            accounts = CONFIG.mail_accounts(fixture.config)
            self.assertEqual(
                accounts,
                [
                    {"key": "m0", "label": "Universidad", "mail_account": "Universidad", "address": "ana.perez@ejemplo.org"},
                    {"key": "m1", "label": "Personal", "mail_account": "Casa", "address": "ana@correo.ejemplo.org"},
                ],
            )

    def test_mail_accounts_are_validated(self):
        valid = {"label": "Universidad", "mail_account": "Universidad", "address": "ana.perez@ejemplo.org"}
        cases = [
            [],
            [{**valid, "address": "sin-arroba"}],
            [{**valid, "label": ""}],
            [{**valid, "mail_account": ""}],
            [valid, {**valid}],
            [{**valid, "mail_account": f"Cuenta {index}"} for index in range(5)],
        ]
        with TempWorkspace() as fixture:
            for accounts in cases:
                with self.subTest(accounts=accounts):
                    config = fixture.copy()
                    config["modules"]["mail"]["accounts"] = accounts
                    with self.assertRaises(CONFIG.ConfigError):
                        CONFIG.mail_accounts(config)

    def test_mattermost_settings(self):
        with TempWorkspace() as fixture:
            config = fixture.copy()
            config["modules"]["mattermost"].update(server="https://chat.ejemplo.org/", channels=["general", "general", "@luis"])
            config["modules"]["mattermost"].pop("auth")
            settings = CONFIG.mattermost_settings(config)
            self.assertEqual(settings["api_base"], "https://chat.ejemplo.org/api/v4")
            self.assertEqual(settings["auth"], "password")
            self.assertEqual(settings["channels"], ["general", "@luis"])
            for change in [{"server": "http://chat.ejemplo.org"}, {"server": "https://ana:clave@chat.ejemplo.org"},
                           {"auth": "oauth"}, {"team": ""}, {"keychain_service": None}, {"channels": ["x"] * 41}]:
                with self.subTest(change=change):
                    broken = fixture.copy()
                    broken["modules"]["mattermost"].update(change)
                    with self.assertRaises(CONFIG.ConfigError):
                        CONFIG.mattermost_settings(broken)

    def test_github_repositories_are_the_deduplicated_union(self):
        with TempWorkspace() as fixture:
            self.assertEqual(
                CONFIG.github_repositories(fixture.config),
                [
                    {"full_name": "ana-perez/tesis", "project_slug": "tesis"},
                    {"full_name": "grupo-ejemplo/simulaciones", "project_slug": "tesis"},
                    {"full_name": "ana-perez/articulo", "project_slug": "articulo-1"},
                ],
            )

    def test_paper_radar_settings(self):
        with TempWorkspace() as fixture:
            config = fixture.copy()
            config["modules"]["paper_radar"]["keywords"] = ["  open   quantum systems ", "open quantum systems"]
            settings = CONFIG.paper_radar_settings(config)
            self.assertEqual(settings["keywords"], ["open quantum systems"])
            self.assertEqual(settings["arxiv_categories"], ["quant-ph", "cond-mat.stat-mech"])
            for change in [{"arxiv_categories": [], "keywords": []}, {"arxiv_categories": ["Física"]}, {"keywords": ["x"]}]:
                with self.subTest(change=change):
                    broken = fixture.copy()
                    broken["modules"]["paper_radar"].update(change)
                    with self.assertRaises(CONFIG.ConfigError):
                        CONFIG.paper_radar_settings(broken)


if __name__ == "__main__":
    unittest.main()
