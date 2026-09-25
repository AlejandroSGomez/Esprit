#!/usr/bin/env python3
"""Deterministic, bounded arXiv adapter for Esprit's paper radar.

The bridge owns every remote URL and accepts only semantic actions.  It never
receives a search query, filesystem path, or arbitrary URL from React.  Rust
persists history and validates every model selection against this catalogue.
The arXiv categories and keywords come from ``modules.paper_radar`` in
Esprit's configuration (``ESPRIT_CONFIG``).
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import esprit_config  # noqa: E402


API_ENDPOINT = "https://export.arxiv.org/api/query"
USER_AGENT = "Esprit/1.0 (research paper radar)"
API_TIMEOUT_SECONDS = 24
ASSET_TIMEOUT_SECONDS = 8
FIGURE_BATCH_DEADLINE_SECONDS = 30
MAX_IMAGE_ATTEMPTS_PER_PAPER = 4
MAX_FEED_BYTES = 8 * 1_048_576
MAX_HTML_BYTES = 5 * 1_048_576
MAX_IMAGE_BYTES = 2 * 1_048_576
MAX_PDF_BYTES = 48 * 1_048_576
MAX_RESULTS = 100
RECENT_DAYS = 21
MAX_FIGURES_PER_PAPER = 2

ATOM_NS = "http://www.w3.org/2005/Atom"
ARXIV_NS = "http://arxiv.org/schemas/atom"
ARXIV_CATEGORY_SCHEME = "http://arxiv.org/schemas/atom"
OPENSEARCH_NS = "http://a9.com/-/spec/opensearch/1.1/"

SOURCE_ID_RE = re.compile(r"arxiv:([0-9]{4}\.[0-9]{4,5})\Z")
ARXIV_ID_RE = re.compile(r"(?:abs|pdf)/([0-9]{4}\.[0-9]{4,5})(?:v([0-9]+))?(?:\.pdf)?\Z")


class BridgeError(RuntimeError):
    pass


def _collapse(value: str) -> str:
    return " ".join(html.unescape(value or "").split())


def _read_limited(response: Any, limit: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = response.read(min(65_536, limit + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > limit:
            raise BridgeError("La respuesta remota supera el límite seguro")
    return b"".join(chunks)


def _validated_url(url: str, kind: str) -> str:
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError as error:
        raise BridgeError("arXiv devolvió un enlace no válido") from error
    host = (parts.hostname or "").lower()
    if parts.scheme not in {"http", "https"} or parts.username or parts.password or parts.port:
        raise BridgeError("arXiv devolvió un enlace no permitido")
    if host not in {"arxiv.org", "export.arxiv.org"}:
        raise BridgeError("arXiv devolvió un host no permitido")
    path = parts.path
    if kind == "api" and not (host == "export.arxiv.org" and path == "/api/query"):
        raise BridgeError("Endpoint arXiv no permitido")
    if kind == "abs" and not re.fullmatch(r"/abs/[0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?", path):
        raise BridgeError("Enlace abstract arXiv no permitido")
    if kind == "pdf" and not re.fullmatch(r"/pdf/[0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?(?:\.pdf)?", path):
        raise BridgeError("Enlace PDF arXiv no permitido")
    if kind == "html" and not re.fullmatch(r"/html/[0-9]{4}\.[0-9]{4,5}", path):
        raise BridgeError("Enlace HTML arXiv no permitido")
    if kind == "image" and not path.startswith("/html/"):
        raise BridgeError("Imagen arXiv no permitida")
    return urllib.parse.urlunsplit(("https", host, path, parts.query, ""))


class _SafeRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, kind: str):
        super().__init__()
        self.kind = kind

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return super().redirect_request(
            req, fp, code, msg, headers, _validated_url(newurl, self.kind)
        )


def _fetch(url: str, *, kind: str, limit: int, timeout: float, accept: str) -> tuple[bytes, str]:
    safe_url = _validated_url(url, kind)
    request = urllib.request.Request(
        safe_url,
        headers={"User-Agent": USER_AGENT, "Accept": accept},
        method="GET",
    )
    opener = urllib.request.build_opener(_SafeRedirect(kind))
    try:
        with opener.open(request, timeout=timeout) as response:
            final_url = _validated_url(response.geturl(), kind)
            if final_url != _validated_url(final_url, kind):
                raise BridgeError("Redirección arXiv no permitida")
            return _read_limited(response, limit), response.headers.get("Content-Type", "")
    except BridgeError:
        raise
    except (OSError, urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as error:
        raise BridgeError("No se pudo leer arXiv en este momento") from error


def _query_phrase(value: str) -> str:
    """One arXiv phrase: printable text without quotes, backslashes or brackets."""
    cleaned = re.sub(r'[\x00-\x1f\x7f"\\()\[\]{}]+', " ", value)
    return " ".join(cleaned.split())[:80]


def build_search_query(
    settings: Dict[str, List[str]], now: Optional[dt.datetime] = None
) -> tuple[str, str, str]:
    current = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)
    start = current - dt.timedelta(days=RECENT_DAYS)
    categories = [
        value for value in settings.get("arxiv_categories", []) if esprit_config.ARXIV_CATEGORY_RE.fullmatch(value)
    ]
    phrases = [phrase for phrase in (_query_phrase(value) for value in settings.get("keywords", [])) if len(phrase) >= 2]
    if not categories and not phrases:
        raise BridgeError("El radar necesita al menos una categoría de arXiv o una palabra clave")
    start_text = start.strftime("%Y%m%d0000")
    end_text = current.strftime("%Y%m%d2359")
    clauses = []
    if categories:
        clauses.append("(" + " OR ".join(f"cat:{value}" for value in categories) + ")")
    if phrases:
        clauses.append("(" + " OR ".join(f'all:"{value}"' for value in phrases) + ")")
    clauses.append(f"submittedDate:[{start_text} TO {end_text}]")
    return " AND ".join(clauses), start_text, end_text


def build_api_url(
    settings: Dict[str, List[str]], now: Optional[dt.datetime] = None
) -> tuple[str, str, str]:
    query, start_text, end_text = build_search_query(settings, now)
    params = urllib.parse.urlencode(
        {
            "search_query": query,
            "start": "0",
            "max_results": str(MAX_RESULTS),
            "sortBy": "submittedDate",
            "sortOrder": "descending",
        }
    )
    return f"{API_ENDPOINT}?{params}", start_text, end_text


def _entry_text(entry: ET.Element, name: str) -> str:
    element = entry.find(f"{{{ATOM_NS}}}{name}")
    return _collapse(element.text if element is not None and element.text else "")


def _canonical_arxiv_id(value: str) -> tuple[str, int]:
    try:
        path = urllib.parse.urlsplit(value).path.lstrip("/")
    except ValueError as error:
        raise BridgeError("Identificador arXiv no válido") from error
    match = ARXIV_ID_RE.fullmatch(path)
    if not match:
        raise BridgeError("Identificador arXiv no válido")
    return match.group(1), int(match.group(2) or "1")


def parse_atom_feed(payload: bytes) -> list[dict[str, Any]]:
    if len(payload) > MAX_FEED_BYTES:
        raise BridgeError("El feed arXiv supera el límite seguro")
    upper_prefix = payload[:4096].upper()
    if b"<!DOCTYPE" in upper_prefix or b"<!ENTITY" in upper_prefix:
        raise BridgeError("El feed arXiv contiene declaraciones XML no permitidas")
    try:
        root = ET.fromstring(payload)
    except ET.ParseError as error:
        raise BridgeError("arXiv devolvió un feed Atom no válido") from error
    if root.tag != f"{{{ATOM_NS}}}feed":
        raise BridgeError("arXiv no devolvió un feed Atom")

    entries = root.findall(f"{{{ATOM_NS}}}entry")
    if len(entries) == 1 and _entry_text(entries[0], "title").lower() == "error":
        raise BridgeError("arXiv rechazó la consulta del radar")
    if len(entries) > MAX_RESULTS:
        raise BridgeError("arXiv devolvió demasiados resultados")

    deduped: dict[str, dict[str, Any]] = {}
    for entry in entries:
        raw_id = _entry_text(entry, "id")
        base_id, version = _canonical_arxiv_id(raw_id)
        title = _entry_text(entry, "title")
        summary = _entry_text(entry, "summary")
        published = _entry_text(entry, "published")
        updated = _entry_text(entry, "updated")
        if not title or not summary or not published or not updated:
            continue
        authors = [
            _collapse(name.text or "")
            for author in entry.findall(f"{{{ATOM_NS}}}author")
            for name in [author.find(f"{{{ATOM_NS}}}name")]
            if name is not None and _collapse(name.text or "")
        ][:40]

        abstract_url = _validated_url(f"https://arxiv.org/abs/{base_id}v{version}", "abs")
        pdf_url = _validated_url(f"https://arxiv.org/pdf/{base_id}v{version}", "pdf")
        for link in entry.findall(f"{{{ATOM_NS}}}link"):
            href = link.attrib.get("href", "")
            relation = link.attrib.get("rel", "")
            link_type = link.attrib.get("type", "")
            try:
                if relation == "alternate":
                    abstract_url = _validated_url(href, "abs")
                elif relation == "related" and link_type == "application/pdf":
                    pdf_url = _validated_url(href, "pdf")
            except BridgeError:
                continue

        categories = []
        for category in entry.findall(f"{{{ATOM_NS}}}category"):
            if category.attrib.get("scheme") not in {None, "", ARXIV_CATEGORY_SCHEME}:
                continue
            term = _collapse(category.attrib.get("term", ""))
            if term and term not in categories:
                categories.append(term)
        primary_element = entry.find(f"{{{ARXIV_NS}}}primary_category")
        primary = _collapse(primary_element.attrib.get("term", "")) if primary_element is not None else ""
        comment_element = entry.find(f"{{{ARXIV_NS}}}comment")
        doi_element = entry.find(f"{{{ARXIV_NS}}}doi")
        candidate = {
            "source_id": f"arxiv:{base_id}",
            "base_id": base_id,
            "version": version,
            "title": title[:600],
            "summary": summary[:12_000],
            "authors": authors,
            "published": published,
            "updated": updated,
            "primary_category": primary,
            "categories": categories[:12],
            "comment": _collapse(comment_element.text or "")[:1000] if comment_element is not None else "",
            "doi": _collapse(doi_element.text or "")[:300] if doi_element is not None else "",
            "abstract_url": abstract_url,
            "pdf_url": pdf_url,
        }
        previous = deduped.get(base_id)
        if previous is None or version > int(previous["version"]):
            deduped[base_id] = candidate

    return sorted(deduped.values(), key=lambda value: value["published"], reverse=True)


def feed_coverage(payload: bytes, recovered: int) -> dict[str, Any]:
    # parse_atom_feed has already rejected malformed/unsafe XML. arXiv's total
    # counts raw entries, while recovered counts unique valid base IDs.
    root = ET.fromstring(payload)
    total_text = root.findtext(f"{{{OPENSEARCH_NS}}}totalResults")
    total = None
    if total_text is not None:
        try:
            total = int(total_text.strip())
        except ValueError as error:
            raise BridgeError("arXiv devolvió una cobertura no válida") from error
        if total < recovered or total > 100_000_000:
            raise BridgeError("arXiv devolvió una cobertura no válida")
    raw_count = len(root.findall(f"{{{ATOM_NS}}}entry"))
    return {"source_total": total, "truncated": total > raw_count if total is not None else raw_count >= MAX_RESULTS}


def refresh(settings: Dict[str, List[str]], now: Optional[dt.datetime] = None) -> dict[str, Any]:
    url, start_text, end_text = build_api_url(settings, now)
    payload, _ = _fetch(
        url,
        kind="api",
        limit=MAX_FEED_BYTES,
        timeout=API_TIMEOUT_SECONDS,
        accept="application/atom+xml, application/xml;q=0.9",
    )
    candidates = parse_atom_feed(payload)
    return {
        **feed_coverage(payload, len(candidates)),
        "source": "arxiv",
        "window_start": start_text,
        "window_end": end_text,
        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "candidates": candidates,
        "acknowledgement": "Thank you to arXiv for use of its open access interoperability.",
    }


class FigureParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._figure_depth = 0
        self._caption_depth = 0
        self._current: dict[str, Any] | None = None
        self.figures: list[dict[str, Any]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key: value or "" for key, value in attrs}
        if tag == "figure":
            if self._figure_depth == 0:
                self._current = {"images": [], "caption": []}
            self._figure_depth += 1
        elif self._figure_depth and tag == "figcaption":
            self._caption_depth += 1
        elif self._figure_depth and tag == "img" and self._current is not None:
            source = values.get("src", "")
            if source:
                self._current["images"].append(
                    {"src": source, "alt": _collapse(values.get("alt", ""))[:700]}
                )

    def handle_endtag(self, tag: str) -> None:
        if tag == "figcaption" and self._caption_depth:
            self._caption_depth -= 1
        elif tag == "figure" and self._figure_depth:
            self._figure_depth -= 1
            if self._figure_depth == 0 and self._current is not None:
                if self._current["images"]:
                    self._current["caption"] = _collapse(" ".join(self._current["caption"]))[:1800]
                    self.figures.append(self._current)
                self._current = None

    def handle_data(self, data: str) -> None:
        if self._caption_depth and self._current is not None:
            self._current["caption"].append(data)


def parse_figures(payload: bytes, base_url: str) -> list[dict[str, Any]]:
    if len(payload) > MAX_HTML_BYTES:
        raise BridgeError("La vista HTML de arXiv supera el límite seguro")
    try:
        text = payload.decode("utf-8", "replace")
    except UnicodeDecodeError as error:
        raise BridgeError("La vista HTML de arXiv no es legible") from error
    parser = FigureParser()
    parser.feed(text)
    values: list[dict[str, Any]] = []
    for index, figure in enumerate(parser.figures[:80]):
        first = figure["images"][0]
        url = urllib.parse.urljoin(base_url, first["src"])
        try:
            url = _validated_url(url, "image")
        except BridgeError:
            continue
        values.append(
            {
                "candidate_index": index,
                "url": url,
                "caption": figure["caption"],
                "alt": first["alt"],
            }
        )
    return values


def _figure_score(figure: dict[str, Any], hints: list[str]) -> int:
    haystack = f"{figure.get('caption', '')} {figure.get('alt', '')}".lower()
    tokens = {token for hint in hints for token in re.findall(r"[a-záéíóúüñ0-9]{4,}", hint.lower())}
    score = sum(4 for token in tokens if token in haystack)
    for marker in ("schematic", "overview", "phase diagram", "main result", "concept"):
        if marker in haystack:
            score += 3
    score += max(0, 8 - int(figure.get("candidate_index", 0)))
    return score


def _image_payload(url: str, timeout: float) -> tuple[str, str]:
    payload, content_type = _fetch(
        url,
        kind="image",
        limit=MAX_IMAGE_BYTES,
        timeout=timeout,
        accept="image/png, image/jpeg, image/webp",
    )
    declared = content_type.split(";", 1)[0].strip().lower()
    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        mime = "image/png"
    elif payload.startswith(b"\xff\xd8\xff"):
        mime = "image/jpeg"
    elif payload.startswith(b"RIFF") and payload[8:12] == b"WEBP":
        mime = "image/webp"
    else:
        raise BridgeError("arXiv no devolvió una imagen raster segura")
    if declared and declared not in {mime, "application/octet-stream"}:
        raise BridgeError("El tipo declarado de la figura no coincide")
    return mime, base64.b64encode(payload).decode("ascii")


def figures(request: dict[str, Any]) -> dict[str, Any]:
    papers = request.get("papers")
    if not isinstance(papers, list) or len(papers) > 4:
        raise BridgeError("Solicitud de figuras no válida")
    results = []
    deadline = time.monotonic() + FIGURE_BATCH_DEADLINE_SECONDS
    for paper_index, paper in enumerate(papers):
        if not isinstance(paper, dict):
            raise BridgeError("Solicitud de figuras no válida")
        source_id = paper.get("source_id")
        match = SOURCE_ID_RE.fullmatch(source_id if isinstance(source_id, str) else "")
        hints = paper.get("visual_hints")
        desired = paper.get("desired_figures", 1)
        if not match or not isinstance(hints, list) or not all(isinstance(value, str) for value in hints):
            raise BridgeError("Solicitud de figuras no válida")
        if not isinstance(desired, int) or desired < 1 or desired > MAX_FIGURES_PER_PAPER:
            raise BridgeError("Número de figuras no válido")
        html_url = _validated_url(f"https://arxiv.org/html/{match.group(1)}", "html")
        paper_result: dict[str, Any] = {"source_id": source_id, "figures": [], "warning": ""}
        if time.monotonic() >= deadline:
            paper_result["warning"] = "Se agotó el tiempo acotado para recuperar figuras de esta tanda."
            results.append(paper_result)
            continue
        try:
            if paper_index:
                time.sleep(min(0.35, max(0.0, deadline - time.monotonic())))
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise BridgeError("Tiempo de figuras agotado")
            payload, _ = _fetch(
                html_url,
                kind="html",
                limit=MAX_HTML_BYTES,
                timeout=max(0.5, min(ASSET_TIMEOUT_SECONDS, remaining)),
                accept="text/html, application/xhtml+xml",
            )
            candidates = sorted(
                parse_figures(payload, html_url),
                key=lambda value: _figure_score(value, hints),
                reverse=True,
            )
            for candidate in candidates[:MAX_IMAGE_ATTEMPTS_PER_PAPER]:
                if len(paper_result["figures"]) >= desired:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    mime, data = _image_payload(
                        candidate["url"],
                        max(0.5, min(ASSET_TIMEOUT_SECONDS, remaining)),
                    )
                except BridgeError:
                    continue
                paper_result["figures"].append(
                    {
                        "caption": candidate["caption"] or candidate["alt"] or "Figura del artículo",
                        "mime_type": mime,
                        "data_base64": data,
                    }
                )
            if not paper_result["figures"]:
                paper_result["warning"] = (
                    "Se agotó el tiempo acotado para recuperar figuras de esta tanda."
                    if time.monotonic() >= deadline
                    else "Este paper no ofrece una figura raster recuperable en su HTML de arXiv."
                )
        except BridgeError:
            paper_result["warning"] = "La vista HTML o sus figuras no están disponibles en arXiv."
        results.append(paper_result)
    return {"papers": results}


def download_pdf(request: dict[str, Any]) -> bytes:
    source_id = request.get("source_id")
    pdf_url = request.get("pdf_url")
    match = SOURCE_ID_RE.fullmatch(source_id if isinstance(source_id, str) else "")
    if not match or not isinstance(pdf_url, str):
        raise BridgeError("Solicitud de PDF no válida")
    safe_url = _validated_url(pdf_url, "pdf")
    base_id, _ = _canonical_arxiv_id(safe_url)
    if base_id != match.group(1):
        raise BridgeError("El PDF no corresponde al paper seleccionado")
    payload, content_type = _fetch(
        safe_url,
        kind="pdf",
        limit=MAX_PDF_BYTES,
        timeout=API_TIMEOUT_SECONDS,
        accept="application/pdf",
    )
    if not payload.startswith(b"%PDF-"):
        raise BridgeError("arXiv no devolvió un PDF válido")
    declared = content_type.split(";", 1)[0].strip().lower()
    if declared and declared not in {"application/pdf", "application/octet-stream"}:
        raise BridgeError("arXiv declaró un tipo de archivo inesperado")
    return payload


def _stdin_object() -> dict[str, Any]:
    payload = sys.stdin.buffer.read(256 * 1024 + 1)
    if len(payload) > 256 * 1024:
        raise BridgeError("La solicitud supera el límite seguro")
    try:
        value = json.loads(payload or b"{}")
    except json.JSONDecodeError as error:
        raise BridgeError("La solicitud JSON no es válida") from error
    if not isinstance(value, dict):
        raise BridgeError("La solicitud JSON no es válida")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("action", choices=("refresh", "figures", "download_pdf"))
    args = parser.parse_args()
    try:
        config = esprit_config.load_config()
        settings = esprit_config.paper_radar_settings(config)
        if args.action == "refresh":
            result = refresh(settings)
            sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        elif args.action == "figures":
            result = figures(_stdin_object())
            sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        else:
            sys.stdout.buffer.write(download_pdf(_stdin_object()))
        return 0
    except (BridgeError, esprit_config.ConfigError) as error:
        sys.stderr.write(str(error))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
