// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  SES_PORTAL_CAPTURE_PRODUCER,
  type SesPortalCaptureRevisionContent,
  sesPortalCaptureRevisionHash,
} from "./ses_portal_capture_contract.ts";

// `captured_at` is the one revision field that does not round-trip through
// Postgres unchanged: the writer normalises it to `toISOString()`, the column is
// `timestamptz`, and a reader loading the row back gets PostgREST's spelling of
// the same instant. Before the fix that made the digest depend on which side of
// the database you were standing on, and U4 rejected every capture ever written
// with `portal_capture_invalid`.
const WRITER_SPELLING = "2026-08-02T15:51:47.000Z";
const POSTGREST_SPELLING = "2026-08-02T15:51:47+00:00";

function content(
  overrides: Partial<SesPortalCaptureRevisionContent> = {},
): SesPortalCaptureRevisionContent {
  return {
    job_id: "3ffaf0e2-3080-44eb-bbdc-d2dd812d8b2a",
    attendance_cycle_id: "e805ffd2-539f-4266-82ac-1eaa1d869bda",
    role: "roof_report",
    capture_result: "done",
    source_url:
      "https://primeeco.tech/share/d2ff4956-1302-4ef8-a49e-c9d29061ef4b",
    source_content_hash:
      "sha256:95aad3ba41f378c5890a455c2e2c5d8e3aaa92906c74a509c7566611fb9a2457",
    builder_reference: "MLB-27037",
    captured_at: WRITER_SPELLING,
    captured_by: "ses-run-skill-batch1-v1",
    capture_producer: SES_PORTAL_CAPTURE_PRODUCER,
    capture_idempotency_key: "ses-roof-capture-SWMS-261019-cycle1",
    signal: "form locked/submitted (form-locked banner), 22 of 24 answered",
    screenshot_object_key:
      "makesafe-docket-artifacts/portal-captures/3ffaf0e2-3080-44eb-bbdc-d2dd812d8b2a/e805ffd2-539f-4266-82ac-1eaa1d869bda/roof_report/95aad3ba41f378c5890a455c2e2c5d8e3aaa92906c74a509c7566611fb9a2457.png",
    screenshot_media_type: "image/png",
    screenshot_content_hash:
      "sha256:95aad3ba41f378c5890a455c2e2c5d8e3aaa92906c74a509c7566611fb9a2457",
    screenshot_size_bytes: 248339,
    ...overrides,
  };
}

Deno.test("a capture written by the writer still verifies after a Postgres round-trip", async () => {
  const written = await sesPortalCaptureRevisionHash(content());
  const readBack = await sesPortalCaptureRevisionHash(
    content({ captured_at: POSTGREST_SPELLING }),
  );
  assertEquals(
    readBack,
    written,
    "the reader recomputes a different digest from the writer's, so every " +
      "persisted capture fails its own aggregate content-hash check",
  );
});

// Pins the exact production rows this fix was diagnosed on. Both were written
// live on 2026-08-02 by `record_ses_portal_capture_evidence` and both were
// rejected by U4 on read. The stored digest is unchanged by this fix, so these
// two rows must start verifying without any backfill.
Deno.test("the two live rejected production captures now verify from their stored digest", async () => {
  const rows = [
    {
      label: "SWMS-261019 / c4595559-8a05-48f3-94f5-a8dbf2ce757e",
      stored:
        "sha256:a14165fd6c440aa73b727aa034c6c36610f2e4d2caa52e19c96f1a649c7a835a",
      content: content({ captured_at: "2026-08-02T15:51:47+00:00" }),
    },
    {
      label: "SWMS-26934 / b5dd46d7-b873-4bd9-a4ce-e5e09a2bbf97",
      stored:
        "sha256:f98090f2f61529e3c3aa5c13a40e4166a4d0ef9c006ebcd8daea1e4375308877",
      content: content({
        job_id: "75ea98eb-b808-4138-a67e-c2e1ca4ec820",
        attendance_cycle_id: "4e0bd1fc-97ea-40c5-8f31-ac5e2960895e",
        source_url:
          "https://www.primeeco.tech/share/f41c5a7e-1671-4b40-b0f9-d782ddb9c037",
        source_content_hash:
          "sha256:c57ec79294f4350ec14253c85c94045e4906a512ee41eb1c71a22ba0f10eca5e",
        builder_reference: "",
        captured_at: "2026-08-02T15:52:16+00:00",
        capture_idempotency_key: "ses-roof-capture-SWMS-26934-cycle1",
        signal: "form locked/submitted (form-locked banner), 21 of 23 answered",
        screenshot_object_key:
          "makesafe-docket-artifacts/portal-captures/75ea98eb-b808-4138-a67e-c2e1ca4ec820/4e0bd1fc-97ea-40c5-8f31-ac5e2960895e/roof_report/c57ec79294f4350ec14253c85c94045e4906a512ee41eb1c71a22ba0f10eca5e.png",
        screenshot_content_hash:
          "sha256:c57ec79294f4350ec14253c85c94045e4906a512ee41eb1c71a22ba0f10eca5e",
        screenshot_size_bytes: 262197,
      }),
    },
  ];
  for (const row of rows) {
    assertEquals(
      await sesPortalCaptureRevisionHash(row.content),
      row.stored,
      `${row.label} still fails its aggregate content-hash check on read`,
    );
  }
});

// The point of the fix is that ONE instant has ONE digest, not that timestamps
// stop counting. A different instant must still be a different capture.
Deno.test("a different instant is still a different digest", async () => {
  assertNotEquals(
    await sesPortalCaptureRevisionHash(
      content({ captured_at: "2026-08-02T15:51:48+00:00" }),
    ),
    await sesPortalCaptureRevisionHash(content()),
  );
  assertNotEquals(
    await sesPortalCaptureRevisionHash(
      content({ captured_at: "2026-08-02T15:51:47.001Z" }),
    ),
    await sesPortalCaptureRevisionHash(content()),
  );
});

// Same instant, four legal spellings including a non-UTC offset. All four are
// the same capture and must hash identically, or the defect simply moves to
// whichever spelling a future writer picks.
Deno.test("every legal spelling of the same instant agrees", async () => {
  const expected = await sesPortalCaptureRevisionHash(content());
  for (
    const spelling of [
      "2026-08-02T15:51:47.000Z",
      "2026-08-02T15:51:47+00:00",
      "2026-08-02T15:51:47Z",
      "2026-08-02T23:51:47+08:00",
    ]
  ) {
    assertEquals(
      await sesPortalCaptureRevisionHash(content({ captured_at: spelling })),
      expected,
      `spelling ${spelling} produced a different digest`,
    );
  }
});

// The field is canonicalised, NOT removed from the digest. An unparseable value
// is hashed verbatim: it still produces a digest, it is still compared, and it
// still fails the comparison. The check stays closed on junk.
Deno.test("an unparseable captured_at is hashed verbatim and never collides with a valid one", async () => {
  const junk = await sesPortalCaptureRevisionHash(
    content({ captured_at: "not a timestamp" }),
  );
  const otherJunk = await sesPortalCaptureRevisionHash(
    content({ captured_at: "also not a timestamp" }),
  );
  assertNotEquals(junk, await sesPortalCaptureRevisionHash(content()));
  assertNotEquals(junk, otherJunk);
  assert(junk.startsWith("sha256:"));
});

// Proves the fix did not weaken verification anywhere else: every remaining
// field still moves the digest, so a tampered row is still caught.
Deno.test("every other field still moves the digest", async () => {
  const baseline = await sesPortalCaptureRevisionHash(content());
  const tampered: Array<Partial<SesPortalCaptureRevisionContent>> = [
    { job_id: "00000000-0000-4000-8000-000000000000" },
    { attendance_cycle_id: "00000000-0000-4000-8000-000000000001" },
    { role: "assessment" },
    { capture_result: "not_done" },
    { source_url: "https://primeeco.tech/share/tampered" },
    { source_content_hash: `sha256:${"b".repeat(64)}` },
    { builder_reference: "MLB-99999" },
    { captured_by: "someone-else" },
    { capture_idempotency_key: "tampered-key" },
    { signal: "form NOT locked" },
    { screenshot_object_key: "makesafe-docket-artifacts/tampered.png" },
    { screenshot_content_hash: `sha256:${"c".repeat(64)}` },
    { screenshot_size_bytes: 248340 },
  ];
  for (const override of tampered) {
    assertNotEquals(
      await sesPortalCaptureRevisionHash(content(override)),
      baseline,
      `tampering with ${Object.keys(override)[0]} did not change the digest`,
    );
  }
});
