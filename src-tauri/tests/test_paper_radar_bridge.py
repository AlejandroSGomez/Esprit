from __future__ import annotations

import datetime as dt
import io
import unittest
import urllib.parse
from contextlib import redirect_stderr
from unittest import mock

from esprit_fixtures import TempWorkspace, load_bridge

BRIDGE = load_bridge("paper_radar_bridge")
SETTINGS = {"arxiv_categories": ["quant-ph", "cond-mat.stat-mech"], "keywords": ["open quantum systems", "nonlinear dynamics"]}


ATOM = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>arXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/2608.12345v2</id>
    <updated>2026-08-22T12:00:00Z</updated>
    <published>2026-08-21T12:00:00Z</published>
    <title>  A   Toy   Model </title>
    <summary> We study a simple example. </summary>
    <author><name>A. Researcher</name></author>
    <category term="quant-ph" scheme="http://arxiv.org/schemas/atom" />
    <arxiv:primary_category term="quant-ph" />
    <link href="http://arxiv.org/abs/2608.12345v2" rel="alternate" type="text/html" />
    <link title="pdf" href="http://arxiv.org/pdf/2608.12345v2" rel="related" type="application/pdf" />
  </entry>
  <entry>
    <id>https://arxiv.org/abs/2608.12345v1</id>
    <updated>2026-08-21T12:00:00Z</updated>
    <published>2026-08-21T12:00:00Z</published>
    <title>Older version</title>
    <summary>Older abstract.</summary>
    <author><name>A. Researcher</name></author>
  </entry>
</feed>"""


class PaperRadarBridgeTests(unittest.TestCase):
    def test_query_is_one_bounded_recent_request(self):
        now = dt.datetime(2026, 8, 23, 10, tzinfo=dt.timezone.utc)
        url, start, end = BRIDGE.build_api_url(SETTINGS, now)
        self.assertTrue(url.startswith("https://export.arxiv.org/api/query?"))
        self.assertEqual(start, "202608020000")
        self.assertEqual(end, "202608232359")
        self.assertIn("max_results=100", url)
        self.assertIn("sortBy=submittedDate", url)

    def test_query_uses_only_the_configured_categories_and_keywords(self):
        now = dt.datetime(2026, 8, 23, 10, tzinfo=dt.timezone.utc)
        query, _, _ = BRIDGE.build_search_query(SETTINGS, now)
        self.assertEqual(
            query,
            '(cat:quant-ph OR cat:cond-mat.stat-mech) AND (all:"open quantum systems" OR all:"nonlinear dynamics") '
            "AND submittedDate:[202608020000 TO 202608232359]",
        )
        only_categories, _, _ = BRIDGE.build_search_query({"arxiv_categories": ["math.DS"], "keywords": []}, now)
        self.assertTrue(only_categories.startswith("(cat:math.DS) AND submittedDate:"))
        only_keywords, _, _ = BRIDGE.build_search_query({"arxiv_categories": [], "keywords": ['red "neuronal" (grafos)']}, now)
        self.assertTrue(only_keywords.startswith('(all:"red neuronal grafos") AND submittedDate:'))
        with self.assertRaises(BRIDGE.BridgeError):
            BRIDGE.build_search_query({"arxiv_categories": [], "keywords": []}, now)

    def test_refresh_reads_settings_from_the_config_and_respects_the_module_switch(self):
        with TempWorkspace() as fixture, mock.patch.object(BRIDGE, "_fetch", return_value=(ATOM, "application/atom+xml")) as fetch, \
                mock.patch("sys.argv", ["paper_radar_bridge.py", "refresh"]), mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(BRIDGE.main(), 0)
            url = fetch.call_args.args[0]
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["search_query"][0]
            self.assertIn('all:"open quantum systems"', query)
            self.assertIn("cat:cond-mat.stat-mech", query)
            config = fixture.copy()
            config["modules"]["paper_radar"]["enabled"] = False
            fixture.write(config)
            fetch.reset_mock()
            errors = io.StringIO()
            with redirect_stderr(errors):
                self.assertEqual(BRIDGE.main(), 2)
            fetch.assert_not_called()
            self.assertIn("no configurado", errors.getvalue())

    def test_atom_parser_collapses_text_and_deduplicates_versions(self):
        values = BRIDGE.parse_atom_feed(ATOM)
        self.assertEqual(len(values), 1)
        self.assertEqual(values[0]["source_id"], "arxiv:2608.12345")
        self.assertEqual(values[0]["version"], 2)
        self.assertEqual(values[0]["title"], "A Toy Model")
        self.assertEqual(values[0]["primary_category"], "quant-ph")
        self.assertEqual(values[0]["abstract_url"], "https://arxiv.org/abs/2608.12345v2")

    def test_coverage_reports_truncated_and_unknown_totals(self):
        payload = ATOM.replace(b'<title>arXiv Query</title>', b'<title>arXiv Query</title><opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">250</opensearch:totalResults>')
        self.assertEqual(BRIDGE.feed_coverage(payload, 1), {"source_total": 250, "truncated": True})
        self.assertEqual(BRIDGE.feed_coverage(ATOM, 1), {"source_total": None, "truncated": False})

    def test_coverage_rejects_impossible_total(self):
        payload = ATOM.replace(b'<title>arXiv Query</title>', b'<title>arXiv Query</title><opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">-1</opensearch:totalResults>')
        with self.assertRaises(BRIDGE.BridgeError):
            BRIDGE.feed_coverage(payload, 1)

    def test_atom_error_entry_is_not_a_success(self):
        payload = b'''<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Error</title><id>https://arxiv.org/abs/2608.00001</id><published>x</published><updated>x</updated><summary>x</summary></entry></feed>'''
        with self.assertRaises(BRIDGE.BridgeError):
            BRIDGE.parse_atom_feed(payload)

    def test_rejects_external_hosts_and_non_arxiv_paths(self):
        with self.assertRaises(BRIDGE.BridgeError):
            BRIDGE._validated_url("https://example.com/pdf/2608.12345", "pdf")
        with self.assertRaises(BRIDGE.BridgeError):
            BRIDGE._validated_url("https://arxiv.org/help", "pdf")

    def test_figure_parser_keeps_caption_and_resolves_only_html_assets(self):
        payload = b'''<html><body><figure><img src="2608.12345/x1.png" alt="phase portrait"><figcaption>Figure 1: Main phase diagram.</figcaption></figure></body></html>'''
        figures = BRIDGE.parse_figures(payload, "https://arxiv.org/html/2608.12345")
        self.assertEqual(len(figures), 1)
        self.assertEqual(figures[0]["caption"], "Figure 1: Main phase diagram.")
        self.assertEqual(figures[0]["url"], "https://arxiv.org/html/2608.12345/x1.png")

    def test_pdf_download_requires_matching_catalogue_id(self):
        with self.assertRaises(BRIDGE.BridgeError):
            BRIDGE.download_pdf(
                {
                    "source_id": "arxiv:2608.12345",
                    "pdf_url": "https://arxiv.org/pdf/2608.99999v1",
                }
            )

    def test_figure_recovery_bounds_failed_image_attempts(self):
        candidates = [
            {
                "candidate_index": index,
                "url": f"https://arxiv.org/html/2608.12345/x{index}.png",
                "caption": f"Figure {index}",
                "alt": "",
            }
            for index in range(20)
        ]
        with mock.patch.object(BRIDGE, "_fetch", return_value=(b"<html></html>", "text/html")), \
                mock.patch.object(BRIDGE, "parse_figures", return_value=candidates), \
                mock.patch.object(BRIDGE, "_image_payload", side_effect=BRIDGE.BridgeError("not raster")) as image_payload:
            result = BRIDGE.figures(
                {
                    "papers": [
                        {
                            "source_id": "arxiv:2608.12345",
                            "visual_hints": [],
                            "desired_figures": 1,
                        }
                    ]
                }
            )
        self.assertEqual(image_payload.call_count, BRIDGE.MAX_IMAGE_ATTEMPTS_PER_PAPER)
        self.assertEqual(result["papers"][0]["figures"], [])


if __name__ == "__main__":
    unittest.main()
