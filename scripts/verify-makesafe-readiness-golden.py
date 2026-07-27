#!/usr/bin/env python3
"""Independent stdlib verifier for the makesafe readiness golden vector."""

from __future__ import annotations

import hashlib
import json
import pathlib
import unicodedata

DOMAIN = b"SecureWorks:make-safe-readiness:v1\n"
VECTOR_PATH = (
    pathlib.Path(__file__).parents[1]
    / "supabase/functions/ops-api/makesafe_readiness_golden_vectors.json"
)


def normalize(value):
    if isinstance(value, dict):
        return {key: normalize(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        items = [normalize(item) for item in value]
        if all(isinstance(item, dict) and "id" in item for item in items):
            items.sort(key=lambda item: unicodedata.normalize("NFC", item["id"]))
        elif all(isinstance(item, str) for item in items):
            items.sort(key=lambda item: unicodedata.normalize("NFC", item))
        return items
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, float):
        raise TypeError("floating point values are forbidden")
    return value


def canonical(value) -> str:
    return json.dumps(
        normalize(value),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def main() -> None:
    vectors = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
    for vector in vectors:
        payload = canonical(vector["envelope"])
        digest = "sha256:" + hashlib.sha256(
            DOMAIN + payload.encode("utf-8")
        ).hexdigest()
        assert digest == vector["readiness_revision"], vector["name"]
    print(f"verified {len(vectors)} makesafe readiness golden vector(s)")


if __name__ == "__main__":
    main()
