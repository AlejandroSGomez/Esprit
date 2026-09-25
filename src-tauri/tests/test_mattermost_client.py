"""mattermost_client.py: llavero, modos de autenticación y selección de canales. HTTP simulado."""

from __future__ import annotations

import io
import json
import subprocess
import unittest
from urllib.error import HTTPError
from urllib.parse import urlsplit

from esprit_fixtures import TEST_ZONE, TempWorkspace, load_bridge

MMC = load_bridge("mattermost_client")

SECRET = "secreto-de-prueba-123"
API = "https://chat.ejemplo.org/api/v4"


class FakeResponse:
    def __init__(self, body, headers=None):
        self._body = json.dumps(body).encode("utf-8") if not isinstance(body, bytes) else body
        self.headers = headers or {}

    def read(self, limit=-1):
        return self._body if limit < 0 else self._body[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeServer:
    """Routes (method, path) to canned JSON; records every request."""

    def __init__(self, routes):
        self.routes = routes
        self.requests = []

    def __call__(self, request, timeout=None):
        path = urlsplit(request.full_url).path.removeprefix("/api/v4")
        body = json.loads(request.data) if request.data else None
        self.requests.append((request.get_method(), path, dict(request.header_items()), body))
        route = self.routes.get((request.get_method(), path))
        if route is None:
            raise HTTPError(request.full_url, 404, "Not Found", {}, io.BytesIO(b'{"message": "No encontrado"}'))
        if isinstance(route, HTTPError):
            raise route
        if isinstance(route, tuple):
            return FakeResponse(route[0], route[1])
        return FakeResponse(route)


class FakeKeychain:
    def __init__(self, secret=SECRET, returncode=0):
        self.secret = secret
        self.returncode = returncode
        self.calls = []

    def __call__(self, arguments, **kwargs):
        self.calls.append(arguments)
        return subprocess.CompletedProcess(arguments, self.returncode, stdout=f"{self.secret}\n", stderr="")


def channel(channel_id, name, kind="O", last_post_at=0, **extra):
    return {"id": channel_id, "name": name, "display_name": name.title(), "type": kind, "last_post_at": last_post_at, "delete_at": 0, **extra}


def routes(channels=None, me=None):
    return {
        ("POST", "/users/login"): ({"id": "anaid"}, {"Token": "tokendesesion"}),
        ("POST", "/users/logout"): {"status": "OK"},
        ("GET", "/users/me"): me or {"id": "anaid", "username": "ana.perez"},
        ("GET", "/teams/name/grupo"): {"id": "teamid", "name": "grupo", "display_name": "Grupo de Ejemplo"},
        ("GET", "/users/anaid/teams/teamid/channels"): channels if channels is not None else [channel("generalid", "general", last_post_at=5)],
        ("POST", "/users/ids"): [
            {"id": "luisid", "username": "luis.gomez", "first_name": "Luis", "last_name": "Gómez"},
            {"id": "martaid", "username": "marta", "nickname": "Marta R."},
        ],
    }


def configure(auth="password", channels=None):
    def mutate(config):
        config["modules"]["mattermost"]["auth"] = auth
        config["modules"]["mattermost"]["channels"] = channels or []
    return mutate


class AuthenticationTests(unittest.TestCase):
    def test_password_mode_logs_in_with_the_keychain_secret_and_closes_the_session(self):
        server, keychain = FakeServer(routes()), FakeKeychain()
        with TempWorkspace(configure("password")) as fixture:
            client, session = MMC.open_session(fixture.config, runner=keychain, opener=server)
        self.assertEqual(keychain.calls, [["/usr/bin/security", "find-generic-password", "-w", "-s", "esprit-mattermost", "-a", "ana.perez"]])
        method, path, headers, body = server.requests[0]
        self.assertEqual((method, path, body), ("POST", "/users/login", {"login_id": "ana.perez", "password": SECRET}))
        self.assertNotIn("Authorization", headers)
        self.assertTrue(all(h.get("Authorization") == "Bearer tokendesesion" for _, p, h, _ in server.requests[1:]))
        self.assertEqual(session["identity"], {"user_id": "anaid", "username": "ana.perez", "timezone": TEST_ZONE})
        self.assertEqual(session["team"], {"id": "teamid", "name": "Grupo de Ejemplo"})
        self.assertEqual(session["server"], {"url": "https://chat.ejemplo.org"})
        client.logout()
        self.assertEqual(server.requests[-1][:2], ("POST", "/users/logout"))
        self.assertIsNone(client.token)
        self.assertNotIn(SECRET, json.dumps(session))

    def test_token_mode_uses_the_secret_as_bearer_and_never_revokes_it(self):
        server = FakeServer(routes())
        with TempWorkspace(configure("token")) as fixture:
            client, _ = MMC.open_session(fixture.config, runner=FakeKeychain(), opener=server)
        self.assertFalse(any(path == "/users/login" for _, path, _, _ in server.requests))
        self.assertEqual(server.requests[0][1], "/users/me")
        self.assertEqual(server.requests[0][2]["Authorization"], f"Bearer {SECRET}")
        client.logout()
        self.assertFalse(any(path == "/users/logout" for _, path, _, _ in server.requests))
        self.assertIsNone(client.token)

    def test_missing_keychain_item_explains_how_to_store_it_without_network(self):
        server = FakeServer(routes())
        with TempWorkspace() as fixture:
            with self.assertRaisesRegex(MMC.MattermostError, "security add-generic-password -s esprit-mattermost -a ana.perez -w"):
                MMC.open_session(fixture.config, runner=FakeKeychain(secret="", returncode=44), opener=server)
        self.assertEqual(server.requests, [])

    def test_token_of_another_user_is_rejected(self):
        server = FakeServer(routes(me={"id": "otroid", "username": "otra.persona"}))
        with TempWorkspace(configure("token")) as fixture:
            with self.assertRaisesRegex(MMC.MattermostError, "otro usuario"):
                MMC.open_session(fixture.config, runner=FakeKeychain(), opener=server)

    def test_failed_session_setup_still_closes_a_password_session(self):
        values = routes()
        del values[("GET", "/teams/name/grupo")]
        server = FakeServer(values)
        with TempWorkspace() as fixture:
            with self.assertRaisesRegex(MMC.MattermostError, "No se encontró el equipo «grupo»"):
                MMC.open_session(fixture.config, runner=FakeKeychain(), opener=server)
        self.assertEqual(server.requests[-1][:2], ("POST", "/users/logout"))

    def test_rejected_credentials_do_not_echo_the_secret(self):
        values = routes()
        values[("POST", "/users/login")] = HTTPError(API + "/users/login", 401, "Unauthorized", {}, io.BytesIO(json.dumps({"message": "Credenciales incorrectas"}).encode()))
        with TempWorkspace() as fixture:
            with self.assertRaises(MMC.MattermostError) as failure:
                MMC.open_session(fixture.config, runner=FakeKeychain(), opener=FakeServer(values))
        self.assertIn("llavero", str(failure.exception))
        self.assertNotIn(SECRET, str(failure.exception))

    def test_disabled_module_does_not_touch_the_keychain(self):
        keychain = FakeKeychain()

        def disable(config):
            config["modules"]["mattermost"]["enabled"] = False

        with TempWorkspace(disable) as fixture:
            with self.assertRaisesRegex(MMC.esprit_config.ModuleNotConfigured, "no configurado"):
                MMC.open_session(fixture.config, runner=keychain, opener=FakeServer({}))
        self.assertEqual(keychain.calls, [])


class ChannelSelectionTests(unittest.TestCase):
    def member_channels(self):
        return [
            channel("generalid", "general", last_post_at=10),
            channel("seminarioid", "seminario", kind="P", last_post_at=30),
            channel("archivadoid", "archivado", last_post_at=99, delete_at=5),
            channel("dmluisid", "anaid__luisid", kind="D", last_post_at=20),
            channel("dmmartaid", "martaid__anaid", kind="D", last_post_at=15),
            channel("notasid", "anaid__anaid", kind="D", last_post_at=1),
            channel("grupoid", "abc123", kind="G", last_post_at=25, display_name="luis.gomez, marta"),
            {"id": "../raro", "name": "raro", "type": "O"},
        ]

    def test_empty_list_follows_every_member_channel_by_recent_activity(self):
        server = FakeServer(routes(self.member_channels()))
        with TempWorkspace() as fixture:
            _, session = MMC.open_session(fixture.config, runner=FakeKeychain(), opener=server)
        self.assertEqual(
            [(item["id"], item["type"], item["label"]) for item in session["channels"]],
            [
                ("seminarioid", "P", "Seminario"),
                ("grupoid", "G", "luis.gomez, marta"),
                ("dmluisid", "D", "Luis Gómez"),
                ("dmmartaid", "D", "Marta R."),
                ("generalid", "O", "General"),
                ("notasid", "D", "Notas personales"),
            ],
        )
        self.assertEqual(session["channels"][2]["counterpart_user_id"], "luisid")
        self.assertIsNone(session["channels"][5]["counterpart_user_id"])
        self.assertEqual(session["selection"]["mode"], "all_member_channels")
        self.assertEqual(session["selection"]["excluded"], [])
        lookups = [body for method, path, _, body in server.requests if path == "/users/ids"]
        self.assertEqual(lookups, [["luisid", "martaid"]])

    def test_automatic_selection_is_bounded(self):
        many = [channel(f"canal{index}", f"canal-{index}", last_post_at=index) for index in range(MMC.MAX_AUTO_CHANNELS + 5)]
        with TempWorkspace() as fixture:
            _, session = MMC.open_session(fixture.config, runner=FakeKeychain(), opener=FakeServer(routes(many)))
        self.assertEqual(len(session["channels"]), MMC.MAX_AUTO_CHANNELS)
        self.assertEqual(session["channels"][0]["id"], f"canal{MMC.MAX_AUTO_CHANNELS + 4}")
        self.assertEqual([item["id"] for item in session["selection"]["excluded"]], [f"canal{index}" for index in range(4, -1, -1)])

    def test_explicit_names_and_direct_messages_keep_config_order(self):
        server = FakeServer(routes(self.member_channels()))
        with TempWorkspace(configure(channels=["General", "@luis.gomez", "archivado", "no-existe", "general"])) as fixture:
            _, session = MMC.open_session(fixture.config, runner=FakeKeychain(), opener=server)
        self.assertEqual([item["id"] for item in session["channels"]], ["generalid", "dmluisid"])
        self.assertEqual(session["selection"]["mode"], "configured")
        self.assertEqual(len(session["selection"]["warnings"]), 2)
        self.assertTrue(all("No se encontró" in warning for warning in session["selection"]["warnings"]))


class ClientTests(unittest.TestCase):
    def test_post_is_limited_to_search_and_paths_are_checked(self):
        client = MMC.MattermostClient(API, TEST_ZONE, opener=FakeServer({}))
        client.use_token("x")
        with self.assertRaises(MMC.MattermostError):
            client.post("/posts", {"message": "hola"})
        with self.assertRaises(MMC.MattermostError):
            client.get("https://otro.ejemplo.net/api")
        with self.assertRaises(MMC.MattermostError):
            MMC.MattermostClient(API, TEST_ZONE).get("/users/me")

    def test_enrich_post_uses_the_configured_time_zone(self):
        client = MMC.MattermostClient(API, TEST_ZONE, opener=FakeServer({}))
        client.user_cache["luisid"] = "luis.gomez"
        value = client.enrich_post({"user_id": "luisid", "create_at": 1_790_000_000_000})
        self.assertEqual(value["username"], "luis.gomez")
        self.assertTrue(value["created_local"].startswith("2026-09-21T"))

    def test_parse_since_accepts_only_known_forms(self):
        self.assertIsNone(MMC.parse_since("all", TEST_ZONE))
        self.assertIsInstance(MMC.parse_since("today", TEST_ZONE), int)
        self.assertIsInstance(MMC.parse_since("7d", TEST_ZONE), int)
        with self.assertRaises(ValueError):
            MMC.parse_since("ayer por la tarde", TEST_ZONE)


if __name__ == "__main__":
    unittest.main()
