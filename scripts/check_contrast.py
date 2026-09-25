#!/usr/bin/env python3
"""Esprit · contraste WCAG de las paletas de app/globals.css (solo lectura).

Uso:
  python3 scripts/check_contrast.py                 lista las paletas disponibles
  python3 scripts/check_contrast.py tinta           comprueba una paleta (claro y oscuro)
  python3 scripts/check_contrast.py --all           comprueba todas
  python3 scripts/check_contrast.py --all --html /tmp/paletas.html
                                                    además escribe una vista previa en HTML
  python3 scripts/check_contrast.py tinta --json    resultado en JSON

Cómo se leen los tokens (igual que la cascada CSS de Esprit):
  claro  = :root + .app-shell[data-palette='<id>']
  oscuro = :root + .app-shell[data-theme='dark'] + .app-shell[data-palette='<id>']
           + .app-shell[data-palette='<id>'][data-theme='dark']
La paleta base (la que no tiene bloque propio) usa solo :root y el bloque oscuro
genérico. Solo biblioteca estándar; no modifica ningún archivo salvo --html.
Sale con 1 si algún par obligatorio no llega al mínimo.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_CSS = REPO / "app" / "globals.css"
DEFAULT_TSX = REPO / "app" / "components" / "SettingsSpace.tsx"

# (etiqueta, primer plano, fondo, mínimo). Los nombres de token son históricos:
# --olive es el acento principal, --aubergine el acento cálido, --white la
# superficie elevada (documentos, paneles) y --paper el lienzo.
PAIRS = [
    ("Texto sobre el lienzo", "--ink", "--paper", 4.5),
    ("Texto sobre superficie", "--ink", "--white", 4.5),
    ("Texto sobre superficie suave", "--ink", "--surface-soft", 4.5),
    ("Texto secundario sobre lienzo", "--muted", "--paper", 4.5),
    ("Texto secundario sobre superficie", "--muted", "--white", 4.5),
    ("Acento principal sobre superficie", "--olive", "--white", 4.5),
    ("Acento principal sobre lienzo", "--olive", "--paper", 4.5),
    ("Acento cálido (marcas, texto grande)", "--aubergine", "--white", 3.0),
    ("Aviso", "--warning-text", "--warning-bg", 4.5),
    ("Error", "--danger-text", "--danger-bg", 4.5),
    ("Texto de la barra lateral", "sidebar-text", "--sidebar", 4.5),
    ("Marca activa en la barra lateral", "--sage", "--sidebar", 3.0),
]
SYNTAX_MIN = 4.5

HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def strip_comments(css: str) -> str:
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def normalize_selector(selector: str) -> str:
    selector = selector.strip().replace('"', "'")
    return re.sub(r"\s+", " ", selector)


def parse_blocks(css: str):
    """Bloques planos `selector { declaraciones }` en orden de aparición."""
    blocks = []
    for match in re.finditer(r"([^{}]+)\{([^{}]*)\}", strip_comments(css)):
        # Lo que precede al selector puede ser una sentencia @import ...; suelta.
        head = re.split(r"[;}]", match.group(1))[-1]
        selectors = [normalize_selector(s) for s in head.split(",")]
        decls = {}
        for name, value in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", match.group(2)):
            decls[name] = value.strip()
        blocks.append((selectors, decls, match.group(2)))
    return blocks


def specificity(selector: str) -> int:
    return selector.count(".") + selector.count("[") + selector.count(":")


def palette_selector(pid: str) -> str:
    return f".app-shell[data-palette='{pid}']"


def css_palettes(blocks) -> list[str]:
    found = []
    for selectors, _, _ in blocks:
        for sel in selectors:
            m = re.fullmatch(r"\.app-shell\[data-palette='([a-z0-9-]+)'\](\[data-theme='dark'\])?", sel)
            if m and m.group(1) not in found:
                found.append(m.group(1))
    return found


def tsx_palettes(path: Path) -> list[tuple[str, str]]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    # Solo el array appearancePalettes: el archivo tiene otras listas con id/label.
    start = text.find("appearancePalettes")
    start = text.find("= [", start) if start >= 0 else -1
    end = text.find("];", start) if start >= 0 else -1
    if start < 0 or end < 0:
        return []
    return re.findall(r"id:\s*'([a-z0-9-]+)',\s*label:\s*'([^']+)'", text[start:end])


def sidebar_text_color(blocks) -> str | None:
    for selectors, _, raw in blocks:
        if ".sidebar" in selectors:
            m = re.search(r"(?<![\w-])color\s*:\s*(#[0-9a-fA-F]{3,6})\b", raw)
            if m:
                return m.group(1)
    return None


def tokens_for(blocks, pid: str, theme: str, has_block: bool) -> dict[str, str]:
    wanted = {":root"}
    if theme == "dark":
        wanted.add(".app-shell[data-theme='dark']")
    if has_block:
        wanted.add(palette_selector(pid))
        if theme == "dark":
            wanted.add(palette_selector(pid) + "[data-theme='dark']")
    applicable = []
    for position, (selectors, decls, _) in enumerate(blocks):
        for sel in selectors:
            if sel in wanted and decls:
                applicable.append((specificity(sel), position, decls))
    tokens: dict[str, str] = {}
    for _, _, decls in sorted(applicable, key=lambda item: (item[0], item[1])):
        tokens.update(decls)
    return tokens


def resolve(tokens: dict[str, str], name: str, depth: int = 0) -> str | None:
    value = tokens.get(name)
    if value is None or depth > 8:
        return None
    m = re.fullmatch(r"var\((--[\w-]+)\)", value)
    if m:
        return resolve(tokens, m.group(1), depth + 1)
    return value if HEX_RE.match(value) else None


def luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    channels = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        channels.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    r, g, b = channels
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(fg: str, bg: str) -> float:
    a, b = luminance(fg), luminance(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def check(blocks, pid: str, has_block: bool, sidebar_text: str | None):
    report = {}
    for theme in ("light", "dark"):
        tokens = tokens_for(blocks, pid, theme, has_block)
        rows = []
        for label, fg_name, bg_name, minimum in PAIRS:
            fg = sidebar_text if fg_name == "sidebar-text" else resolve(tokens, fg_name)
            bg = resolve(tokens, bg_name)
            if not fg or not bg:
                rows.append({"pair": label, "fg": fg_name, "bg": bg_name, "ratio": None,
                             "min": minimum, "ok": None})
                continue
            ratio = contrast(fg, bg)
            rows.append({"pair": label, "fg": f"{fg_name} {fg}", "bg": f"{bg_name} {bg}",
                         "ratio": round(ratio, 2), "min": minimum, "ok": ratio >= minimum})
        surface = resolve(tokens, "--white")
        for name in sorted(n for n in tokens if n.startswith("--syntax-")):
            fg = resolve(tokens, name)
            if fg and surface:
                ratio = contrast(fg, surface)
                rows.append({"pair": f"Sintaxis {name[9:]}", "fg": f"{name} {fg}",
                             "bg": f"--white {surface}", "ratio": round(ratio, 2),
                             "min": SYNTAX_MIN, "ok": ratio >= SYNTAX_MIN})
        report[theme] = {"tokens": {k: v for k, v in tokens.items() if HEX_RE.match(v)}, "pairs": rows}
    return report


def print_report(pid: str, label: str, report) -> None:
    print(f"\n{label} ({pid})")
    for theme, title in (("light", "Claro"), ("dark", "Oscuro")):
        print(f"  {title}")
        for row in report[theme]["pairs"]:
            if row["ratio"] is None:
                print(f"    ?     {row['pair']}: falta {row['fg']} o {row['bg']}")
                continue
            mark = "OK   " if row["ok"] else "FALLA"
            print(f"    {mark} {row['ratio']:5.2f} ≥ {row['min']:<3}  {row['pair']}  ({row['fg']} sobre {row['bg']})")


def swatch_html(tokens: dict[str, str], sidebar_text: str | None) -> str:
    t = lambda n, d="#888888": tokens.get(n, d)  # noqa: E731
    return f"""
<div class="demo" style="background:{t('--paper')};color:{t('--ink')}">
  <aside style="background:{t('--sidebar')};color:{sidebar_text or '#f7f2f6'}">
    <b>Esprit</b><span style="border-left:3px solid {t('--sage')}">Inicio</span><span>Proyectos</span><span>Calendario</span>
  </aside>
  <main>
    <h3 style="color:{t('--ink')}">Foco del día</h3>
    <p style="color:{t('--muted')}">Texto secundario y metadatos</p>
    <div class="card" style="background:{t('--white')};border:1px solid {t('--line')}">
      <span style="color:{t('--olive')}">Acento principal</span> ·
      <span style="color:{t('--aubergine')}">Acento cálido</span>
      <div class="pill" style="background:{t('--warning-bg')};color:{t('--warning-text')}">Aviso</div>
      <div class="pill" style="background:{t('--danger-bg')};color:{t('--danger-text')}">Error</div>
    </div>
  </main>
</div>"""


def write_html(path: Path, results, sidebar_text: str | None) -> None:
    sections = []
    for pid, label, report in results:
        cells = []
        for theme, title in (("light", "Claro"), ("dark", "Oscuro")):
            tokens = report[theme]["tokens"]
            fails = [r for r in report[theme]["pairs"] if r["ok"] is False]
            status = "Contraste correcto" if not fails else f"{len(fails)} pares por debajo del mínimo"
            chips = "".join(
                f'<span class="chip"><i style="background:{v}"></i>{html.escape(k)} {v}</span>'
                for k, v in tokens.items() if not k.startswith("--syntax-"))
            cells.append(f"<div><h4>{title} · {status}</h4>{swatch_html(tokens, sidebar_text)}"
                         f'<details><summary>Tokens</summary>{chips}</details></div>')
        sections.append(f"<section><h2>{html.escape(label)} <code>{pid}</code></h2>"
                        f"<div class=\"pair\">{''.join(cells)}</div></section>")
    page = f"""<!doctype html><html lang="es"><meta charset="utf-8"><title>Paletas de Esprit</title>
<style>
body{{font-family:-apple-system,'Avenir Next',sans-serif;margin:24px;background:#f5f5f3;color:#222}}
h2{{font-family:'Iowan Old Style',serif;font-weight:500}} section{{margin-bottom:36px}}
.pair{{display:grid;grid-template-columns:1fr 1fr;gap:18px}} h4{{margin:6px 0;font-weight:500}}
.demo{{display:flex;height:190px;border-radius:14px;overflow:hidden;border:1px solid #0002}}
.demo aside{{width:130px;padding:14px;display:flex;flex-direction:column;gap:8px;font-size:13px}}
.demo aside span{{padding-left:8px;border-left:3px solid transparent}}
.demo main{{flex:1;padding:14px 18px}} .demo h3{{margin:0 0 4px;font-family:'Iowan Old Style',serif}}
.demo p{{margin:0 0 10px;font-size:13px}} .card{{padding:10px 12px;border-radius:9px;font-size:14px}}
.pill{{display:inline-block;margin:8px 6px 0 0;padding:3px 9px;border-radius:6px;font-size:12px}}
.chip{{display:inline-flex;align-items:center;gap:6px;margin:4px 10px 0 0;font:12px ui-monospace,monospace}}
.chip i{{width:14px;height:14px;border-radius:3px;border:1px solid #0003;display:inline-block}}
</style><h1>Paletas de Esprit</h1>{''.join(sections)}</html>"""
    path.write_text(page, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Contraste WCAG de las paletas de Esprit.")
    parser.add_argument("palette", nargs="?", help="id de la paleta (p. ej. tinta)")
    parser.add_argument("--all", action="store_true", help="comprueba todas las paletas")
    parser.add_argument("--css", type=Path, default=DEFAULT_CSS)
    parser.add_argument("--tsx", type=Path, default=DEFAULT_TSX)
    parser.add_argument("--html", type=Path, help="escribe una vista previa HTML en esta ruta")
    parser.add_argument("--json", action="store_true", help="salida en JSON")
    args = parser.parse_args()

    try:
        blocks = parse_blocks(args.css.read_text(encoding="utf-8"))
    except OSError as error:
        print(f"No se pudo leer {args.css}: {error}", file=sys.stderr)
        return 2

    with_blocks = css_palettes(blocks)
    labels = dict(tsx_palettes(args.tsx))
    ordered = list(labels) or []
    for pid in with_blocks:
        if pid not in ordered:
            ordered.append(pid)
    base = [pid for pid in ordered if pid not in with_blocks]
    if not labels:
        ordered.insert(0, "base")
        base = ["base"]

    if not args.palette and not args.all:
        print("Paletas disponibles:")
        for pid in ordered:
            note = " (paleta base: tokens de :root)" if pid in base else ""
            print(f"  {pid:<12} {labels.get(pid, '')}{note}")
        print("\nUso: check_contrast.py <id> | --all [--html archivo.html] [--json]")
        return 0

    targets = ordered if args.all else [args.palette]
    unknown = [pid for pid in targets if pid not in ordered]
    if unknown:
        print(f"Paleta desconocida: {', '.join(unknown)}. Disponibles: {', '.join(ordered)}", file=sys.stderr)
        return 2

    sidebar_text = sidebar_text_color(blocks)
    results = []
    failed = False
    for pid in targets:
        report = check(blocks, pid, pid in with_blocks, sidebar_text)
        results.append((pid, labels.get(pid, pid), report))
        for theme in report.values():
            failed = failed or any(row["ok"] is False for row in theme["pairs"])

    if args.json:
        print(json.dumps({"ok": not failed, "palettes": {pid: {"label": label, **report}
                                                         for pid, label, report in results}},
                         ensure_ascii=False, indent=2))
    else:
        for pid, label, report in results:
            print_report(pid, label, report)
        print("\nResultado:", "todo correcto." if not failed else "hay pares por debajo del mínimo WCAG.")
    if args.html:
        write_html(args.html, results, sidebar_text)
        if not args.json:
            print(f"Vista previa: {args.html}  (ábrela con: open '{args.html}')")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
