from __future__ import annotations

import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from esprit_fixtures import TEST_ZONE, load_bridge

BRIDGE = load_bridge("mattermost_bridge")


class FakeModule:
    @staticmethod
    def public_post(post):
        return {
            "id": post["id"],
            "created_local": post["created_local"],
            "message": post.get("message", ""),
        }


class FakeClient:
    def __init__(self, pages):
        self.pages = pages
        self.requested_pages = []

    def get(self, path):
        page = int(parse_qs(urlparse(path).query)["page"][0])
        self.requested_pages.append(page)
        posts = self.pages.get(page, [])
        return {
            "order": [post["id"] for post in posts],
            "posts": {post["id"]: post for post in posts},
        }

    @staticmethod
    def enrich_post(post):
        return {
            **post,
            "created_local": f"2026-08-23T00:{post['create_at']:04d}+02:00",
        }


def post(post_id, created_at):
    return {
        "id": post_id,
        "create_at": created_at,
        "message": post_id,
        "type": "",
    }


CONFIG = {
    "identity": {"user_id": "ownuser", "username": "ana.perez", "timezone": TEST_ZONE},
    "team": {"id": "teamone", "name": "Grupo de Ejemplo"},
    "server": {"url": "https://chat.ejemplo.org"},
    "channels": [
        {"id": "channelone", "name": "research", "type": "O", "label": "Research"},
        {"id": "dmone", "name": "ownuser__luisid", "type": "D", "label": "Luis Gómez", "counterpart_user_id": "luisid"},
    ],
    "selection": {"mode": "all_member_channels", "warnings": [], "excluded": [], "limit": 40},
}


class InteractiveClient:
    def __init__(self):
        self.values = {}
        self.requests = []
        self.base = "https://mattermost.example/api/v4"
        self.token = "private-test-token"

    def get(self, path):
        return self.values[path]

    def _request(self, method, path, payload=None):
        self.requests.append((method, path, payload))
        response = {
            "id": "postone",
            "channel_id": payload.get("channel_id", "channelone") if payload else "channelone",
            "user_id": "ownuser",
            "message": payload["message"],
            "create_at": 100,
            "update_at": 200,
            "edit_at": 200 if method == "PUT" else 0,
            "delete_at": 0,
        }
        return response, {}

    @staticmethod
    def enrich_post(value):
        return {**value, "username": "ana.perez", "created_local": "2026-08-23T10:00+02:00"}


class ChannelSnapshotClient(InteractiveClient):
    def get(self, path):
        self.requests.append(("GET", path, None))
        return {
            "order": ["deleted", "edited"],
            "posts": {
                "deleted": {
                    "id": "deleted",
                    "channel_id": "channelone",
                    "user_id": "other",
                    "message": "gone",
                    "create_at": 50,
                    "update_at": 60,
                    "delete_at": 60,
                    "type": "",
                },
                "edited": {
                    "id": "edited",
                    "channel_id": "channelone",
                    "user_id": "ownuser",
                    "message": "new value",
                    "create_at": 100,
                    "update_at": 200,
                    "edit_at": 200,
                    "delete_at": 0,
                    "type": "",
                    "file_ids": ["fileone"],
                    "metadata": {
                        "files": [
                            {
                                "id": "fileone",
                                "name": "paper.pdf",
                                "extension": "pdf",
                                "mime_type": "application/pdf",
                                "size": 321,
                            }
                        ]
                    },
                },
            },
        }


class CompleteChannelPostsTests(unittest.TestCase):
    def test_pages_until_it_crosses_the_time_boundary(self):
        client = FakeClient(
            {
                0: [post("newest", 3000), post("newer", 2000)],
                1: [post("too-old", 500)],
            }
        )
        posts, coverage = BRIDGE.complete_channel_posts(
            client,
            FakeModule,
            "channel",
            1000,
            per_page=2,
            max_pages=3,
        )
        self.assertEqual(client.requested_pages, [0, 1])
        self.assertEqual({value["id"] for value in posts}, {"newest", "newer"})
        self.assertTrue(coverage["complete"])
        self.assertFalse(coverage["truncated"])
        self.assertEqual(coverage["pages_read"], 2)

    def test_declares_truncation_when_the_guard_is_reached(self):
        client = FakeClient(
            {
                0: [post("p4", 4000), post("p3", 3000)],
                1: [post("p2", 2000), post("p1", 1500)],
            }
        )
        _, coverage = BRIDGE.complete_channel_posts(
            client,
            FakeModule,
            "channel",
            1000,
            per_page=2,
            max_pages=2,
        )
        self.assertFalse(coverage["complete"])
        self.assertTrue(coverage["truncated"])
        self.assertEqual(coverage["page_limit"], 2)

    def test_omits_soft_deleted_posts_from_daily_pages(self):
        deleted = {**post("deleted", 2500), "delete_at": 2600}
        client = FakeClient({0: [post("visible", 3000), deleted]})
        posts, _ = BRIDGE.complete_channel_posts(
            client,
            FakeModule,
            "channel",
            1000,
            per_page=2,
            max_pages=2,
        )
        self.assertEqual([value["id"] for value in posts], ["visible"])


class InteractiveMattermostTests(unittest.TestCase):
    def test_channel_is_authoritative_and_preserves_edit_revision(self):
        client = ChannelSnapshotClient()
        value = BRIDGE.channel_posts(client, CONFIG, "channelone")
        self.assertEqual(len(value["posts"]), 1)
        current = value["posts"][0]
        self.assertEqual(current["id"], "edited")
        self.assertEqual(current["revision"], 200)
        self.assertTrue(current["edited"])
        self.assertTrue(current["is_own"])
        self.assertEqual(current["attachments"][0]["name"], "paper.pdf")
        requested_path = client.requests[0][1]
        self.assertIn("page=0", requested_path)
        self.assertIn("per_page=200", requested_path)
        self.assertNotIn("since=", requested_path)

    def test_channel_progressively_expands_from_recent_to_full_history(self):
        recent = BRIDGE.channel_posts(ChannelSnapshotClient(), CONFIG, "channelone")
        full = BRIDGE.channel_posts(ChannelSnapshotClient(), CONFIG, "channelone", full=True)
        self.assertEqual(recent["history"]["mode"], "recent")
        self.assertEqual(recent["history"]["post_limit"], 400)
        self.assertEqual(full["history"]["mode"], "full")
        self.assertEqual(full["history"]["post_limit"], BRIDGE.MAX_INTERACTIVE_POSTS)

    def test_channel_fetches_a_missing_thread_root_for_grouped_rendering(self):
        class ThreadSnapshotClient(InteractiveClient):
            def get(self, path):
                if path == "/posts/rootone":
                    return {
                        "id": "rootone",
                        "channel_id": "channelone",
                        "root_id": "",
                        "user_id": "other",
                        "message": "Old root",
                        "create_at": 100,
                        "update_at": 100,
                        "delete_at": 0,
                        "type": "",
                    }
                return {
                    "order": ["replyone"],
                    "posts": {
                        "replyone": {
                            "id": "replyone",
                            "channel_id": "channelone",
                            "root_id": "rootone",
                            "user_id": "ownuser",
                            "message": "Recent reply",
                            "create_at": 200,
                            "update_at": 200,
                            "delete_at": 0,
                            "type": "",
                        }
                    },
                }

        value = BRIDGE.channel_posts(ThreadSnapshotClient(), CONFIG, "channelone")
        self.assertEqual([post["id"] for post in value["posts"]], ["rootone", "replyone"])
        self.assertEqual(value["history"]["thread_roots_added"], 1)

    def test_channel_resolves_authors_and_roots_in_bulk(self):
        reply = lambda post_id, root, user: {"id": post_id, "channel_id": "channelone", "root_id": root, "user_id": user, "message": post_id, "create_at": 200, "update_at": 200, "delete_at": 0, "type": ""}

        class BulkClient:
            def __init__(self):
                self.requests = []
                self.user_cache = {}

            def get(self, path):
                self.requests.append(("GET", path))
                if path.startswith("/channels/channelone/posts"):
                    posts = {"a": reply("a", "rootone", "userone"), "b": reply("b", "roottwo", "usertwo")}
                    return {"order": ["a", "b"], "posts": posts}
                raise AssertionError(f"unexpected single read {path}")

            def _request(self, method, path, payload=None):
                self.requests.append((method, path))
                if path == "/users/ids":
                    return [{"id": user_id, "username": f"name-{user_id}"} for user_id in payload], {}
                if path == "/posts/ids":
                    foreign = {**reply("roottwo", "", "userthree"), "channel_id": "elsewhere"}
                    return [{**reply("rootone", "", "userthree"), "create_at": 100}, foreign], {}
                if path == "/users/status/ids":
                    return [], {}
                raise AssertionError(f"unexpected request {path}")

            def enrich_post(self, value):
                return {**value, "username": self.user_cache.get(value["user_id"], "?"), "created_local": "2026-09-22T10:00+02:00"}

        client = BulkClient()
        value = BRIDGE.channel_posts(client, CONFIG, "channelone")
        self.assertEqual([post["id"] for post in value["posts"]], ["rootone", "a", "b"])
        self.assertEqual(value["history"]["thread_roots_added"], 1)
        self.assertEqual(client.user_cache["userone"], "name-userone")
        self.assertEqual(client.user_cache["userthree"], "name-userthree")
        self.assertFalse(any(path.startswith("/users/") and method == "GET" for method, path in client.requests))
        self.assertEqual(sum(path == "/posts/ids" for _, path in client.requests), 1)

    def test_send_uses_only_the_exact_post_endpoint(self):
        client = InteractiveClient()
        value = BRIDGE.send_message(
            client,
            CONFIG,
            {"channel_id": "channelone", "message": "## Update\n\n$E=mc^2$"},
        )
        self.assertEqual(client.requests, [
            ("POST", "/posts", {"channel_id": "channelone", "message": "## Update\n\n$E=mc^2$"})
        ])
        self.assertEqual(value["id"], "postone")

    def test_reply_revalidates_the_live_root_before_posting(self):
        client = InteractiveClient()
        client.values["/posts/rootone"] = {
            "id": "rootone",
            "channel_id": "channelone",
            "root_id": "",
            "delete_at": 0,
        }
        BRIDGE.send_message(
            client,
            CONFIG,
            {
                "channel_id": "channelone",
                "message": "Respuesta revisada",
                "root_id": "rootone",
            },
        )
        self.assertEqual(
            client.requests,
            [
                (
                    "POST",
                    "/posts",
                    {
                        "channel_id": "channelone",
                        "message": "Respuesta revisada",
                        "root_id": "rootone",
                    },
                )
            ],
        )

    def test_reply_rejects_deleted_or_cross_channel_roots(self):
        client = InteractiveClient()
        client.values["/posts/rootone"] = {
            "id": "rootone",
            "channel_id": "otherchannel",
            "root_id": "",
            "delete_at": 0,
        }
        with self.assertRaisesRegex(RuntimeError, "canal seleccionado"):
            BRIDGE.send_message(
                client,
                CONFIG,
                {"channel_id": "channelone", "message": "Draft", "root_id": "rootone"},
            )
        client.values["/posts/rootone"]["channel_id"] = "channelone"
        client.values["/posts/rootone"]["delete_at"] = 1
        with self.assertRaisesRegex(RuntimeError, "eliminado"):
            BRIDGE.send_message(
                client,
                CONFIG,
                {"channel_id": "channelone", "message": "Draft", "root_id": "rootone"},
            )
        self.assertEqual(client.requests, [])

    def test_send_rejects_unfollowed_channel_and_invalid_message(self):
        client = InteractiveClient()
        with self.assertRaisesRegex(RuntimeError, "no autorizado"):
            BRIDGE.send_message(client, CONFIG, {"channel_id": "otrocanal", "message": "hello"})
        with self.assertRaisesRegex(RuntimeError, "16.000"):
            BRIDGE.send_message(client, CONFIG, {"channel_id": "channelone", "message": "\0"})
        self.assertEqual(client.requests, [])

    def test_edit_refetches_ownership_and_revision_before_patch(self):
        client = InteractiveClient()
        client.values["/posts/postone"] = {
            "id": "postone",
            "channel_id": "channelone",
            "user_id": "ownuser",
            "message": "old",
            "create_at": 100,
            "update_at": 150,
            "delete_at": 0,
        }
        BRIDGE.edit_message(
            client,
            CONFIG,
            {"post_id": "postone", "message": "new", "expected_update_at": 150},
        )
        self.assertEqual(client.requests, [("PUT", "/posts/postone/patch", {"message": "new"})])

    def test_edit_preserves_draft_on_stale_or_foreign_post(self):
        client = InteractiveClient()
        client.values["/posts/postone"] = {
            "id": "postone",
            "channel_id": "channelone",
            "user_id": "ownuser",
            "create_at": 100,
            "update_at": 151,
            "delete_at": 0,
        }
        with self.assertRaisesRegex(RuntimeError, "stale_post"):
            BRIDGE.edit_message(
                client,
                CONFIG,
                {"post_id": "postone", "message": "draft", "expected_update_at": 150},
            )
        client.values["/posts/postone"]["user_id"] = "someoneelse"
        with self.assertRaisesRegex(RuntimeError, "propios"):
            BRIDGE.edit_message(
                client,
                CONFIG,
                {"post_id": "postone", "message": "draft", "expected_update_at": 151},
            )
        self.assertEqual(client.requests, [])

    def test_attachment_is_validated_then_previewed_on_demand(self):
        client = InteractiveClient()
        client.values["/files/fileone/info"] = {
            "id": "fileone",
            "post_id": "postone",
            "name": "paper.pdf",
            "extension": "pdf",
            "mime_type": "application/pdf",
            "size": 9,
            "delete_at": 0,
        }
        client.values["/posts/postone"] = {
            "id": "postone",
            "channel_id": "channelone",
            "user_id": "other",
            "file_ids": ["fileone"],
            "delete_at": 0,
        }
        with patch.object(BRIDGE, "download_attachment_bytes", return_value=b"%PDF-1.7") as download:
            value = BRIDGE.attachment_preview(client, CONFIG, "fileone")
        download.assert_called_once_with(client, "fileone", BRIDGE.MAX_BINARY_PREVIEW_BYTES)
        self.assertEqual(value["kind"], "pdf")
        self.assertEqual(value["data_base64"], "JVBERi0xLjc=")

    def test_attachment_rejects_deleted_post_without_downloading(self):
        client = InteractiveClient()
        client.values["/files/fileone/info"] = {
            "id": "fileone",
            "post_id": "postone",
            "name": "notes.txt",
            "mime_type": "text/plain",
            "size": 4,
        }
        client.values["/posts/postone"] = {
            "id": "postone",
            "channel_id": "channelone",
            "file_ids": ["fileone"],
            "delete_at": 20,
        }
        with patch.object(BRIDGE, "download_attachment_bytes") as download:
            with self.assertRaisesRegex(RuntimeError, "eliminado"):
                BRIDGE.attachment_preview(client, CONFIG, "fileone")
        download.assert_not_called()

    def test_avatar_requires_live_channel_membership_and_bounded_image(self):
        client = InteractiveClient()
        client.values["/channels/channelone/members/otheruser"] = {
            "channel_id": "channelone",
            "user_id": "otheruser",
        }
        with patch.object(
            BRIDGE,
            "download_user_avatar",
            return_value=(b"\x89PNG\r\n\x1a\n", "image/png"),
        ) as download:
            value = BRIDGE.avatar_preview(
                client,
                CONFIG,
                {"channel_id": "channelone", "user_id": "otheruser"},
            )
        download.assert_called_once_with(client, "otheruser")
        self.assertEqual(value["mime_type"], "image/png")
        self.assertEqual(value["data_base64"], "iVBORw0KGgo=")

    def test_avatar_rejects_a_user_outside_the_channel(self):
        client = InteractiveClient()
        client.values["/channels/channelone/members/otheruser"] = {}
        with patch.object(BRIDGE, "download_user_avatar") as download:
            with self.assertRaisesRegex(RuntimeError, "no pertenece"):
                BRIDGE.avatar_preview(
                    client,
                    CONFIG,
                    {"channel_id": "channelone", "user_id": "otheruser"},
                )
        download.assert_not_called()


class OverviewClient:
    def __init__(self):
        self.requests = []
        self.user_cache = {}

    def get(self, path):
        self.requests.append(path)
        if path.endswith("/channels/members"):
            return [
                {"channel_id": "channelone", "msg_count": 8, "mention_count": 1},
                {"channel_id": "dmone", "msg_count": 2, "mention_count": 0},
            ]
        if path.endswith("/channels/categories"):
            return {"order": [], "categories": []}
        raise AssertionError(f"unexpected read {path}")

    def _request(self, method, path, payload=None):
        return [], {}


class OverviewAndSweepTests(unittest.TestCase):
    def test_overview_uses_the_resolved_channels_without_special_cases(self):
        session = {
            **CONFIG,
            "api_channels": {
                "channelone": {"id": "channelone", "name": "research", "display_name": "Investigación", "total_msg_count": 10, "last_post_at": 7},
                "dmone": {"id": "dmone", "name": "ownuser__luisid", "total_msg_count": 5, "last_post_at": 9},
            },
            "selection": {"mode": "all_member_channels", "warnings": [], "excluded": [{"id": "x", "name": "x", "last_post_at": 1}], "limit": 40},
        }
        client = OverviewClient()
        value = BRIDGE.overview(client, session)
        self.assertFalse(any(path.endswith("/teams/teamone/channels") for path in client.requests))
        channels = {item["id"]: item for item in value["channels"]}
        self.assertEqual(channels["channelone"]["label"], "Investigación")
        self.assertEqual(channels["channelone"]["badge"], 1)
        self.assertEqual(channels["dmone"]["label"], "Luis Gómez")
        self.assertEqual(channels["dmone"]["badge"], 3)
        self.assertEqual(channels["dmone"]["counterpart_user_id"], "luisid")
        self.assertTrue(all(item["restricted"] is False for item in value["channels"]))
        self.assertEqual(value["notification_count"], 4)
        self.assertEqual(value["team"], "Grupo de Ejemplo")
        self.assertEqual(value["channel_selection"], "all_member_channels")
        self.assertEqual(len(value["warnings"]), 1)

    def test_daily_sweep_is_partial_when_an_excluded_channel_was_active(self):
        class SweepClient:
            def get(self, path):
                return {"order": [], "posts": {}}

            def search_team(self, team_id, terms, is_or_search):
                self.search = (team_id, terms)
                return []

            def thread(self, root_id):
                return []

        for last_post_at, status in [(0, "fresh"), (10**13, "partial")]:
            with self.subTest(status=status):
                session = {**CONFIG, "selection": {**CONFIG["selection"], "excluded": [{"id": "old", "name": "antiguo", "last_post_at": last_post_at}]}}
                client = SweepClient()
                value = BRIDGE.daily_sweep(client, session, "today")
                self.assertEqual(value["status"], status)
                self.assertEqual(value["coverage"]["excluded_active_channels"], 0 if status == "fresh" else 1)
                self.assertNotIn("administrative_channel_messages", value["coverage"])
                self.assertEqual(client.search[0], "teamone")
                self.assertTrue(client.search[1].startswith("@ana.perez after:"))
                self.assertEqual([item["label"] for item in value["channels"]], ["Research", "Luis Gómez"])


class EmojiCatalogClient:
    def __init__(self, entries=None, membership=None):
        self.entries = [] if entries is None else entries
        self.membership = {"channel_id": "channelone", "user_id": "ownuser"} if membership is None else membership
        self.requests = []

    def get(self, path):
        self.requests.append(path)
        if "/members/" in path:
            return self.membership
        if isinstance(self.entries, Exception):
            raise self.entries
        return self.entries


class EmojiCatalogTests(unittest.TestCase):
    def test_only_reads_membership_and_names_without_metadata_or_credentials(self):
        client = EmojiCatalogClient([{"id": "emojiid", "name": "equipo_ok", "creator_id": "private_user", "token": "never_return"}])
        value = BRIDGE.emoji_catalog(client, CONFIG, {"channel_id": "channelone", "page": 0})
        self.assertEqual(value, {"names": ["equipo_ok"], "next_page": None, "truncated": False})
        self.assertEqual(client.requests, ["/channels/channelone/members/ownuser", "/emoji?page=0&per_page=100&sort=name"])

    def test_rejects_unknown_channels_invalid_pages_and_extra_fields_before_reads(self):
        for payload in [{"channel_id": "otrocanal", "page": 0}, {"channel_id": "unknown", "page": 0},
                        {"channel_id": "../secret", "page": 0}, {"channel_id": "channelone", "page": -1},
                        {"channel_id": "channelone", "page": True}, {"channel_id": "channelone", "page": 20},
                        {"channel_id": "channelone", "page": 0, "url": "https://example.com"}]:
            with self.subTest(payload=payload):
                client = EmojiCatalogClient()
                with self.assertRaises(RuntimeError):
                    BRIDGE.emoji_catalog(client, CONFIG, payload)
                self.assertEqual(client.requests, [])

    def test_membership_is_verified_before_catalogue(self):
        for membership in [{"channel_id": "otherchannel", "user_id": "ownuser"}, {"channel_id": "channelone", "user_id": "someoneelse"}, []]:
            client = EmojiCatalogClient(membership=membership)
            with self.assertRaisesRegex(RuntimeError, "pertenece"):
                BRIDGE.emoji_catalog(client, CONFIG, {"channel_id": "channelone", "page": 0})
            self.assertEqual(client.requests, ["/channels/channelone/members/ownuser"])

    def test_pagination_is_bounded_and_reports_possible_truncation(self):
        entries = [{"name": f"emoji_{index}"} for index in range(100)]
        client = EmojiCatalogClient(entries)
        self.assertEqual(BRIDGE.emoji_catalog(client, CONFIG, {"channel_id": "channelone", "page": 0})["next_page"], 1)
        capped = BRIDGE.emoji_catalog(client, CONFIG, {"channel_id": "channelone", "page": 19})
        self.assertTrue(capped["truncated"])
        self.assertIsNone(capped["next_page"])
        client.entries.append({"name": "one_too_many"})
        with self.assertRaisesRegex(RuntimeError, "no válido"):
            BRIDGE.emoji_catalog(client, CONFIG, {"channel_id": "channelone", "page": 0})

    def test_catalogue_failure_is_not_an_empty_result_or_a_secret_error(self):
        client = EmojiCatalogClient(RuntimeError("Bearer private-test-token"))
        with self.assertRaisesRegex(RuntimeError, "No se pudo cargar") as failure:
            BRIDGE.emoji_catalog(client, CONFIG, {"channel_id": "channelone", "page": 0})
        self.assertNotIn("private-test-token", str(failure.exception))

    def test_invalid_names_fail_and_deleted_or_duplicate_names_are_not_returned(self):
        client = EmojiCatalogClient([{"name": "https://untrusted"}])
        with self.assertRaisesRegex(RuntimeError, "nombre"):
            BRIDGE.emoji_catalog(client, CONFIG, {"channel_id": "channelone", "page": 0})
        client.entries = [{"name": "ok"}, {"name": "ok"}, {"name": "deleted", "delete_at": 12}]
        self.assertEqual(BRIDGE.emoji_catalog(client, CONFIG, {"channel_id": "channelone", "page": 0})["names"], ["ok"])


if __name__ == "__main__":
    unittest.main()
