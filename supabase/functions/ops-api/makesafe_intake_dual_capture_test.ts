// M1.5 D0 — DUAL-CAPTURE DEDUP tests. The ses@ sync writes two `emails` rows for the
// same email (a group-post row with a graph id "AAMk…" and a mailbox-fallback row with
// "mailbox_<hash>"); pre-M1.5 both became drafts (two model calls) because the graph
// ids differ and external_ref was null. The content fingerprint collapses the twin.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildIntakeDedupIndex,
  contentFingerprint,
  type IntakeDedupRow,
  isDuplicateIntake,
  registerIntakeDraft,
} from "./makesafe_intake_dedup.ts";

const FROM = "dispatch@mlb.com.au";
const SUBJECT = "NEW WORK ORDER - MLB-26499 18 Eagleglen Rise, Gidgegannup";

// The group-post capture row already exists as a draft.
const groupDraft: IntakeDedupRow = {
  graph_message_id: "AAMkAGyzobseAAA=",
  internet_message_id: null,
  external_ref: null, // the pre-M1.5 blind spot: null ref, so ref+company can't dedupe
  from_email: FROM,
  subject: SUBJECT,
  received_at: "2026-07-03T02:15:30Z",
};

Deno.test("D0: the mailbox-fallback twin of the same email is a content-fingerprint duplicate", () => {
  const index = buildIntakeDedupIndex([groupDraft]);
  // Same email, other capture path: different graph id, ~1s later, identical content.
  const twin = {
    graph_message_id: "mailbox_9f8c2a1b",
    internet_message_id: null,
    from_email: FROM,
    subject: SUBJECT,
    received_at: "2026-07-03T02:15:31Z", // sub-minute drift; same minute bucket
  };
  assertEquals(isDuplicateIntake(twin, index), "duplicate_content_fingerprint");
});

Deno.test("D0: two GENUINELY DIFFERENT work orders (different subject) are NOT merged", () => {
  const index = buildIntakeDedupIndex([groupDraft]);
  const differentJob = {
    graph_message_id: "AAMkAGyzobsyAAA=",
    internet_message_id: null,
    from_email: FROM,
    subject: "NEW WORK ORDER - MLB-26500 5 Other Street, Perth",
    received_at: "2026-07-03T02:15:31Z", // same builder, same minute — but different job
  };
  assertEquals(isDuplicateIntake(differentJob, index), null);
});

Deno.test("D0: in-batch — first twin registers the fingerprint, second is caught", () => {
  const index = buildIntakeDedupIndex([]); // nothing pre-existing
  const first = {
    graph_message_id: "AAMk-batch-1",
    from_email: FROM,
    subject: SUBJECT,
    received_at: "2026-07-03T02:15:30Z",
  };
  assertEquals(isDuplicateIntake(first, index), null); // genuinely new
  registerIntakeDraft(first, index);
  const twin = {
    graph_message_id: "mailbox-batch-1",
    from_email: FROM,
    subject: SUBJECT,
    received_at: "2026-07-03T02:15:31Z",
  };
  assertEquals(isDuplicateIntake(twin, index), "duplicate_content_fingerprint");
});

Deno.test("D0: fail-open — a candidate missing received_at builds no fingerprint (not deduped)", () => {
  const index = buildIntakeDedupIndex([groupDraft]);
  const noReceived = {
    graph_message_id: "mailbox-noreceived",
    from_email: FROM,
    subject: SUBJECT,
    received_at: null,
  };
  assertEquals(isDuplicateIntake(noReceived, index), null);
});

Deno.test("D0: contentFingerprint is stable across capture paths, distinct across minutes/subjects", () => {
  const a = contentFingerprint(FROM, SUBJECT, "2026-07-03T02:15:30Z");
  const b = contentFingerprint(FROM, SUBJECT, "2026-07-03T02:15:59Z");
  assert(a && b && a === b, "same sender+subject+minute -> same fingerprint");
  const nextMinute = contentFingerprint(FROM, SUBJECT, "2026-07-03T02:16:00Z");
  assert(nextMinute !== a, "different minute -> different fingerprint");
  const otherSubject = contentFingerprint(FROM, "NEW WORK ORDER - MLB-26500", "2026-07-03T02:15:30Z");
  assert(otherSubject !== a, "different subject -> different fingerprint");
  assertEquals(contentFingerprint(FROM, SUBJECT, null), ""); // missing field -> no key
  assertEquals(contentFingerprint(null, SUBJECT, "2026-07-03T02:15:30Z"), "");
});

// ── H2: a ref-less generic subject must dedupe on BODY, never collapse two jobs ──
const GENERIC_SUBJECT = "Make safe request"; // no builder ref in the subject
const bodyA = "Attend 18 Eagleglen Rise Gidgegannup, tarp the roof after storm.";
const bodyB = "Attend 5 Other Street Perth, board up the smashed front window.";

Deno.test("H2: same sender + minute + generic subject, DIFFERENT body -> two drafts (not merged)", () => {
  const draftA: IntakeDedupRow = {
    graph_message_id: "AAMk-generic-A",
    external_ref: null,
    from_email: FROM,
    subject: GENERIC_SUBJECT,
    received_at: "2026-07-03T02:15:30Z",
    body_preview: bodyA,
  };
  const index = buildIntakeDedupIndex([draftA]);
  // A genuinely DIFFERENT ref-less job, same sender/subject/minute, different body.
  const jobB = {
    graph_message_id: "AAMk-generic-B",
    from_email: FROM,
    subject: GENERIC_SUBJECT,
    received_at: "2026-07-03T02:15:31Z",
    body: bodyB,
  };
  assertEquals(isDuplicateIntake(jobB, index), null); // MUST NOT be dropped
});

Deno.test("H2: same sender + minute + generic subject, SAME body (true twin) -> deduped", () => {
  const draftA: IntakeDedupRow = {
    graph_message_id: "AAMk-generic-A2",
    external_ref: null,
    from_email: FROM,
    subject: GENERIC_SUBJECT,
    received_at: "2026-07-03T02:15:30Z",
    body_preview: bodyA,
  };
  const index = buildIntakeDedupIndex([draftA]);
  const twin = {
    graph_message_id: "mailbox-generic-A2",
    from_email: FROM,
    subject: GENERIC_SUBJECT,
    received_at: "2026-07-03T02:15:31Z",
    body: bodyA, // identical content -> same body-hash discriminator
  };
  assertEquals(isDuplicateIntake(twin, index), "duplicate_content_fingerprint");
});

Deno.test("H2: no ref AND no body -> fail-open (no fingerprint, not deduped)", () => {
  const draftA: IntakeDedupRow = {
    graph_message_id: "AAMk-nobody",
    external_ref: null,
    from_email: FROM,
    subject: GENERIC_SUBJECT,
    received_at: "2026-07-03T02:15:30Z",
    body_preview: null,
  };
  const index = buildIntakeDedupIndex([draftA]);
  const twin = {
    graph_message_id: "mailbox-nobody",
    from_email: FROM,
    subject: GENERIC_SUBJECT,
    received_at: "2026-07-03T02:15:31Z",
    body: null,
  };
  assertEquals(isDuplicateIntake(twin, index), null); // cannot safely dedupe -> fail open
});

// ── M1: the two capture rows can straddle a minute boundary ──
Deno.test("M1: a twin straddling the :59 -> :00 minute boundary is still deduped", () => {
  const draftA: IntakeDedupRow = {
    graph_message_id: "AAMk-boundary",
    external_ref: null,
    from_email: FROM,
    subject: SUBJECT, // carries the ref
    received_at: "2026-07-03T02:15:59Z", // :59
    body_preview: bodyA,
  };
  const index = buildIntakeDedupIndex([draftA]);
  const twin = {
    graph_message_id: "mailbox-boundary",
    from_email: FROM,
    subject: SUBJECT,
    received_at: "2026-07-03T02:16:01Z", // NEXT minute — adjacent bucket
    body: bodyA,
  };
  assertEquals(isDuplicateIntake(twin, index), "duplicate_content_fingerprint");
});

Deno.test("D0: fingerprint dedup does NOT disturb the existing graph-id / ref dedup", () => {
  // A pre-existing draft with a ref but different sender content still dedupes on ref.
  const withRef: IntakeDedupRow = {
    graph_message_id: "AAMk-ref",
    external_ref: "MLB-26499",
    requesting_company_slug: "mlb",
    from_email: FROM,
    subject: SUBJECT,
    received_at: "2026-07-03T02:15:30Z",
  };
  const index = buildIntakeDedupIndex([withRef]);
  // Same graph id -> graph_message_id reason (unchanged behaviour).
  assertEquals(
    isDuplicateIntake({ graph_message_id: "AAMk-ref" }, index),
    "graph_message_id",
  );
  // Same ref+company via a DIFFERENT path (no fingerprint fields) -> ref reason.
  assertEquals(
    isDuplicateIntake({ external_ref: "MLB-26499", requesting_company_slug: "mlb" }, index),
    "external_ref+company",
  );
});
