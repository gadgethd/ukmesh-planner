"""Ledger integrity tests (no service/model dependency)."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ledger  # noqa: E402

REQ = {"candidate": {"lat": 54.97, "lon": -1.61, "antenna_height_m": 10, "role": 2},
       "repeaters": [{"id": "A", "lat": 54.9, "lon": -1.7}], "top_k": 5}
RES = {"model": {"artifact_sha256": "abc"}, "ranking": [{"repeater_id": "A", "rank": 1, "score": 0.9}],
       "warnings": []}


class TestLedger(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "ledger.jsonl"

    def tearDown(self):
        self.tmp.cleanup()

    def test_empty_verify(self):
        self.assertEqual(ledger.verify(self.path), {"ok": True, "records": 0, "head": "0" * 64})

    def test_append_and_chain(self):
        a = ledger.append(self.path, REQ, RES, "NE", "first")
        b = ledger.append(self.path, REQ, RES, "NE", "second")
        self.assertEqual((a["seq"], b["seq"]), (1, 2))
        self.assertEqual(b["prev_hash"], a["hash"])
        self.assertTrue(ledger.verify(self.path)["ok"])

    def test_tamper_detected(self):
        ledger.append(self.path, REQ, RES, "NE", "first")
        ledger.append(self.path, REQ, RES, "NE", "second")
        lines = self.path.read_text().splitlines()
        rec = json.loads(lines[0])
        rec["notes"] = "tampered"
        lines[0] = json.dumps(rec, sort_keys=True, separators=(",", ":"))
        self.path.write_text("\n".join(lines) + "\n")
        out = ledger.verify(self.path)
        self.assertFalse(out["ok"])
        self.assertIn("hash mismatch", out["error"])

    def test_input_hash_is_stable(self):
        self.assertEqual(ledger.sha(REQ), ledger.sha(json.loads(json.dumps(REQ))))


if __name__ == "__main__":
    unittest.main()
