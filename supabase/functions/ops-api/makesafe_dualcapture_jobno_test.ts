// ════════════════════════════════════════════════════════════
// B3 — DUAL-CAPTURE CLOSE-OUT: "Job No <NNNNN>" fingerprint discriminator
// ════════════════════════════════════════════════════════════
//
// Pure-Deno, no network. Proves the AJS "Make Safe - <Suburb> - Job No 68592"
// twin collapses even when the group-post vs mailbox-fallback bodies DIVERGE (the
// live residual: 7/116 twin windows differ, all this "Job No" builder, whose ref
// prefix SUBJECT_REF_RE does not match), while two genuinely-different job numbers
// never merge and the fail-open (no ref, no job no, no body) behaviour is preserved.
//
// RUN:
//   ~/.deno/bin/deno test --allow-all --no-check \
//     supabase/functions/ops-api/makesafe_dualcapture_jobno_test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildIntakeDedupIndex,
  isDuplicateIntake,
  subjectJobNumber,
} from "./makesafe_intake_dedup.ts";

const FROM = "workorders@ajs.build";
const SUBJ = "Make Safe - CANNING VALE - Job No 68592";
const T = "2026-07-04T02:00:00.000Z";
const T_PLUS_1S = "2026-07-04T02:00:01.000Z"; // twin captured ~1s later

Deno.test("subjectJobNumber lifts the WO number from a 'Job No' subject", () => {
  assertEquals(subjectJobNumber(SUBJ), "68592");
  assertEquals(subjectJobNumber("Make Safe - Thornlie - Job No 68872"), "68872");
  assertEquals(subjectJobNumber("Job Number: 12345 follow up"), "12345");
  assertEquals(subjectJobNumber("Job #67766 attend"), "67766");
  assertEquals(subjectJobNumber("NEW WORK ORDER - MLB-26678 80 San Jacinta"), null);
  assertEquals(subjectJobNumber("no number here"), null);
});

Deno.test("B3: 'Job No' twin collapses even when bodies DIVERGE across capture paths", () => {
  // Existing draft = the group-post capture (empty ref, body variant A).
  const existing = [{
    graph_message_id: "AAMkGROUPPOST",
    internet_message_id: null,
    external_ref: null,
    requesting_company_slug: null,
    requesting_company_name: null,
    from_email: FROM,
    subject: SUBJ,
    received_at: T,
    body_preview: "Hi team, please make safe. Regards, AJS.", // group body variant
  }];
  const index = buildIntakeDedupIndex(existing, [], []);

  // Candidate = the mailbox-fallback twin (different post id, DIFFERENT body text, ~1s later).
  const twin = isDuplicateIntake({
    graph_message_id: "mailbox_deadbeef",
    internet_message_id: "<real-imid@ajs.build>",
    external_ref: null,
    from_email: FROM,
    subject: SUBJ,
    received_at: T_PLUS_1S,
    body: "Hi team, please make safe.\n\n[EXTERNAL]\n\nRegards, AJS.", // mailbox body variant
  }, index);

  assertEquals(twin, "duplicate_content_fingerprint");
});

Deno.test("B3: DIFFERENT job numbers (same builder/subject shape/minute) never merge", () => {
  const existing = [{
    graph_message_id: "AAMkA",
    external_ref: null,
    from_email: FROM,
    subject: "Make Safe - CANNING VALE - Job No 68592",
    received_at: T,
    body_preview: "make safe A",
  }];
  const index = buildIntakeDedupIndex(existing, [], []);

  const other = isDuplicateIntake({
    graph_message_id: "mailbox_x",
    external_ref: null,
    from_email: FROM,
    subject: "Make Safe - CANNING VALE - Job No 70000", // different WO number
    received_at: T_PLUS_1S,
    body: "make safe B",
  }, index);

  assertEquals(other, null); // genuinely different WO -> NOT a duplicate
});

Deno.test("B3: no ref + no job number + no body -> fail open (not deduped)", () => {
  const existing = [{
    graph_message_id: "AAMkA",
    external_ref: null,
    from_email: FROM,
    subject: "Make safe request",
    received_at: T,
    body_preview: null,
  }];
  const index = buildIntakeDedupIndex(existing, [], []);
  const cand = isDuplicateIntake({
    graph_message_id: "mailbox_y",
    external_ref: null,
    from_email: FROM,
    subject: "Make safe request",
    received_at: T_PLUS_1S,
    body: null,
  }, index);
  assert(cand === null, "fail open when no discriminator can be built");
});

Deno.test("B3: a parseable ref still wins over the job-number discriminator (no regression)", () => {
  const existing = [{
    graph_message_id: "AAMkA",
    external_ref: "MLB-26678",
    from_email: "x@primeeco.tech",
    subject: "NEW WORK ORDER - MLB-26678 80 San Jacinta Rd - Job No 999",
    received_at: T,
    body_preview: "body A",
  }];
  const index = buildIntakeDedupIndex(existing, [], []);
  const twin = isDuplicateIntake({
    graph_message_id: "mailbox_z",
    external_ref: null, // ref not yet extracted (pre-model), lifted from subject
    from_email: "x@primeeco.tech",
    subject: "NEW WORK ORDER - MLB-26678 80 San Jacinta Rd - Job No 999",
    received_at: T_PLUS_1S,
    body: "body B (diverged)",
  }, index);
  assertEquals(twin, "duplicate_content_fingerprint");
});
