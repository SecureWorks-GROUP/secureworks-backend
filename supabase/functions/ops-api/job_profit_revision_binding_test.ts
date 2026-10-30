// The JP-23 slice 2 reader rule, R1 to R8, on synthetic chains.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideRevisionAcceptance,
  type RevisionChain,
} from "./job_profit_revision_binding.ts";

const F = "rev-F";
const G = "rev-G";
const bound = (over: Partial<RevisionChain> = {}): RevisionChain => ({
  acceptedDocumentIds: ["D"],
  runs: [],
  releases: [{ job_document_id: "D", scope_revision_id: F }],
  variations: [],
  baselineRevisionId: F,
  frozenRevisionId: F,
  unreadable: false,
  ...over,
});
const basis = (c: RevisionChain) => decideRevisionAcceptance(c).basis;

Deno.test("revision binding: every rule holding reads true, and only then", () => {
  assertEquals(decideRevisionAcceptance(bound()), {
    accepted: true,
    basis: null,
  });
  // a re-acceptance whose one release still names F
  assertEquals(decideRevisionAcceptance(bound()).accepted, true);
  // an accepted run carrying the document, every party accepted
  assertEquals(
    decideRevisionAcceptance(bound({
      acceptedDocumentIds: [],
      runs: [{ status: "accepted", job_document_id: "D" }],
    })),
    { accepted: true, basis: null },
  );
});

Deno.test("revision binding: a failed read is not known, before any other rule", () => {
  assertEquals(basis(bound({ unreadable: true })), "chain_unreadable");
  assertEquals(
    basis(bound({ unreadable: true, acceptedDocumentIds: [], releases: [] })),
    "chain_unreadable",
  );
});

Deno.test("revision binding: acceptance must be non-empty (R1)", () => {
  assertEquals(
    basis(bound({
      acceptedDocumentIds: [],
      runs: [{ status: "accepted", job_document_id: null }],
      releases: [],
    })),
    "no_accepted_document",
  );
  assertEquals(
    basis(bound({ releases: [] })),
    "accepted_document_not_released",
  );
  assertEquals(
    basis(bound({
      acceptedDocumentIds: ["D", "E"],
      releases: [{ job_document_id: "D", scope_revision_id: F }],
    })),
    "accepted_document_not_released",
  );
  assertEquals(
    basis(bound({ runs: [{ status: "accepted", job_document_id: null }] })),
    "run_acceptance_without_document",
  );
});

Deno.test("revision binding: every release names one revision, the compared and baseline one (R2-R5)", () => {
  assertEquals(
    basis(
      bound({ releases: [{ job_document_id: "D", scope_revision_id: null }] }),
    ),
    "release_names_no_revision",
  );
  assertEquals(
    basis(bound({
      releases: [
        { job_document_id: "D", scope_revision_id: F },
        { job_document_id: "D", scope_revision_id: G },
      ],
    })),
    "releases_name_different_revisions",
  );
  assertEquals(
    basis(bound({
      acceptedDocumentIds: ["D1", "D2"],
      releases: [
        { job_document_id: "D1", scope_revision_id: F },
        { job_document_id: "D2", scope_revision_id: G },
      ],
    })),
    "releases_name_different_revisions",
  );
  assertEquals(
    basis(bound({
      releases: [{ job_document_id: "D", scope_revision_id: G }],
      baselineRevisionId: G,
    })),
    "release_not_compared_revision",
  );
  assertEquals(
    basis(bound({ frozenRevisionId: null })),
    "release_not_compared_revision",
  );
  assertEquals(
    basis(bound({ baselineRevisionId: G })),
    "baseline_names_other_revision",
  );
  assertEquals(
    basis(bound({ baselineRevisionId: null })),
    "baseline_names_other_revision",
  );
});

Deno.test("revision binding: an accepted variation or an open party keeps it unknown (R6, R7)", () => {
  assertEquals(
    basis(
      bound({
        variations: [{
          accepted_at: "2026-10-20T00:00:00Z",
          status: "approved",
        }],
      }),
    ),
    "variation_accepted_semantics_open",
  );
  assertEquals(
    basis(bound({ variations: [{ accepted_at: null, status: "invoiced" }] })),
    "variation_accepted_semantics_open",
  );
  assertEquals(
    decideRevisionAcceptance(bound({
      variations: [{ accepted_at: null, status: "pending_approval" }],
    })).accepted,
    true,
  );
  for (const status of ["declined", "pending"]) {
    assertEquals(
      basis(bound({
        acceptedDocumentIds: [],
        runs: [
          { status: "accepted", job_document_id: "D" },
          { status, job_document_id: "D2" },
        ],
      })),
      "party_not_accepted",
      status,
    );
  }
});
