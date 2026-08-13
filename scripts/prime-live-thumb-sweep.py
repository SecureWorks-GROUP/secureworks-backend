#!/usr/bin/env python3
"""Recurring Prime/PrimeEco capture sweep using the existing wiki producer.

The backend feed is read with OPS_AGENT_SERVER_KEY. Canonical U4 facts and the
append-only record action use MAKESAFE_ROUTINE_KEY. This runner never accepts a
user JWT or SW_API_KEY and has no send/invoice/approval action.

The browser and classifier are imported from capture_portal_evidence.py/v1;
this file only schedules captures, suppresses unchanged observations, and
submits changed evidence through record_ses_portal_capture_evidence.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any
from urllib import error, parse, request

DEFAULT_OPS_API = "https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api"
CAPTURED_BY = "prime-live-thumb-sweep/v1"
N_OF_N_RE = re.compile(r"\b(\d+)\s*(?:of|/)\s*(\d+)\b", re.I)
EXPIRED_RE = re.compile(r"no longer active|\bexpired\b", re.I)


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _n_of_n(value: Any) -> str | None:
    match = N_OF_N_RE.search(str(value or ""))
    return f"{match.group(1)} of {match.group(2)}" if match else None


def observation_facts(url: str, result: str, *, n_of_n: Any,
                      locked: bool, expired: bool) -> dict[str, Any]:
    """The exact change grain from the captain's contract."""
    return {
        "url": url,
        "result": result,
        "n_of_n": _n_of_n(n_of_n),
        "locked": bool(locked),
        "expired": bool(expired),
    }


def evidence_observation_facts(url: str, evidence: dict[str, Any], producer: Any) -> dict[str, Any]:
    state = str(evidence.get("portal_state") or "")
    result = producer.LEGACY_STATUS.get(state, "unreachable")
    return observation_facts(
        url,
        result,
        n_of_n=evidence.get("n_of_n"),
        locked=evidence.get("locked") is True,
        expired=state == "expired",
    )


def revision_observation_facts(revision: dict[str, Any]) -> dict[str, Any]:
    result = str(revision.get("capture_result") or "")
    signal = str(revision.get("signal") or "")
    return observation_facts(
        str(revision.get("source_url") or ""),
        result,
        n_of_n=signal,
        locked=result == "done",
        expired=result == "unreachable" and bool(EXPIRED_RE.search(signal)),
    )


def observation_hash(facts: dict[str, Any]) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(facts).encode()).hexdigest()


def transition_idempotency_key(*, job_id: str, cycle_id: str, role: str,
                               previous_revision_id: str | None,
                               state_hash: str) -> str:
    payload = {
        "job_id": job_id,
        "attendance_cycle_id": cycle_id,
        "role": role,
        "previous_revision_id": previous_revision_id,
        "state_hash": state_hash,
    }
    return "prime-live-thumb:v1:" + hashlib.sha256(
        canonical_json(payload).encode()
    ).hexdigest()


def should_record(evidence_facts: dict[str, Any], previous: dict[str, Any] | None) -> bool:
    return previous is None or observation_hash(evidence_facts) != observation_hash(
        revision_observation_facts(previous)
    )


def _load_producer(path: Path) -> Any:
    spec = importlib.util.spec_from_file_location("capture_portal_evidence", path)
    if not spec or not spec.loader:
        raise RuntimeError(f"could not load capture producer at {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if getattr(module, "CAPTURE_PRODUCER", None) != "capture_portal_evidence.py/v1":
        raise RuntimeError("capture producer contract is not capture_portal_evidence.py/v1")
    return module


def _http_json(base_url: str, key: str, action: str, *, body: dict[str, Any] | None = None,
               timeout: int = 180) -> tuple[int, dict[str, Any]]:
    url = base_url.rstrip("?") + "?" + parse.urlencode({"action": action})
    req = request.Request(
        url,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "x-api-key": key,
            "Content-Type": "application/json",
            "User-Agent": "secureworks-prime-live-thumb/1.0 (+ops)",
        },
        method="POST" if body is not None else "GET",
    )
    try:
        with request.urlopen(req, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode())
    except error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw)
        except ValueError:
            return exc.code, {"error": raw[:400]}


def _u4_identity(base_url: str, routine_key: str, job_id: str) -> tuple[str, str] | None:
    status, response = _http_json(
        base_url,
        routine_key,
        "prepare_ses_docket_revision",
        body={
            "dry_run": True,
            "idempotency_key": f"prime-live-thumb-identity-{job_id}",
            "selection": {"mode": "job_id", "job_id": job_id},
        },
    )
    results = response.get("results") if status == 200 else None
    result = results[0] if isinstance(results, list) and results and isinstance(results[0], dict) else {}
    envelope = result.get("envelope") if isinstance(result, dict) else {}
    v2 = envelope.get("v2") if isinstance(envelope, dict) else {}
    classification = v2.get("classification") if isinstance(v2, dict) else {}
    spine = envelope.get("spine") if isinstance(envelope, dict) else {}
    reference = classification.get("builder_reference") if isinstance(classification, dict) else None
    cycle = spine.get("current_attendance_cycle_id") if isinstance(spine, dict) else None
    if not isinstance(reference, str) or not isinstance(cycle, str) or not cycle:
        return None
    return reference, cycle


def _latest_for_cycle(item: dict[str, Any], cycle_id: str) -> dict[str, Any] | None:
    revisions = item.get("revisions")
    if not isinstance(revisions, list):
        return None
    return next(
        (row for row in revisions
         if isinstance(row, dict) and row.get("attendance_cycle_id") == cycle_id),
        None,
    )


def run(args: argparse.Namespace) -> int:
    agent_key = os.environ.get("OPS_AGENT_SERVER_KEY", "").strip()
    routine_key = os.environ.get("MAKESAFE_ROUTINE_KEY", "").strip()
    if not agent_key or not routine_key:
        print("OPS_AGENT_SERVER_KEY and MAKESAFE_ROUTINE_KEY are required", file=sys.stderr)
        return 2
    base_url = os.environ.get("OPS_API_BASE_URL", DEFAULT_OPS_API).strip()
    producer = _load_producer(Path(args.producer).expanduser().resolve())
    status, feed = _http_json(base_url, agent_key, "makesafe_prime_capture_sweep")
    if status != 200 or not isinstance(feed.get("items"), list):
        print(f"Prime capture feed failed (HTTP {status})", file=sys.stderr)
        return 2

    selected = [item for item in feed["items"] if isinstance(item, dict)]
    if args.job:
        wanted = {value.strip() for value in args.job}
        selected = [item for item in selected if
                    str(item.get("job_id")) in wanted or str(item.get("job_number")) in wanted]
    selected = selected[:args.limit]

    chrome = producer.find_chrome()
    identity_cache: dict[str, tuple[str, str] | None] = {}
    counts = {"checked": 0, "recorded": 0, "unchanged": 0, "refused": 0, "failed": 0}

    temporary = None
    if args.out_dir:
        out_dir = Path(args.out_dir).expanduser().resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
    else:
        # The producer's proven macOS contract refuses Chrome profiles under
        # /var/folders (the system tempfile root): Chrome can hang there. Keep
        # this ephemeral evidence inside the checked-out backend and remove it
        # at the end of the run.
        temporary = tempfile.TemporaryDirectory(
            prefix=".prime-live-thumb-",
            dir=Path(__file__).resolve().parents[1],
        )
        out_dir = Path(temporary.name)

    try:
        for index, item in enumerate(selected):
            job_id = str(item.get("job_id") or "")
            job_number = str(item.get("job_number") or job_id)
            role = str(item.get("role") or "")
            source_url = str(item.get("source_url") or "")
            if job_id not in identity_cache:
                identity_cache[job_id] = _u4_identity(base_url, routine_key, job_id)
            identity = identity_cache[job_id]
            if identity is None:
                counts["refused"] += 1
                print(f"REFUSED {job_number} {role}: U4 published no canonical reference/cycle")
                continue
            reference, cycle_id = identity
            previous = _latest_for_cycle(item, cycle_id)
            evidence = producer.capture_one(
                chrome,
                {"ref": job_number, "url": source_url, "role": role, "label": item.get("label")},
                out_dir,
                index,
            )
            counts["checked"] += 1
            facts = evidence_observation_facts(source_url, evidence, producer)
            if not should_record(facts, previous):
                counts["unchanged"] += 1
                print(f"UNCHANGED {job_number} {role}: {facts['result']} {facts['n_of_n'] or ''}".rstrip())
                continue
            record_body, refusal = producer.build_capture_record(
                {
                    "parsed": True,
                    "job_id": job_id,
                    "attendance_cycle_id": cycle_id,
                    "role": role,
                    "source_url": source_url,
                },
                evidence,
                reference,
                captured_by=CAPTURED_BY,
            )
            if record_body is None:
                counts["refused"] += 1
                print(f"REFUSED {job_number} {role}: {refusal}")
                continue
            state_hash = observation_hash(facts)
            record_body["capture_idempotency_key"] = transition_idempotency_key(
                job_id=job_id,
                cycle_id=cycle_id,
                role=role,
                previous_revision_id=str(previous.get("id")) if previous else None,
                state_hash=state_hash,
            )
            if not args.apply:
                print(f"WOULD_RECORD {job_number} {role}: {facts['result']} {facts['n_of_n'] or ''}".rstrip())
                continue
            write_status, write_response = _http_json(
                base_url,
                routine_key,
                "record_ses_portal_capture_evidence",
                body=record_body,
            )
            if write_status != 200:
                counts["failed"] += 1
                code = write_response.get("code") if isinstance(write_response, dict) else None
                print(f"FAILED {job_number} {role}: record HTTP {write_status} code={code or 'unknown'}")
                continue
            counts["recorded"] += 1
            print(f"RECORDED {job_number} {role}: {facts['result']} {facts['n_of_n'] or ''}".rstrip())
    finally:
        shutil.rmtree(out_dir / ".chrome-profile", ignore_errors=True)
        if temporary is not None:
            temporary.cleanup()

    print(json.dumps({"apply": args.apply, **counts}, sort_keys=True))
    return 1 if counts["failed"] or counts["refused"] else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--producer",
        default=os.environ.get("CAPTURE_PORTAL_EVIDENCE_PY", "capture_portal_evidence.py"),
        help="path to the existing wiki capture_portal_evidence.py producer",
    )
    parser.add_argument("--apply", action="store_true", help="record changed captures (dry by default)")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--job", action="append", help="optional job id/number filter; repeatable")
    parser.add_argument("--out-dir", help="preserve local screenshots here; default is a temporary directory")
    args = parser.parse_args()
    args.limit = max(1, min(500, args.limit))
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
