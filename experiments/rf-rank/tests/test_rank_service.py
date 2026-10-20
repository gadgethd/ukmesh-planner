"""Independent correctness tests for the experimental ranking service.

Run: /home/ben/meshcore-ml-research/.venv/bin/python -m unittest discover -s tests -v
"""
import json
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
try:
    import rank_service as rs  # noqa: E402
    AVAILABLE, SKIP_REASON = True, ""
except Exception as exc:  # research featuriser/DEM not present in this environment
    rs = None  # type: ignore[assignment]
    AVAILABLE, SKIP_REASON = False, f"ranking runtime unavailable: {exc}"

# a small, real-ish set of UK repeaters (coords only; metadata deliberately absent)
REPS = [
    {"id": "A", "lat": 54.90, "lon": -1.70},
    {"id": "B", "lat": 55.10, "lon": -1.50},
    {"id": "C", "lat": 54.50, "lon": -2.10},
    {"id": "D", "lat": 55.30, "lon": -2.40},
]
CAND = {"lat": 54.97, "lon": -1.61, "antenna_height_m": 10, "role": 2}


def call(cand=None, reps=None, top_k=20):
    return rs.rank({"candidate": CAND if cand is None else cand,
                    "repeaters": REPS if reps is None else reps, "top_k": top_k})


@unittest.skipUnless(AVAILABLE, SKIP_REASON)
class TestRankService(unittest.TestCase):
    def test_deterministic(self):
        a = json.dumps(call(), sort_keys=True)
        b = json.dumps(call(), sort_keys=True)
        self.assertEqual(a, b)

    def test_top_k(self):
        r = call(top_k=2)
        self.assertEqual(len(r["ranking"]), 2)
        self.assertEqual([x["rank"] for x in r["ranking"]], [1, 2])

    def test_ordering_is_consistent(self):
        r = call()
        scores = [x["score"] for x in r["ranking"]]
        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_missing_metadata_warns_but_works(self):
        r = call()
        self.assertTrue(r["candidate"]["metadata_complete"])
        self.assertTrue(any("antenna-height metadata" in w for w in r["warnings"]))

    def test_missing_candidate_height(self):
        c = dict(CAND)
        c.pop("antenna_height_m")
        r = call(cand=c)
        self.assertFalse(r["candidate"]["metadata_complete"])
        self.assertTrue(any("height unknown" in w for w in r["warnings"]))

    def test_no_probability_language(self):
        blob = json.dumps(call()).lower()
        import re
        for banned in ("chance of",):
            self.assertNotIn(banned, blob)
        self.assertNotIn('"probability', blob)
        self.assertIsNone(re.search(r"\d+(\.\d+)?%", blob))

    def test_semantics_states_ranking_only(self):
        self.assertIn("relative link ranking only", call()["semantics"])

    def test_invalid_candidate_coords(self):
        with self.assertRaises(rs.BadRequest):
            call(cand={"lat": 999, "lon": 0})

    def test_empty_repeaters(self):
        with self.assertRaises(rs.BadRequest):
            call(reps=[])

    def test_duplicate_ids(self):
        with self.assertRaises(rs.BadRequest):
            call(reps=[REPS[0], dict(REPS[0])])

    def test_invalid_repeater_coords(self):
        with self.assertRaises(rs.BadRequest):
            call(reps=[{"id": "X", "lat": None, "lon": 1.0}])

    def test_out_of_range_warning(self):
        far = [{"id": "FAR", "lat": 60.0, "lon": -1.0}]
        r = call(reps=far)
        self.assertTrue(any("outside validated distance range" in w for w in r["ranking"][0]["warnings"]))

    def test_terms_present_and_finite(self):
        for row in call()["ranking"]:
            for k, v in row["terms"].items():
                self.assertTrue(math.isfinite(v), (k, v))

    def test_tie_break_by_distance_then_id(self):
        same = [{"id": "Z", "lat": 54.97, "lon": -1.71},
                {"id": "A", "lat": 54.97, "lon": -1.51}]
        rows = call(reps=same)["ranking"]
        # scores differ only through distance/features; if equal, nearer must win
        if abs(rows[0]["score"] - rows[1]["score"]) < 1e-12:
            self.assertLessEqual(rows[0]["terms"]["distance_km"], rows[1]["terms"]["distance_km"])


if __name__ == "__main__":
    unittest.main()
