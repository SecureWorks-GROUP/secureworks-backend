# Repair curated-source bind contract

Date: 2026-08-10

## Scope

The physical docket path requires a durable curated supporting-report source for
the `repair` family. The only source bind route excluded `repair`, producing a
contradictory `curated_source_missing` refusal: the card required evidence it
could not establish through the guarded bind.

This change admits `repair` to that existing, fully-gated bind route. It does
not create, alter, re-render, or re-bind any production record. It does not
admit `restoration` or any other family.

## Preserved authorised dry-run hash conflict

The authorised one-card dry-run recorded these two distinct report hashes. They
are deliberately retained separately; this artifact makes no claim that either
one supersedes or describes the other.

- `sha256:41cf397910b782acd0f20a5008da0c67bdb8a617a290bc1a72e049e0da24adc8`
- `sha256:cac3cbe39053d6631e26d27b2575f0246f25ac78ee63cdb475d06df4fd8b7994`

No raw production capture, report bytes, contact data, or address data is
copied into this repository.

## Boundaries retained

- The bind still verifies the supplied PDF's type, size and raw SHA-256 against
  the existing stored document bytes.
- It still derives cycle, renderer provenance, canonical report input hash and
  source-evidence accounting on the server, writes the append-only bind event,
  and updates the document only by compare-and-swap.
- The sealed money, approval, send and stage paths remain outside this route.
