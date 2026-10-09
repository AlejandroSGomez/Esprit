"""Resources are metadata reads; fetching bytes requires an explicit download."""
import unittest
from unittest.mock import patch
from esprit_fixtures import load_bridge
B = load_bridge("mattermost_bridge")
class ResourcesTests(unittest.TestCase):
    def test_links_reject_credentials_and_trim_punctuation(self):
        self.assertEqual(B.post_links("https://example.org/a). https://user:secret@example.org/private https://example.org/a"), ["https://example.org/a"])
    def test_download_refuses_incomplete_bytes(self):
        with patch.object(B,"attachment_metadata",return_value={"size":8,"id":"fileone"}), patch.object(B,"download_attachment_bytes",return_value=b"short"):
            with self.assertRaisesRegex(RuntimeError,"incompleta"):
                B.attachment_download(None,{},"fileone")
    def test_empty_resources_does_not_download_attachments(self):
        class Client:
            def get(self,path):
                assert path.startswith("/channels/channelone/posts?")
                return {"order":[],"posts":{}}
        with patch.object(B,"configured_channel"), patch.object(B,"download_attachment_bytes") as download:
            result=B.channel_resources(Client(),{},"channelone",None)
            self.assertEqual(result["posts"],[])
            self.assertIsNone(result["next_cursor"])
            download.assert_not_called()
