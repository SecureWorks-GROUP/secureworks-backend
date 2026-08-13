#!/usr/bin/env python3
import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "prime-live-thumb-sweep.py"
SPEC = importlib.util.spec_from_file_location("prime_live_thumb_sweep", SCRIPT)
assert SPEC and SPEC.loader
SWEEP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SWEEP)


class PrimeLiveThumbSweepTest(unittest.TestCase):
    def test_hash_grain_is_exactly_url_result_counter_locked_expired(self):
        facts = SWEEP.observation_facts(
            "https://primeeco.tech/share/one",
            "done",
            n_of_n="22 of 24 answered",
            locked=True,
            expired=False,
        )
        self.assertEqual(facts, {
            "url": "https://primeeco.tech/share/one",
            "result": "done",
            "n_of_n": "22 of 24",
            "locked": True,
            "expired": False,
        })
        self.assertEqual(SWEEP.observation_hash(facts), SWEEP.observation_hash(dict(facts)))
        self.assertNotEqual(
            SWEEP.observation_hash(facts),
            SWEEP.observation_hash({**facts, "n_of_n": "23 of 24"}),
        )

    def test_identical_observation_is_suppressed(self):
        current = SWEEP.observation_facts(
            "https://primeeco.tech/share/one",
            "done",
            n_of_n="22 of 24",
            locked=True,
            expired=False,
        )
        previous = {
            "source_url": "https://primeeco.tech/share/one",
            "capture_result": "done",
            "signal": "present_locked 22/24",
        }
        self.assertFalse(SWEEP.should_record(current, previous))

    def test_expiry_is_a_new_observation_but_does_not_redefine_prior_done(self):
        expired = SWEEP.observation_facts(
            "https://primeeco.tech/share/one",
            "unreachable",
            n_of_n=None,
            locked=False,
            expired=True,
        )
        previous_done = {
            "source_url": "https://primeeco.tech/share/one",
            "capture_result": "done",
            "signal": "form locked/submitted, 21 of 23 answered",
        }
        self.assertTrue(SWEEP.should_record(expired, previous_done))
        self.assertTrue(SWEEP.revision_observation_facts(previous_done)["locked"])

    def test_transition_key_changes_when_state_returns_to_an_earlier_value(self):
        state_hash = SWEEP.observation_hash({
            "url": "https://primeeco.tech/share/one",
            "result": "done",
            "n_of_n": "22 of 24",
            "locked": True,
            "expired": False,
        })
        first = SWEEP.transition_idempotency_key(
            job_id="job", cycle_id="cycle", role="roof_report",
            previous_revision_id="revision-1", state_hash=state_hash,
        )
        later = SWEEP.transition_idempotency_key(
            job_id="job", cycle_id="cycle", role="roof_report",
            previous_revision_id="revision-3", state_hash=state_hash,
        )
        self.assertNotEqual(first, later)


if __name__ == "__main__":
    unittest.main()
