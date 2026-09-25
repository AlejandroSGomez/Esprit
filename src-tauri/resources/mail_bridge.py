#!/usr/bin/env python3
"""Puente de correo de Esprit sobre Mail.app.

Lee y envía con las cuentas que el usuario ya tiene en Mail.app, mediante
Apple Events (``apple_mail_bridge.js``). Las cuentas salen de
``modules.mail.accounts`` de la configuración de Esprit y reciben las claves
estables ``m0``, ``m1``… en ese orden. Esprit no guarda credenciales ni
cachés: Mail conserva la autenticación.

CLI (salida JSON en stdout; con error, ``{"error": "..."}`` y código 1)::

    mail_bridge.py overview
    mail_bridge.py thread <apple_mN_ID>
    mail_bridge.py send          # solicitud JSON por stdin
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import time
import unicodedata
from datetime import datetime, timezone
from email.utils import getaddresses, parsedate_to_datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import esprit_config  # noqa: E402


APPLE_MAIL_SCRIPT = Path(__file__).with_name("apple_mail_bridge.js")
OSASCRIPT = "/usr/bin/osascript"
TIMEOUTS = {"overview": 75.0, "thread": 45.0, "send": 60.0}
MAX_BODY_CHARS = 80_000
MAX_SNIPPET_CHARS = 600
MAX_OUTPUT_BYTES = 24 * 1_048_576
MAX_RECIPIENTS = 30
THREAD_ID_RE = re.compile(r"apple_(m[0-3])_([1-9][0-9]{0,15})")
ADDRESS_RE = re.compile(r"[^@<>\s,;\x00-\x1f\x7f]+@[^@<>\s,;\x00-\x1f\x7f]+")
AUTOMATION_HINT = "Autoriza Esprit para controlar Mail en Ajustes del Sistema → Privacidad y seguridad → Automatización"


class BridgeError(RuntimeError):
    pass


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _clean(value: Any, limit: int) -> str:
    return unicodedata.normalize("NFC", _text(value)).replace("\x00", "")[:limit]


def _now_ms() -> int:
    return int(time.time() * 1000)


def _message_timestamp(message: Dict[str, Any]) -> float:
    raw = _text(message.get("date")).strip()
    if not raw:
        return 0.0
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
    except ValueError:
        pass
    try:
        parsed = parsedate_to_datetime(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except (TypeError, ValueError, OverflowError):
        return 0.0


def _deduplicate_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Exact Message-ID dedup only; distinct messages are never merged by subject/date."""
    unique: Dict[str, Dict[str, Any]] = {}
    for index, message in enumerate(messages):
        internet_id = _text(message.get("internet_message_id")).strip().strip("<>").casefold()
        key = f"internet:{internet_id}" if internet_id else (_text(message.get("id")) or f"fallback:{index}")
        current = unique.get(key)
        if current is None or (not current.get("body") and message.get("body")):
            unique[key] = message
    return sorted(unique.values(), key=lambda message: (_message_timestamp(message), _text(message.get("id"))))


# --- Mail.app --------------------------------------------------------------


def _automation_error(detail: str) -> bool:
    lowered = detail.lower()
    return "-1743" in detail or "not authorized" in lowered or "not permitted" in lowered or "no autoriz" in lowered


def _run_apple_mail(
    command: str,
    accounts: List[Dict[str, str]],
    argument: str = "",
    request: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    if command not in TIMEOUTS or not APPLE_MAIL_SCRIPT.is_file():
        raise BridgeError("No se encontró el puente local de Mail")
    arguments = [OSASCRIPT, "-l", "JavaScript", str(APPLE_MAIL_SCRIPT), command]
    if argument:
        arguments.append(argument)
    envelope: Dict[str, Any] = {"accounts": accounts}
    if request is not None:
        envelope["request"] = request
    try:
        process = subprocess.run(
            arguments,
            input=json.dumps(envelope, ensure_ascii=False),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=TIMEOUTS[command],
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise BridgeError("Mail tardó demasiado en responder") from error
    except OSError as error:
        raise BridgeError("No se pudo iniciar osascript para hablar con Mail") from error
    raw_output = (process.stdout or "").strip()
    if len(raw_output) > MAX_OUTPUT_BYTES:
        raise BridgeError("La respuesta de Mail supera el límite seguro")
    try:
        value = json.loads(raw_output)
    except json.JSONDecodeError as error:
        detail = (process.stderr or "").strip()
        if _automation_error(detail):
            raise BridgeError(AUTOMATION_HINT) from error
        raise BridgeError(detail[:500] or "Mail devolvió una respuesta no válida") from error
    if not isinstance(value, dict):
        raise BridgeError("Mail devolvió una respuesta no válida")
    if value.get("error"):
        detail = _text(value.get("error"))
        if _automation_error(detail):
            raise BridgeError(AUTOMATION_HINT)
        raise BridgeError(detail[:500] or "Mail no pudo completar la operación")
    if process.returncode != 0:
        raise BridgeError((process.stderr or "").strip()[:500] or "Mail no pudo completar la operación")
    return value


# --- Normalización ---------------------------------------------------------


def _clean_message(raw: Any, accounts_by_key: Dict[str, Dict[str, str]]) -> Optional[Dict[str, Any]]:
    """Projects one JXA record onto the fixed message contract, or drops it."""
    if not isinstance(raw, dict):
        return None
    message_id = _text(raw.get("id"))
    match = THREAD_ID_RE.fullmatch(message_id)
    if not match or match.group(1) not in accounts_by_key or _text(raw.get("mailbox")) != match.group(1):
        return None
    account = accounts_by_key[match.group(1)]
    folder = "sent" if raw.get("folder") == "sent" else "inbox"
    unread = folder == "inbox" and raw.get("unread") is True
    labels = ["SENT"] if folder == "sent" else (["UNREAD"] if unread else [])
    return {
        "id": message_id,
        "thread_id": message_id,
        "provider": "apple_mail",
        "internet_message_id": _clean(raw.get("internet_message_id"), 998),
        "from": _clean(raw.get("from"), 1000),
        "from_name": _clean(raw.get("from_name"), 300) or "Remitente",
        "from_address": _clean(raw.get("from_address"), 320),
        "to": _clean(raw.get("to"), 4000),
        "mailbox": account["key"],
        "mailbox_label": account["label"],
        "mailbox_address": account["address"],
        "subject": _clean(raw.get("subject"), 1000) or "(Sin asunto)",
        "snippet": _clean(raw.get("snippet"), MAX_SNIPPET_CHARS),
        "body": _clean(raw.get("body"), MAX_BODY_CHARS),
        "labels": labels,
        "unread": unread,
        "has_attachment": raw.get("has_attachment") is True,
        "date": _clean(raw.get("date"), 64),
        "display_url": "",
        "folder": folder,
        "is_own": folder == "sent" or raw.get("is_own") is True,
    }


def _account_status(account: Dict[str, str], raw: Any = None, error: str = "") -> Dict[str, Any]:
    value = raw if isinstance(raw, dict) else {}
    connected = value.get("connected") is True and not error
    unread = value.get("unread_count")
    return {
        "key": account["key"],
        "label": account["label"],
        "address": account["address"],
        "provider": "apple_mail",
        "connected": connected,
        "unread_count": unread if connected and isinstance(unread, int) and unread >= 0 else 0,
        "error": error or ("" if connected else _clean(value.get("error"), 500) or "Mail no devolvió esta cuenta"),
    }


def _sent_status(account: Dict[str, str], raw: Any = None, error: str = "") -> Dict[str, Any]:
    value = raw if isinstance(raw, dict) else {}
    connected = value.get("connected") is True and not error
    returned = value.get("returned_count")
    return {
        "key": account["key"],
        "connected": connected,
        "error": error or ("" if connected else _clean(value.get("error"), 500) or "Mail no devolvió Enviados"),
        "returned_count": returned if connected and isinstance(returned, int) and returned >= 0 else 0,
    }


def _overview_base(accounts: List[Dict[str, str]]) -> Dict[str, Any]:
    return {
        "connected": False,
        "email_address": accounts[0]["address"] if accounts else "",
        "checked_at": _now_ms(),
        "unread_count": 0,
        "draft_count": 0,
        "emails": [],
        "accounts": [],
        "warnings": [],
        "next_page_token": "",
        "sent_accounts": [],
        "sent_source": "Mail",
        "sent_source_count": 0,
        "sent_truncated": False,
        "inbox_truncated": False,
        "window_days": 0,
    }


def _failed_overview(accounts: List[Dict[str, str]], message: str) -> Dict[str, Any]:
    value = _overview_base(accounts)
    value["accounts"] = [_account_status(account, error=message) for account in accounts]
    value["sent_accounts"] = [_sent_status(account, error=message) for account in accounts]
    value["warnings"] = [f"Mail: {message}"]
    return value


def normalize_overview(raw: Dict[str, Any], accounts: List[Dict[str, str]]) -> Dict[str, Any]:
    by_key = {account["key"]: account for account in accounts}
    raw_accounts = {item.get("key"): item for item in raw.get("accounts", []) if isinstance(item, dict)}
    raw_sent = {item.get("key"): item for item in raw.get("sent_accounts", []) if isinstance(item, dict)}
    emails: Dict[str, Dict[str, Any]] = {}
    for item in raw.get("emails", []) if isinstance(raw.get("emails"), list) else []:
        message = _clean_message(item, by_key)
        if message is not None:
            emails[message["id"]] = message
    value = _overview_base(accounts)
    value["accounts"] = [_account_status(account, raw_accounts.get(account["key"])) for account in accounts]
    value["sent_accounts"] = [_sent_status(account, raw_sent.get(account["key"])) for account in accounts]
    value["emails"] = sorted(emails.values(), key=_message_timestamp, reverse=True)
    value["connected"] = any(account["connected"] for account in value["accounts"])
    value["unread_count"] = sum(account["unread_count"] for account in value["accounts"])
    value["warnings"] = [_clean(item, 500) for item in raw.get("warnings", []) if isinstance(item, str)][:20]
    for key in ("sent_source_count", "window_days"):
        if isinstance(raw.get(key), int) and raw[key] >= 0:
            value[key] = raw[key]
    value["sent_truncated"] = raw.get("sent_truncated") is True
    value["inbox_truncated"] = raw.get("inbox_truncated") is True
    return value


# --- Operaciones -----------------------------------------------------------


def overview(config: Dict[str, Any]) -> Dict[str, Any]:
    accounts = esprit_config.mail_accounts(config)
    try:
        raw = _run_apple_mail("overview", accounts)
    except BridgeError as error:
        return _failed_overview(accounts, str(error))
    return normalize_overview(raw, accounts)


def validate_thread_id(thread_id: str, accounts: List[Dict[str, str]]) -> str:
    match = THREAD_ID_RE.fullmatch(thread_id or "")
    if not match:
        raise BridgeError("El hilo solicitado no es válido")
    if match.group(1) not in {account["key"] for account in accounts}:
        raise BridgeError("La cuenta del hilo no está configurada")
    return thread_id


def read_thread(config: Dict[str, Any], thread_id: str) -> Dict[str, Any]:
    accounts = esprit_config.mail_accounts(config)
    validate_thread_id(thread_id, accounts)
    raw = _run_apple_mail("thread", accounts, argument=thread_id)
    by_key = {account["key"]: account for account in accounts}
    raw_messages = raw.get("messages") if isinstance(raw.get("messages"), list) else []
    messages = [message for message in (_clean_message(item, by_key) for item in raw_messages) if message is not None]
    if thread_id not in {message["id"] for message in messages}:
        raise BridgeError("Mail no devolvió el mensaje solicitado")
    # All messages of a conversation belong to the account that owns the thread.
    owner = thread_id.split("_")[1]
    messages = _deduplicate_messages([message for message in messages if message["mailbox"] == owner])
    folders = raw.get("source_thread_count")
    return {
        "thread_id": thread_id,
        "messages": messages,
        "message_count": len(messages),
        "truncated": raw.get("truncated") is True,
        "reconstructed": len(messages) > 1,
        "source_thread_count": folders if isinstance(folders, int) and 1 <= folders <= 2 else 1,
    }


def validate_send_request(request: Dict[str, Any], accounts: List[Dict[str, str]]) -> Dict[str, Any]:
    """Rebuilds the outgoing request from an allowlist; caller-supplied extras are discarded."""
    from_account = _text(request.get("from_account")).strip()
    if from_account not in {account["key"] for account in accounts}:
        raise BridgeError("La cuenta de envío no está configurada")
    to = _text(request.get("to")).strip()
    subject = _text(request.get("subject")).strip()
    body = _text(request.get("body")).strip()
    reply_id = _text(request.get("reply_message_id")).strip()
    if not to or "@" not in to or len(to) > 1000:
        raise BridgeError("El destinatario no es válido")
    if any(character in to + subject for character in "\r\n\x00"):
        raise BridgeError("Destinatario y asunto deben ocupar una sola línea")
    if not subject or len(subject) > 500:
        raise BridgeError("El asunto no es válido")
    if not body or len(body) > MAX_BODY_CHARS or "\x00" in body:
        raise BridgeError("El cuerpo del correo no es válido")
    parsed = getaddresses([to])
    if not parsed or len(parsed) > MAX_RECIPIENTS or any(not ADDRESS_RE.fullmatch(address) for _, address in parsed):
        raise BridgeError("Usa direcciones de correo válidas separadas por comas")
    if reply_id:
        match = THREAD_ID_RE.fullmatch(reply_id)
        if not match:
            raise BridgeError("El mensaje original no es válido")
        if match.group(1) != from_account:
            raise BridgeError("La respuesta debe salir desde la cuenta que recibió el mensaje")
    return {
        "from_account": from_account,
        "to": to,
        "to_addresses": [address for _, address in parsed],
        "subject": subject,
        "body": body,
        "reply_message_id": reply_id,
    }


def send(config: Dict[str, Any], request: Dict[str, Any]) -> Dict[str, Any]:
    accounts = esprit_config.mail_accounts(config)
    outgoing = validate_send_request(request, accounts)
    value = _run_apple_mail("send", accounts, request=outgoing)
    if value.get("sent") is not True:
        raise BridgeError("Mail no confirmó el envío. Comprueba Enviados y Salida antes de reintentar")
    return {"sent": True, "message_id": "", "thread_id": outgoing["reply_message_id"]}


def _load_request() -> Dict[str, Any]:
    raw = sys.stdin.buffer.read(512 * 1024 + 1)
    if len(raw) > 512 * 1024:
        raise BridgeError("La solicitud de correo supera el límite seguro")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BridgeError("La solicitud de correo no es válida") from error
    if not isinstance(value, dict):
        raise BridgeError("La solicitud de correo no es válida")
    return value


def main(argv: Optional[List[str]] = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    try:
        command = args[0] if args else ""
        if command not in ("overview", "thread", "send"):
            raise BridgeError("Operación de correo no reconocida")
        config = esprit_config.load_config()
        if command == "overview":
            value = overview(config)
        elif command == "thread":
            value = read_thread(config, args[1] if len(args) > 1 else "")
        else:
            value = send(config, _load_request())
        print(json.dumps(value, ensure_ascii=False))
        return 0
    except (BridgeError, esprit_config.ConfigError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 1
    except Exception:
        print(json.dumps({"error": "El correo devolvió un error inesperado"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
