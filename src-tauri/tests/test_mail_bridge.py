"""mail_bridge.py: cuentas m0…, normalización y validación de envío. osascript simulado."""

from __future__ import annotations

import io
import json
import subprocess
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from esprit_fixtures import TempWorkspace, load_bridge

MAIL = load_bridge("mail_bridge")

UNI = "ana.perez@ejemplo.org"
HOME = "ana@correo.ejemplo.org"


def jxa_message(message_id, mailbox="m0", folder="inbox", **extra):
    value = {
        "id": message_id,
        "thread_id": message_id,
        "provider": "apple_mail",
        "internet_message_id": f"<{message_id}@ejemplo.org>",
        "from": "Luis Gómez <luis@ejemplo.org>",
        "from_name": "Luis Gómez",
        "from_address": "luis@ejemplo.org",
        "to": UNI,
        "mailbox": mailbox,
        "mailbox_label": "etiqueta de Mail",
        "mailbox_address": "otra@ejemplo.org",
        "subject": "Seminario",
        "snippet": "Hola",
        "body": "",
        "labels": [],
        "unread": True,
        "folder": folder,
        "is_own": folder == "sent",
        "has_attachment": False,
        "date": "2026-09-20T10:00:00.000Z",
        "display_url": "",
    }
    value.update(extra)
    return value


def run_main(*args, stdin=""):
    output = io.StringIO()
    with redirect_stdout(output), patch("sys.stdin", io.TextIOWrapper(io.BytesIO(stdin.encode("utf-8")))):
        code = MAIL.main(list(args))
    return code, json.loads(output.getvalue())


class AccountMappingTests(unittest.TestCase):
    def test_overview_sends_configured_accounts_and_normalizes_the_answer(self):
        raw = {
            "accounts": [
                {"key": "m0", "connected": True, "unread_count": 3, "error": ""},
                {"key": "m1", "connected": False, "unread_count": 9, "error": "No se encontró la cuenta «Casa» en Mail"},
                {"key": "m7", "connected": True},
            ],
            "sent_accounts": [{"key": "m0", "connected": True, "returned_count": 1, "error": ""}],
            "emails": [
                jxa_message("apple_m0_1", date="2026-09-19T10:00:00.000Z"),
                jxa_message("apple_m0_2", folder="sent", unread=True, date="2026-09-21T10:00:00.000Z"),
                jxa_message("apple_m1_3", mailbox="m0"),
                jxa_message("apple_m5_4", mailbox="m5"),
                jxa_message("gmail-5"),
            ],
            "warnings": ["Personal: No se encontró la cuenta «Casa» en Mail"],
            "sent_source_count": 4,
            "sent_truncated": True,
            "inbox_truncated": False,
            "window_days": 30,
        }
        with TempWorkspace() as fixture, patch.object(MAIL, "_run_apple_mail", return_value=raw) as apple:
            value = MAIL.overview(fixture.config)
        command, accounts = apple.call_args.args[:2]
        self.assertEqual(command, "overview")
        self.assertEqual([account["key"] for account in accounts], ["m0", "m1"])
        self.assertEqual(accounts[1]["mail_account"], "Casa")
        self.assertEqual(
            [(a["key"], a["label"], a["address"], a["provider"], a["connected"], a["unread_count"]) for a in value["accounts"]],
            [("m0", "Universidad", UNI, "apple_mail", True, 3), ("m1", "Personal", HOME, "apple_mail", False, 0)],
        )
        self.assertIn("Casa", value["accounts"][1]["error"])
        self.assertEqual([email["id"] for email in value["emails"]], ["apple_m0_2", "apple_m0_1"])
        sent = value["emails"][0]
        self.assertEqual((sent["folder"], sent["unread"], sent["labels"], sent["is_own"]), ("sent", False, ["SENT"], True))
        inbox = value["emails"][1]
        self.assertEqual((inbox["mailbox_label"], inbox["mailbox_address"]), ("Universidad", UNI))
        self.assertEqual(inbox["labels"], ["UNREAD"])
        self.assertEqual(value["unread_count"], 3)
        self.assertTrue(value["connected"])
        self.assertEqual(value["email_address"], UNI)
        self.assertEqual(value["sent_source"], "Mail")
        self.assertEqual(value["sent_source_count"], 4)
        self.assertTrue(value["sent_truncated"])
        self.assertEqual(value["sent_accounts"][1]["connected"], False)
        self.assertEqual(value["draft_count"], 0)
        self.assertEqual(value["next_page_token"], "")

    def test_mail_failure_is_a_structured_overview_not_a_crash(self):
        with TempWorkspace() as fixture, patch.object(MAIL, "_run_apple_mail", side_effect=MAIL.BridgeError(MAIL.AUTOMATION_HINT)):
            value = MAIL.overview(fixture.config)
        self.assertFalse(value["connected"])
        self.assertEqual(len(value["accounts"]), 2)
        self.assertTrue(all("Automatización" in account["error"] for account in value["accounts"]))
        self.assertEqual(value["warnings"], [f"Mail: {MAIL.AUTOMATION_HINT}"])

    def test_disabled_mail_module_never_calls_mail(self):
        def disable(config):
            config["modules"]["mail"]["enabled"] = False

        with TempWorkspace(disable), patch.object(subprocess, "run") as run:
            code, value = run_main("overview")
        self.assertEqual(code, 1)
        self.assertIn("no configurado", value["error"])
        run.assert_not_called()

    def test_missing_config_is_reported(self):
        with patch.dict("os.environ", {"ESPRIT_CONFIG": "/no/existe/config.json"}), patch.object(subprocess, "run") as run:
            code, value = run_main("overview")
        self.assertEqual(code, 1)
        self.assertIn("No existe", value["error"])
        run.assert_not_called()


class OsascriptTests(unittest.TestCase):
    def test_envelope_carries_accounts_and_request_on_stdin(self):
        accounts = [{"key": "m0", "label": "Universidad", "mail_account": "Universidad", "address": UNI}]
        completed = subprocess.CompletedProcess([], 0, stdout='{"sent": true}', stderr="")
        with patch.object(MAIL.subprocess, "run", return_value=completed) as run:
            MAIL._run_apple_mail("send", accounts, request={"from_account": "m0"})
        arguments = run.call_args.args[0]
        self.assertEqual(arguments[:3], ["/usr/bin/osascript", "-l", "JavaScript"])
        self.assertEqual(arguments[-1], "send")
        self.assertEqual(json.loads(run.call_args.kwargs["input"]), {"accounts": accounts, "request": {"from_account": "m0"}})

    def test_automation_denial_becomes_actionable_spanish(self):
        accounts = [{"key": "m0", "label": "U", "mail_account": "U", "address": UNI}]
        for completed in [
            subprocess.CompletedProcess([], 1, stdout="", stderr="execution error: Not authorized to send Apple events to Mail. (-1743)"),
            subprocess.CompletedProcess([], 0, stdout='{"error": "Error: -1743"}', stderr=""),
        ]:
            with self.subTest(completed=completed), patch.object(MAIL.subprocess, "run", return_value=completed):
                with self.assertRaisesRegex(MAIL.BridgeError, "Automatización"):
                    MAIL._run_apple_mail("overview", accounts)

    def test_timeout_and_unknown_commands(self):
        accounts = [{"key": "m0", "label": "U", "mail_account": "U", "address": UNI}]
        with patch.object(MAIL.subprocess, "run", side_effect=subprocess.TimeoutExpired("osascript", 1)):
            with self.assertRaisesRegex(MAIL.BridgeError, "tardó"):
                MAIL._run_apple_mail("overview", accounts)
        with patch.object(MAIL.subprocess, "run") as run:
            with self.assertRaises(MAIL.BridgeError):
                MAIL._run_apple_mail("delete", accounts)
            run.assert_not_called()


class ThreadTests(unittest.TestCase):
    def test_thread_ids_are_validated_before_mail(self):
        with TempWorkspace() as fixture, patch.object(MAIL, "_run_apple_mail") as apple:
            for thread_id in ["", "apple_m2_1", "apple_m0_0", "apple_staff_1", "gmail-1", "apple_m0_1; rm", "apple_m0_12345678901234567"]:
                with self.subTest(thread_id=thread_id):
                    with self.assertRaises(MAIL.BridgeError):
                        MAIL.read_thread(fixture.config, thread_id)
            apple.assert_not_called()

    def test_thread_is_deduplicated_sorted_and_limited_to_its_account(self):
        raw = {
            "thread_id": "apple_m0_12",
            "messages": [
                jxa_message("apple_m0_12", date="2026-09-22T10:00:00.000Z", body="Última"),
                jxa_message("apple_m0_10", date="2026-09-20T10:00:00.000Z", body="Primera"),
                jxa_message("apple_m0_11", folder="sent", date="2026-09-21T10:00:00+02:00", internet_message_id="<apple_m0_10@ejemplo.org>"),
                jxa_message("apple_m1_13", mailbox="m1"),
            ],
            "truncated": False,
            "source_thread_count": 2,
        }
        with TempWorkspace() as fixture, patch.object(MAIL, "_run_apple_mail", return_value=raw) as apple:
            value = MAIL.read_thread(fixture.config, "apple_m0_12")
        self.assertEqual(apple.call_args.kwargs["argument"], "apple_m0_12")
        self.assertEqual([message["id"] for message in value["messages"]], ["apple_m0_10", "apple_m0_12"])
        self.assertEqual(value["messages"][0]["body"], "Primera")
        self.assertEqual(value["message_count"], 2)
        self.assertTrue(value["reconstructed"])
        self.assertEqual(value["source_thread_count"], 2)

    def test_missing_requested_message_is_an_error(self):
        raw = {"messages": [jxa_message("apple_m0_10")]}
        with TempWorkspace() as fixture, patch.object(MAIL, "_run_apple_mail", return_value=raw):
            with self.assertRaisesRegex(MAIL.BridgeError, "no devolvió"):
                MAIL.read_thread(fixture.config, "apple_m0_12")


class SendValidationTests(unittest.TestCase):
    def setUp(self):
        self.request = {
            "from_account": "m0",
            "to": "Revisado <revisado@ejemplo.net>, segundo@ejemplo.net",
            "subject": "Re: Seminario",
            "body": "Cuerpo revisado\n",
            "reply_message_id": "apple_m0_42",
        }

    def test_valid_reply_rebuilds_the_outgoing_request_from_an_allowlist(self):
        with TempWorkspace() as fixture, patch.object(MAIL, "_run_apple_mail", return_value={"sent": True}) as apple:
            value = MAIL.send(fixture.config, {
                **self.request,
                "to_addresses": ["oculto@ejemplo.net"],
                "reply_internet_message_id": "<inventado@ejemplo.net>",
                "cc": "oculto@ejemplo.net",
            })
        self.assertEqual(value, {"sent": True, "message_id": "", "thread_id": "apple_m0_42"})
        command, accounts = apple.call_args.args[:2]
        self.assertEqual(command, "send")
        self.assertEqual([account["key"] for account in accounts], ["m0", "m1"])
        self.assertEqual(apple.call_args.kwargs["request"], {
            "from_account": "m0",
            "to": self.request["to"],
            "to_addresses": ["revisado@ejemplo.net", "segundo@ejemplo.net"],
            "subject": "Re: Seminario",
            "body": "Cuerpo revisado",
            "reply_message_id": "apple_m0_42",
        })

    def test_forward_or_new_message_has_no_reply_target(self):
        with TempWorkspace() as fixture, patch.object(MAIL, "_run_apple_mail", return_value={"sent": True}) as apple:
            MAIL.send(fixture.config, {**self.request, "from_account": "m1", "reply_message_id": None})
        self.assertEqual(apple.call_args.kwargs["request"]["reply_message_id"], "")
        self.assertEqual(apple.call_args.kwargs["request"]["from_account"], "m1")

    def test_invalid_requests_fail_before_mail(self):
        cases = [
            {"from_account": "m2"},
            {"from_account": "staff"},
            {"from_account": ""},
            {"reply_message_id": "apple_m1_42"},
            {"reply_message_id": "gmail-42"},
            {"reply_message_id": "apple_m0_0"},
            {"to": "bueno@ejemplo.net, invalido"},
            {"to": "bueno@ejemplo.net\nBcc: oculto@ejemplo.net"},
            {"to": ", ".join(f"p{index}@ejemplo.net" for index in range(31))},
            {"to": ""},
            {"subject": "Asunto\r\nBcc: oculto@ejemplo.net"},
            {"subject": " "},
            {"subject": "x" * 501},
            {"body": "  \n"},
            {"body": "x" * 80_001},
        ]
        with TempWorkspace() as fixture:
            for change in cases:
                with self.subTest(change=change), patch.object(MAIL, "_run_apple_mail") as apple:
                    with self.assertRaises(MAIL.BridgeError):
                        MAIL.send(fixture.config, {**self.request, **change})
                    apple.assert_not_called()

    def test_unconfirmed_send_is_not_reported_as_sent(self):
        with TempWorkspace() as fixture, patch.object(MAIL, "_run_apple_mail", return_value={"sent": False}):
            with self.assertRaisesRegex(MAIL.BridgeError, "no confirmó"):
                MAIL.send(fixture.config, self.request)

    def test_send_cli_reads_json_from_stdin(self):
        with TempWorkspace(), patch.object(MAIL, "_run_apple_mail", return_value={"sent": True}):
            code, value = run_main("send", stdin=json.dumps(self.request))
            self.assertEqual((code, value["sent"]), (0, True))
            code, value = run_main("send", stdin="no es json")
            self.assertEqual(code, 1)
            self.assertIn("no es válida", value["error"])
            code, value = run_main("borrar")
            self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
