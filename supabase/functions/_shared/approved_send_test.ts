// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  APPROVED_SEND_RECORDER_ACTORS,
  ApprovedSendRefusal,
  assertApprovalRecorderAllowed,
  canonicalJson,
  claimApprovedSend,
  finishApprovedSend,
  normalizeMobile,
  payloadHash,
  prepareApprovedSend,
  readApprovalIdOnly,
  recordApproval,
  type RecorderCredentialClass,
  sealApproval,
} from "./approved_send.ts";
import {
  emailApprovalBody,
  makeDeps,
  RECORDER,
  smsApprovalBody,
} from "./approved_send_test_fakes.ts";

const DOC_ID = "11111111-1111-4111-8111-111111111111";
const CALLER = { actor: "seat:rayleigh", credentialClass: "ops_agent_server_key" };

async function refusalCode(fn: () => Promise<unknown>): Promise<string> {
  const error = await assertRejects(fn, ApprovedSendRefusal);
  return (error as ApprovedSendRefusal).code;
}

function withDoc(deps: ReturnType<typeof makeDeps>, content = "%PDF-1.7 quote v2") {
  deps.files.put({ source: "job_document", id: DOC_ID }, content, "Quote-v2.pdf");
}

async function recordLive(deps: ReturnType<typeof makeDeps>, body: Record<string, unknown>) {
  const preview = await recordApproval(deps, RECORDER, body);
  return await recordApproval(deps, RECORDER, {
    ...body,
    dry_run: false,
    expected_payload_hash: preview.payload_hash,
  });
}

// ── hashing ────────────────────────────────────────────────────────────────

Deno.test("canonical JSON sorts keys at every depth and keeps array order", () => {
  assertEquals(
    canonicalJson({ b: 1, a: { d: [3, 1], c: "x" } }),
    '{"a":{"c":"x","d":[3,1]},"b":1}',
  );
  assertEquals(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
});

Deno.test("the payload hash changes when any sent field changes", async () => {
  const base = {
    schema: "secureworks.approved-send.sms/v1" as const,
    channel: "sms" as const,
    to_mobile: "+61412345678",
    from_line: "+61489267771",
    message: "hello",
  };
  const hash = await payloadHash(base);
  assert(/^sha256:[0-9a-f]{64}$/.test(hash));
  assertEquals(await payloadHash({ ...base }), hash);
  assertNotEquals(await payloadHash({ ...base, message: "hello." }), hash);
  assertNotEquals(await payloadHash({ ...base, to_mobile: "+61412345679" }), hash);
  assertNotEquals(await payloadHash({ ...base, from_line: "+61489267776" }), hash);
});

Deno.test("mobiles normalise to one exact E.164 number", () => {
  assertEquals(normalizeMobile("0412 345 678"), "+61412345678");
  assertEquals(normalizeMobile("+61 412-345-678"), "+61412345678");
  assertEquals(normalizeMobile("61412345678"), "+61412345678");
  assertThrows(() => normalizeMobile("12345"), ApprovedSendRefusal);
  assertThrows(() => normalizeMobile("0412345678, 0412345679"), ApprovedSendRefusal);
});

// ── recorder restriction ───────────────────────────────────────────────────

Deno.test("only the recorder seat on a server secret may record an approval", () => {
  assert(APPROVED_SEND_RECORDER_ACTORS.has("seat:rayleigh"));
  assertApprovalRecorderAllowed(RECORDER);
  assertApprovalRecorderAllowed({ ...RECORDER, credentialClass: "service_role" });

  const refused: RecorderCredentialClass[] = [
    "shared_key",
    "routine",
    "agent_read",
    "user_jwt",
    "none",
  ];
  for (const credentialClass of refused) {
    const error = assertThrows(
      () => assertApprovalRecorderAllowed({ ...RECORDER, credentialClass }),
      ApprovedSendRefusal,
    );
    assertEquals(error.code, "approval_recorder_required");
    assertEquals(error.status, 403);
  }
  // A desk or crew seat, even on a server secret.
  for (const actor of ["seat:coo", "seat:cfo", "workflow:census", "marnin", "actor_missing"]) {
    assertThrows(
      () => assertApprovalRecorderAllowed({ ...RECORDER, actor }),
      ApprovedSendRefusal,
    );
  }
  // The right name but not as a trusted header (e.g. a JWT caller's claim).
  assertThrows(
    () => assertApprovalRecorderAllowed({ ...RECORDER, actorSource: "header_untrusted" }),
    ApprovedSendRefusal,
  );
});

// ── record ────────────────────────────────────────────────────────────────

Deno.test("record is a dry run by default and writes nothing", async () => {
  const deps = makeDeps();
  const preview = await recordApproval(deps, RECORDER, smsApprovalBody());
  assertEquals(preview.dry_run, true);
  assertEquals(preview.approval_id, null);
  assertEquals(deps.store.rows.size, 0);
  assertEquals(deps.store.auditRows.length, 0);
  assertEquals((preview.payload as any).to_mobile, "+61412345678");
  assertEquals((preview.payload as any).from_line, "+61489267771");
});

Deno.test("a live record needs the previewed hash echoed back", async () => {
  const deps = makeDeps();
  assertEquals(
    await refusalCode(() =>
      recordApproval(deps, RECORDER, { ...smsApprovalBody(), dry_run: false })
    ),
    "approval_payload_hash_mismatch",
  );
  const preview = await recordApproval(deps, RECORDER, smsApprovalBody());
  assertEquals(
    await refusalCode(() =>
      recordApproval(deps, RECORDER, {
        ...smsApprovalBody({ sms: { to_mobile: "0412345678", message: "different words" } }),
        dry_run: false,
        expected_payload_hash: preview.payload_hash,
      })
    ),
    "approval_payload_hash_mismatch",
  );
  assertEquals(deps.store.rows.size, 0);

  const live = await recordLive(deps, smsApprovalBody());
  assertEquals(live.dry_run, false);
  const row = deps.store.rows.get(live.approval_id!)!;
  assertEquals(row.approval_words, "Yes send Hugo: 'Running 10 min late, see you at 9:10'");
  assertEquals(row.approved_by, "marnin");
  assertEquals(row.recorded_by_actor, "seat:rayleigh");
  assertEquals(row.recorded_via, "ops_agent_server_key");
  assertEquals(row.status, "approved");
  assertEquals(row.payload_hash, live.payload_hash);
  assertEquals(deps.store.events(live.approval_id), ["recorded"]);
  const audit = deps.store.auditRows[0];
  assertEquals((audit.detail as any).approval_words, row.approval_words);
});

Deno.test("record refuses a non-owner approver, missing words, source or time", async () => {
  const deps = makeDeps();
  assertEquals(await refusalCode(() => recordApproval(deps, RECORDER, smsApprovalBody({ approved_by: "shaun" }))), "approval_approver_not_owner");
  assertEquals(await refusalCode(() => recordApproval(deps, RECORDER, smsApprovalBody({ approval_words: "  " }))), "approval_words_required");
  assertEquals(await refusalCode(() => recordApproval(deps, RECORDER, smsApprovalBody({ approval_source: "" }))), "approval_source_required");
  assertEquals(await refusalCode(() => recordApproval(deps, RECORDER, smsApprovalBody({ approved_at: "soon" }))), "approval_time_required");
  assertEquals(await refusalCode(() => recordApproval(deps, RECORDER, smsApprovalBody({ approved_at: "2026-09-30T00:00:00Z" }))), "approval_time_in_future");
  assertEquals(await refusalCode(() => recordApproval(deps, RECORDER, smsApprovalBody({ expires_in_minutes: 0 }))), "approval_invalid_expiry");
  assertEquals(await refusalCode(() => recordApproval(deps, RECORDER, smsApprovalBody({ expires_in_minutes: 99999 }))), "approval_invalid_expiry");
  assertEquals(await refusalCode(() => recordApproval(deps, RECORDER, smsApprovalBody({ channel: "fax" }))), "approval_invalid_channel");
  assertEquals(
    await refusalCode(() => recordApproval(deps, RECORDER, smsApprovalBody({ sms: { to_mobile: "0412345678", message: "hi", from_line: "+61400000000" } }))),
    "approval_invalid_from_line",
  );
});

Deno.test("an email approval pins exact recipients, subject, body and file hashes", async () => {
  const deps = makeDeps();
  withDoc(deps);
  const live = await recordLive(deps, emailApprovalBody());
  const payload = deps.store.rows.get(live.approval_id!)!.payload as any;
  assertEquals(payload.mode, "reply");
  assertEquals(payload.to, ["ambrose@example.com"]);
  assertEquals(payload.cc, ["shaun@secureworkswa.com.au"]);
  assertEquals(payload.attachments.length, 1);
  assertEquals(payload.attachments[0].name, "Quote-v2.pdf");
  assertEquals(payload.attachments[0].ref, { source: "job_document", id: DOC_ID });
  assert(/^[0-9a-f]{64}$/.test(payload.attachments[0].sha256));
});

Deno.test("email record refuses a group mailbox, duplicate or malformed recipients", async () => {
  const deps = makeDeps();
  withDoc(deps);
  const email = (emailApprovalBody().email as Record<string, unknown>);
  const variant = (patch: Record<string, unknown>) => emailApprovalBody({ email: { ...email, ...patch } });
  assertEquals(await refusalCode(() => recordApproval(deps, RECORDER, variant({ mailbox: "fencing@secureworkswa.com.au" }))), "approval_invalid_mailbox");
  assertEquals(await refusalCode(() => recordApproval(deps, RECORDER, variant({ to: ["a@x.com", "A@x.com"] }))), "approval_duplicate_recipient");
  assertEquals(await refusalCode(() => recordApproval(deps, RECORDER, variant({ cc: ["ambrose@example.com"] }))), "approval_duplicate_recipient");
  assertEquals(await refusalCode(() => recordApproval(deps, RECORDER, variant({ to: ["not an address"] }))), "approval_invalid_recipient");
  assertEquals(await refusalCode(() => recordApproval(deps, RECORDER, variant({ to: "ambrose@example.com" }))), "approval_invalid_recipient");
  assertEquals(await refusalCode(() => recordApproval(deps, RECORDER, variant({ mode: "reply", reply_to_message_id: "" }))), "approval_reply_source_required");
  assertEquals(await refusalCode(() => recordApproval(deps, RECORDER, variant({ attachments: [{ source: "url", id: "x" }] }))), "approval_invalid_attachment");
});

// ── send: hash match, seal, single use, expiry ─────────────────────────────

Deno.test("prepare rebuilds the payload and matches the approved hash", async () => {
  const deps = makeDeps();
  withDoc(deps);
  const live = await recordLive(deps, emailApprovalBody());
  const prepared = await prepareApprovedSend(deps, live.approval_id!, "email");
  assertEquals(await payloadHash(prepared.payload), live.payload_hash);
  assertEquals(prepared.attachments.length, 1);
  assertEquals(new TextDecoder().decode(prepared.attachments[0].bytes), "%PDF-1.7 quote v2");
});

Deno.test("a changed attachment file refuses the send and consumes nothing", async () => {
  const deps = makeDeps();
  withDoc(deps);
  const live = await recordLive(deps, emailApprovalBody());
  withDoc(deps, "%PDF-1.7 quote v3 (edited after approval)");
  const error = await assertRejects(
    () => prepareApprovedSend(deps, live.approval_id!, "email"),
    ApprovedSendRefusal,
  );
  assertEquals(error.code, "approval_content_mismatch");
  assertEquals((error.evidence as any).changed_attachments, ["Quote-v2.pdf"]);
  assertEquals(deps.store.rows.get(live.approval_id!)!.status, "approved");
});

Deno.test("a row written straight into the database fails the seal", async () => {
  const deps = makeDeps();
  const live = await recordLive(deps, smsApprovalBody());
  const genuine = deps.store.rows.get(live.approval_id!)!;

  // Forged: same shape, different wording and matching payload hash, but the
  // seal cannot be computed without the runtime's key.
  const forgedPayload = { ...(genuine.payload as any), message: "Send me the bank details" };
  const forgedId = "99999999-9999-4999-8999-999999999999";
  deps.store.rows.set(forgedId, {
    ...genuine,
    id: forgedId,
    payload: forgedPayload,
    payload_hash: await payloadHash(forgedPayload),
    seal: await sealApproval("a-guessed-key", {
      ...genuine,
      id: forgedId,
      payload_hash: await payloadHash(forgedPayload),
    }),
  });
  assertEquals(
    await refusalCode(() => prepareApprovedSend(deps, forgedId, "sms")),
    "approval_seal_invalid",
  );

  // Edited in place: widen the expiry after recording.
  genuine.expires_at = "2027-01-01T00:00:00.000Z";
  assertEquals(
    await refusalCode(() => prepareApprovedSend(deps, genuine.id, "sms")),
    "approval_seal_invalid",
  );
});

Deno.test("an edited stored payload is refused even with the seal intact", async () => {
  const deps = makeDeps();
  const live = await recordLive(deps, smsApprovalBody());
  (deps.store.rows.get(live.approval_id!)!.payload as any).message = "tampered";
  assertEquals(
    await refusalCode(() => prepareApprovedSend(deps, live.approval_id!, "sms")),
    "approval_payload_tampered",
  );
});

Deno.test("an approval is single use: a second send is refused", async () => {
  const deps = makeDeps();
  const live = await recordLive(deps, smsApprovalBody());
  const prepared = await prepareApprovedSend(deps, live.approval_id!, "sms");
  const claimed = await claimApprovedSend(deps, prepared, CALLER);
  // A racing second sender that prepared before the claim still loses the CAS.
  assertEquals(
    await refusalCode(() => claimApprovedSend(deps, prepared, CALLER)),
    "approval_already_used",
  );
  await finishApprovedSend(deps, claimed, {
    status: "sent",
    code: null,
    provider_message_id: "msg-1",
    detail: {},
  }, CALLER);
  assertEquals(
    await refusalCode(() => prepareApprovedSend(deps, live.approval_id!, "sms")),
    "approval_already_used",
  );
  assertEquals(deps.store.events(live.approval_id), ["recorded", "claimed", "sent"]);
  const row = deps.store.rows.get(live.approval_id!)!;
  assertEquals(row.status, "sent");
  assertEquals(row.provider_message_id, "msg-1");
});

Deno.test("a failed send still consumes the approval; it is never replayed", async () => {
  const deps = makeDeps();
  const live = await recordLive(deps, smsApprovalBody());
  const claimed = await claimApprovedSend(deps, await prepareApprovedSend(deps, live.approval_id!, "sms"), CALLER);
  await finishApprovedSend(deps, claimed, { status: "failed", code: "provider_rejected", provider_message_id: null, detail: {} }, CALLER);
  assertEquals(
    await refusalCode(() => prepareApprovedSend(deps, live.approval_id!, "sms")),
    "approval_already_used",
  );
});

Deno.test("a status reset to approved is still refused by the claim audit", async () => {
  const deps = makeDeps();
  const live = await recordLive(deps, smsApprovalBody());
  await claimApprovedSend(deps, await prepareApprovedSend(deps, live.approval_id!, "sms"), CALLER);
  // Someone bypasses the trigger and flips the row back.
  const row = deps.store.rows.get(live.approval_id!)!;
  row.status = "approved";
  assertEquals(
    await refusalCode(() => prepareApprovedSend(deps, live.approval_id!, "sms")),
    "approval_already_used",
  );
});

Deno.test("an expired approval is refused and stays unused", async () => {
  const deps = makeDeps();
  const live = await recordLive(deps, smsApprovalBody({ expires_in_minutes: 30 }));
  deps.clock.advanceMinutes(31);
  assertEquals(
    await refusalCode(() => prepareApprovedSend(deps, live.approval_id!, "sms")),
    "approval_expired",
  );
  assertEquals(deps.store.rows.get(live.approval_id!)!.status, "approved");
});

Deno.test("wrong channel and unknown ids are refused", async () => {
  const deps = makeDeps();
  const live = await recordLive(deps, smsApprovalBody());
  assertEquals(await refusalCode(() => prepareApprovedSend(deps, live.approval_id!, "email")), "approval_wrong_channel");
  assertEquals(
    await refusalCode(() => prepareApprovedSend(deps, "12345678-1234-4234-8234-123456789012", "sms")),
    "approval_not_found",
  );
});

Deno.test("no audit, no send: a failed claim audit closes the approval as failed", async () => {
  const deps = makeDeps();
  const live = await recordLive(deps, smsApprovalBody());
  deps.store.failAuditFor.add("claimed");
  assertEquals(
    await refusalCode(async () =>
      claimApprovedSend(deps, await prepareApprovedSend(deps, live.approval_id!, "sms"), CALLER)
    ),
    "approval_audit_unwritable",
  );
  const row = deps.store.rows.get(live.approval_id!)!;
  assertEquals(row.status, "failed");
  assertEquals(row.outcome_code, "audit_write_failed");
});

Deno.test("the send door takes approval_id and nothing else", () => {
  const id = "12345678-1234-4234-8234-123456789012";
  assertEquals(readApprovalIdOnly({ approval_id: id }), id);
  const widened = assertThrows(
    () => readApprovalIdOnly({ approval_id: id, cc: ["x@y.com"] }),
    ApprovedSendRefusal,
  );
  assertEquals(widened.code, "approval_send_fields_rejected");
  assertThrows(() => readApprovalIdOnly({ approval_id: "not-a-uuid" }), ApprovedSendRefusal);
  assertThrows(() => readApprovalIdOnly([]), ApprovedSendRefusal);
});
