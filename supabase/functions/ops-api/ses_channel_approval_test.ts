// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
//
// Hostile probes for the channel approval path. The suite is written around one
// question: can anything that is NOT the bound operator, acting freshly and
// unambiguously on one card, cause an approval? Every answer must be no.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  deriveSesChannelTotpSecret,
  normaliseSesChannelSenderId,
  parseSesChannelApprovalMessage,
  parseSesChannelOperatorBindings,
  resolveSesChannelOperatorBinding,
  SES_CHANNEL_APPROVAL_CONTRACT_VERSION,
  SES_CHANNEL_APPROVAL_ENABLED_ACTS,
  SES_CHANNEL_APPROVAL_MAX_MESSAGE_AGE_MS,
  SES_CHANNEL_TOTP_STEP_SECONDS,
  type SesChannelApprovalDeps,
  sesChannelBase32Encode,
  sesChannelEnrolmentAction,
  type SesChannelOperatorBinding,
  sesChannelSenderFingerprint,
  sesChannelTotpCode,
  sesChannelTotpTimeStep,
  submitSesChannelApprovalAction,
  verifySesChannelTotp,
} from "./ses_channel_approval.ts";
import { canRecordSesApproval } from "./ses_review_cockpit.ts";
import { SesActionError } from "./ses_reporting_actions.ts";

const OPERATOR_USER_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER_USER_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const JOB_ID = "cccccccc-3333-4333-8333-cccccccccccc";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const ROOT_SECRET = "test-root-secret-not-a-production-value";
// A synthetic sender token. Deliberately not phone-shaped: no real number,
// nobody's number, ever reaches a committed file.
const SENDER_ID = "test-sender-token-alpha";
const NOW_MS = Date.UTC(2026, 7, 7, 3, 0, 0);

async function testBinding(): Promise<SesChannelOperatorBinding> {
  return {
    channel: "whatsapp",
    sender_fingerprint: await sesChannelSenderFingerprint(
      "whatsapp",
      SENDER_ID,
    ),
    operator_user_id: OPERATOR_USER_ID,
    label: "captain",
  };
}

async function bindingsJson(): Promise<string> {
  return JSON.stringify([await testBinding()]);
}

async function liveCode(atMs = NOW_MS): Promise<string> {
  const secret = await deriveSesChannelTotpSecret(
    ROOT_SECRET,
    await testBinding(),
  );
  return await sesChannelTotpCode(secret, sesChannelTotpTimeStep(atMs));
}

// ── fake client ─────────────────────────────────────────────────────────────

interface FakeState {
  users: Record<string, unknown>[];
  jobs: Record<string, unknown>[];
  invoices: Record<string, unknown>[];
  approvals: {
    id: string;
    job_id: string;
    decided_at: string;
    evidence_refs: any[];
  }[];
  errors?: Partial<Record<string, string>>;
}

function containsAll(candidate: any, probe: Record<string, unknown>): boolean {
  return Object.entries(probe).every(([key, value]) =>
    candidate && typeof candidate === "object" &&
    JSON.stringify(candidate[key]) === JSON.stringify(value)
  );
}

function fakeClient(state: FakeState): any {
  return {
    from(table: string) {
      const error = state.errors?.[table]
        ? { message: state.errors[table] }
        : null;
      let rows: Record<string, unknown>[] = table === "users"
        ? state.users
        : table === "jobs"
        ? state.jobs
        : table === "xero_invoices"
        ? state.invoices
        : table === "makesafe_revision_approvals"
        ? state.approvals as any
        : [];
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          rows = rows.filter((row) => String(row[column]) === String(value));
          return builder;
        },
        contains: (_column: string, probes: Record<string, unknown>[]) => {
          rows = rows.filter((row) =>
            (row as any).evidence_refs?.some((ref: any) =>
              probes.every((probe) => containsAll(ref, probe))
            )
          );
          return builder;
        },
        limit: (count: number) =>
          Promise.resolve({ data: error ? null : rows.slice(0, count), error }),
        maybeSingle: () =>
          Promise.resolve({ data: error ? null : rows[0] ?? null, error }),
        then: (resolve: any) => resolve({ data: error ? null : rows, error }),
      };
      return builder;
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
    storage: { from: () => ({}) },
  };
}

function baseState(): FakeState {
  return {
    users: [{
      id: OPERATOR_USER_ID,
      email: "operator@example.test",
      role: "admin",
    }],
    jobs: [{ id: JOB_ID, job_number: "SWMS-260000" }],
    invoices: [{ invoice_number: "INV-9000", job_id: JOB_ID }],
    approvals: [],
  };
}

async function deps(
  overrides: Partial<SesChannelApprovalDeps> = {},
  calls: { auth?: any; args?: any }[] = [],
): Promise<SesChannelApprovalDeps> {
  return {
    env: { bindings_raw: await bindingsJson(), root_secret: ROOT_SECRET },
    now: () => NOW_MS,
    approveInvoice: async (auth, args) => {
      calls.push({ auth, args });
      return { approval: { id: "approval-1" } };
    },
    ...overrides,
  };
}

const apiKeyAuth = { mode: "api_key" as const, user: null };

async function request(overrides: Record<string, unknown> = {}) {
  return {
    org_id: ORG_ID,
    channel: "whatsapp",
    sender_id: SENDER_ID,
    message_id: "wamid.TEST-0001",
    message_text: `APPROVE SWMS-260000 ${await liveCode()}`,
    message_sent_at: new Date(NOW_MS - 5_000).toISOString(),
    ...overrides,
  };
}

async function refusalCode(
  fn: () => Promise<unknown>,
): Promise<{ code: string; status: number; fact: string }> {
  const error = await assertRejects(fn, SesActionError);
  const refusal = (error as SesActionError).refusal as any;
  return {
    code: String(refusal.code || ""),
    status: (error as SesActionError).status,
    fact: String(refusal.fact || ""),
  };
}

// ── the existing gate is untouched ──────────────────────────────────────────

Deno.test("the existing operator gate still refuses every machine caller", () => {
  const clean = { clean: true, approval_band: "clean", blockers: [] } as any;
  for (const mode of ["api_key", "routine"] as const) {
    const verdict = canRecordSesApproval({ mode } as any, clean);
    assertEquals(verdict.allowed, false);
    assertStringIncludes(verdict.refusal!, "identified SES operator session");
  }
  // And an identified operator with no class and no admin role is still refused
  // on a non-clean docket, exactly as before this path existed.
  assertEquals(
    canRecordSesApproval(
      {
        mode: "jwt",
        user_id: OPERATOR_USER_ID,
        role: "trade",
        operator_class: null,
      },
      { clean: false, approval_band: "captain_only", blockers: [] } as any,
    ).allowed,
    false,
  );
});

// ── message parsing ─────────────────────────────────────────────────────────

Deno.test("a well formed message reads as one act, one card and one code", () => {
  const intent = parseSesChannelApprovalMessage("APPROVE SWMS-260000 123456");
  assertEquals(intent.act, "approve_invoice");
  assertEquals(intent.act_ambiguous, false);
  assertEquals(intent.card_references, ["SWMS-260000"]);
  assertEquals(intent.totp_code, "123456");
});

Deno.test("a card number's own six digits are never mistaken for a code", () => {
  // SWMS-260000 ends in six digits. Without stripping card references first
  // this message would silently carry "260000" as its approval code.
  const intent = parseSesChannelApprovalMessage("APPROVE SWMS-260000");
  assertEquals(intent.totp_code, null);
  assertEquals(intent.totp_ambiguous, false);
  assertEquals(intent.card_references, ["SWMS-260000"]);
});

Deno.test("the Captain's real conversational assent is not an instruction", () => {
  // His actual words, with both cards named. Three independent guards refuse
  // it: two cards, no code, and (in the action) a stale timestamp.
  const intent = parseSesChannelApprovalMessage(
    "Cool they are both approved then $300 for double storey report SWMS-260000 and SWMS-260001",
  );
  assertEquals(intent.card_references.length, 2);
  assertEquals(intent.totp_code, null);
});

Deno.test("two command words refuse rather than guessing which was meant", () => {
  const intent = parseSesChannelApprovalMessage(
    "APPROVE and SEND SWMS-260000 123456",
  );
  assertEquals(intent.act, null);
  assertEquals(intent.act_ambiguous, true);
});

Deno.test("two candidate codes refuse rather than trying each", () => {
  const intent = parseSesChannelApprovalMessage(
    "APPROVE SWMS-260000 123456 654321",
  );
  assertEquals(intent.totp_code, null);
  assertEquals(intent.totp_ambiguous, true);
});

// ── sender fingerprinting ───────────────────────────────────────────────────

Deno.test("phone forms normalise together and unlike senders never collide", () => {
  assertEquals(normaliseSesChannelSenderId("0400 000 000"), "61400000000");
  assertEquals(normaliseSesChannelSenderId("+61 400 000 000"), "61400000000");
  assertEquals(normaliseSesChannelSenderId("(08) 9000-0000"), "61890000000");
  // An email-shaped sender must not be read as a phone number just because it
  // contains digits.
  assertEquals(
    normaliseSesChannelSenderId("Agent007@Example.Test"),
    "agent007@example.test",
  );
  assert(
    normaliseSesChannelSenderId("0400000000") !==
      normaliseSesChannelSenderId("0400000001"),
  );
});

Deno.test("a fingerprint is channel scoped and never reveals the sender", async () => {
  const whatsapp = await sesChannelSenderFingerprint("whatsapp", SENDER_ID);
  const sms = await sesChannelSenderFingerprint("sms", SENDER_ID);
  assert(/^[0-9a-f]{64}$/.test(whatsapp));
  assert(whatsapp !== sms, "the same sender on two channels is two bindings");
  assertEquals(await sesChannelSenderFingerprint("whatsapp", ""), "");
});

// ── binding parsing ─────────────────────────────────────────────────────────

Deno.test("a binding that cannot be fully read is not partly trusted", async () => {
  const good = await testBinding();
  const raw = JSON.stringify([
    good,
    { ...good, channel: "telegram" }, // unsupported channel
    { ...good, sender_fingerprint: "not-a-hash" },
    { ...good, operator_user_id: "not-a-uuid" },
    { ...good, label: "" },
    "nonsense",
    null,
  ]);
  assertEquals(parseSesChannelOperatorBindings(raw).length, 1);
  assertEquals(parseSesChannelOperatorBindings("{not json").length, 0);
  assertEquals(parseSesChannelOperatorBindings("").length, 0);
  assertEquals(
    parseSesChannelOperatorBindings('{"channel":"whatsapp"}').length,
    0,
  );
});

Deno.test("two bindings for one sender resolve to nobody", async () => {
  const binding = await testBinding();
  assertEquals(
    resolveSesChannelOperatorBinding(
      [binding, { ...binding, operator_user_id: OTHER_USER_ID }],
      "whatsapp",
      binding.sender_fingerprint,
    ),
    null,
  );
  assertEquals(
    resolveSesChannelOperatorBinding(
      [binding],
      "sms",
      binding.sender_fingerprint,
    ),
    null,
  );
  assertEquals(
    resolveSesChannelOperatorBinding([binding], "whatsapp", ""),
    null,
  );
});

// ── TOTP ────────────────────────────────────────────────────────────────────

Deno.test("a live code verifies and names the step it spent", async () => {
  const secret = await deriveSesChannelTotpSecret(
    ROOT_SECRET,
    await testBinding(),
  );
  const step = sesChannelTotpTimeStep(NOW_MS);
  const code = await sesChannelTotpCode(secret, step);
  assert(/^\d{6}$/.test(code));
  assertEquals(
    (await verifySesChannelTotp(secret, code, NOW_MS))?.time_step,
    step,
  );
});

Deno.test("a wrong, malformed or long expired code never verifies", async () => {
  const secret = await deriveSesChannelTotpSecret(
    ROOT_SECRET,
    await testBinding(),
  );
  assertEquals(
    await verifySesChannelTotp(secret, "000000", NOW_MS - 10 ** 9),
    null,
  );
  assertEquals(await verifySesChannelTotp(secret, "12345", NOW_MS), null);
  assertEquals(await verifySesChannelTotp(secret, "abcdef", NOW_MS), null);
  const stale = await sesChannelTotpCode(
    secret,
    sesChannelTotpTimeStep(NOW_MS) - 10,
  );
  assertEquals(await verifySesChannelTotp(secret, stale, NOW_MS), null);
});

Deno.test("seeds are per binding, so re-pointing a sender invalidates the old seed", async () => {
  const binding = await testBinding();
  const mine = await deriveSesChannelTotpSecret(ROOT_SECRET, binding);
  const reassigned = await deriveSesChannelTotpSecret(ROOT_SECRET, {
    ...binding,
    operator_user_id: OTHER_USER_ID,
  });
  const rotated = await deriveSesChannelTotpSecret("a-different-root", binding);
  const step = sesChannelTotpTimeStep(NOW_MS);
  assert(
    await sesChannelTotpCode(mine, step) !==
      await sesChannelTotpCode(reassigned, step),
  );
  assert(
    await sesChannelTotpCode(mine, step) !==
      await sesChannelTotpCode(rotated, step),
  );
  assert(/^[A-Z2-7]+$/.test(sesChannelBase32Encode(mine)));
});

// ── enrolment ───────────────────────────────────────────────────────────────

Deno.test("only the account holder's own session can read their seed", async () => {
  const env = { bindings_raw: await bindingsJson(), root_secret: ROOT_SECRET };

  // The privileged ops key must never read a seed; that would turn the key
  // into approval authority by the back door.
  assertEquals(
    (await refusalCode(async () => sesChannelEnrolmentAction(apiKeyAuth, env)))
      .code,
    "channel_enrolment_requires_session",
  );

  // A channel-derived identity cannot bootstrap itself a fresh seed either.
  assertEquals(
    (await refusalCode(async () =>
      sesChannelEnrolmentAction(
        {
          mode: "jwt",
          user: {
            id: OPERATOR_USER_ID,
            email: "operator@example.test",
            role: "admin",
          },
          identity_provenance: "bound_channel_totp",
        },
        env,
      )
    )).code,
    "channel_enrolment_requires_session",
  );

  // Another admin gets nothing: enrolment is scoped to the caller's own id.
  assertEquals(
    (await refusalCode(async () =>
      sesChannelEnrolmentAction(
        {
          mode: "jwt",
          user: {
            id: OTHER_USER_ID,
            email: "other@example.test",
            role: "admin",
          },
        },
        env,
      )
    )).code,
    "channel_binding_not_enrolled",
  );

  const issued = await sesChannelEnrolmentAction(
    {
      mode: "jwt",
      user: {
        id: OPERATOR_USER_ID,
        email: "operator@example.test",
        role: "admin",
      },
    },
    env,
  );
  assertEquals(issued.enrolment.length, 1);
  assertStringIncludes(issued.enrolment[0]!.otpauth_uri, "otpauth://totp/");
  assertStringIncludes(issued.enrolment[0]!.otpauth_uri, "period=30");
  assertEquals(
    issued.enrolment[0]!.contract,
    SES_CHANNEL_APPROVAL_CONTRACT_VERSION,
  );
  // The URI must carry a label, never a name, number or email.
  assert(!issued.enrolment[0]!.otpauth_uri.includes("@"));
});

// ── the action: every way in must fail closed ───────────────────────────────

Deno.test("the relay key is transport, never authority", async () => {
  const client = fakeClient(baseState());
  for (const mode of ["routine", "jwt"] as const) {
    assertEquals(
      (await refusalCode(async () =>
        submitSesChannelApprovalAction(
          client,
          { mode, user: null },
          await request(),
          await deps(),
        )
      )).code,
      "channel_transport_not_privileged",
    );
  }
});

Deno.test("an unconfigured path approves nothing", async () => {
  const client = fakeClient(baseState());
  for (
    const env of [
      { bindings_raw: null, root_secret: ROOT_SECRET },
      { bindings_raw: await bindingsJson(), root_secret: null },
      { bindings_raw: "[]", root_secret: ROOT_SECRET },
    ]
  ) {
    assertEquals(
      (await refusalCode(async () =>
        submitSesChannelApprovalAction(
          client,
          apiKeyAuth,
          await request(),
          await deps({ env }),
        )
      )).code,
      "channel_binding_not_configured",
    );
  }
});

Deno.test("an unbound sender is refused before any card is looked up", async () => {
  const state = baseState();
  const client = fakeClient(state);
  const refusal = await refusalCode(async () =>
    submitSesChannelApprovalAction(
      client,
      apiKeyAuth,
      await request({ sender_id: "test-sender-token-beta" }),
      await deps(),
    )
  );
  assertEquals(refusal.code, "channel_sender_not_bound");
  assertEquals(refusal.status, 403);
});

Deno.test("a message with no id or no readable timestamp is refused", async () => {
  const client = fakeClient(baseState());
  assertEquals(
    (await refusalCode(async () =>
      submitSesChannelApprovalAction(
        client,
        apiKeyAuth,
        await request({ message_id: "  " }),
        await deps(),
      )
    )).code,
    "channel_message_id_missing",
  );
  assertEquals(
    (await refusalCode(async () =>
      submitSesChannelApprovalAction(
        client,
        apiKeyAuth,
        await request({ message_sent_at: "not a date" }),
        await deps(),
      )
    )).code,
    "channel_message_timestamp_missing",
  );
});

Deno.test("a stale or future dated message is not a live instruction", async () => {
  const client = fakeClient(baseState());
  for (
    const sentAt of [
      new Date(NOW_MS - SES_CHANNEL_APPROVAL_MAX_MESSAGE_AGE_MS - 1000)
        .toISOString(),
      new Date(NOW_MS + SES_CHANNEL_APPROVAL_MAX_MESSAGE_AGE_MS + 1000)
        .toISOString(),
    ]
  ) {
    assertEquals(
      (await refusalCode(async () =>
        submitSesChannelApprovalAction(
          client,
          apiKeyAuth,
          await request({ message_sent_at: sentAt }),
          await deps(),
        )
      )).code,
      "channel_message_stale",
    );
  }
});

Deno.test("an unscoped or double scoped message approves nothing", async () => {
  const client = fakeClient(baseState());
  const code = await liveCode();
  assertEquals(
    (await refusalCode(async () =>
      submitSesChannelApprovalAction(
        client,
        apiKeyAuth,
        await request({ message_text: `APPROVE ${code}` }),
        await deps(),
      )
    )).code,
    "channel_card_reference_missing",
  );
  assertEquals(
    (await refusalCode(async () =>
      submitSesChannelApprovalAction(
        client,
        apiKeyAuth,
        await request({
          message_text: `APPROVE SWMS-260000 and SWMS-260001 ${code}`,
        }),
        await deps(),
      )
    )).code,
    "channel_card_reference_ambiguous",
  );
});

Deno.test("SEND IT is recognised and named, never silently half done", async () => {
  const client = fakeClient(baseState());
  const refusal = await refusalCode(async () =>
    submitSesChannelApprovalAction(
      client,
      apiKeyAuth,
      await request({ message_text: `SEND SWMS-260000 ${await liveCode()}` }),
      await deps(),
    )
  );
  assertEquals(refusal.code, "channel_act_not_enabled");
  assertStringIncludes(refusal.fact, "not wired");
  assertEquals([...SES_CHANNEL_APPROVAL_ENABLED_ACTS], ["approve_invoice"]);
});

Deno.test("conversation is not an instruction", async () => {
  const client = fakeClient(baseState());
  assertEquals(
    (await refusalCode(async () =>
      submitSesChannelApprovalAction(
        client,
        apiKeyAuth,
        await request({
          message_text: `SWMS-260000 looks fine ${await liveCode()}`,
        }),
        await deps(),
      )
    )).code,
    "channel_act_not_recognised",
  );
});

Deno.test("possession of the phone alone approves nothing", async () => {
  // The enrolled sender, a fresh message, one card — and no code. This is
  // exactly the "a message arrived in this chat" case, and it must refuse.
  const client = fakeClient(baseState());
  const refusal = await refusalCode(async () =>
    submitSesChannelApprovalAction(
      client,
      apiKeyAuth,
      await request({ message_text: "APPROVE SWMS-260000" }),
      await deps(),
    )
  );
  assertEquals(refusal.code, "channel_code_missing");
  assertEquals(refusal.status, 403);

  assertEquals(
    (await refusalCode(async () =>
      submitSesChannelApprovalAction(
        client,
        apiKeyAuth,
        await request({ message_text: "APPROVE SWMS-260000 000000" }),
        await deps(),
      )
    )).code,
    "channel_code_invalid",
  );
});

Deno.test("the same message never approves twice", async () => {
  const state = baseState();
  const client = fakeClient(state);
  const calls: { auth?: any; args?: any }[] = [];
  const payload = await request();

  const first: any = await submitSesChannelApprovalAction(
    client,
    apiKeyAuth,
    payload,
    await deps({}, calls),
  );
  assertEquals(calls.length, 1);

  // Persist the act exactly as the approval RPC would.
  state.approvals.push({
    id: "approval-1",
    job_id: JOB_ID,
    decided_at: new Date(NOW_MS).toISOString(),
    evidence_refs: [first.channel_approval.operator_act],
  });

  const replay = await refusalCode(async () =>
    submitSesChannelApprovalAction(
      client,
      apiKeyAuth,
      payload,
      await deps({}, calls),
    )
  );
  assertEquals(replay.code, "channel_message_already_recorded");
  assertEquals(calls.length, 1, "the replay must not reach the approve action");
});

Deno.test("a spent code cannot authorise a second message", async () => {
  const state = baseState();
  const client = fakeClient(state);
  const calls: { auth?: any; args?: any }[] = [];
  const first: any = await submitSesChannelApprovalAction(
    client,
    apiKeyAuth,
    await request(),
    await deps({}, calls),
  );
  state.approvals.push({
    id: "approval-1",
    job_id: JOB_ID,
    decided_at: new Date(NOW_MS).toISOString(),
    evidence_refs: [first.channel_approval.operator_act],
  });

  // A different message id, same still-valid code, inside the same step.
  const refusal = await refusalCode(async () =>
    submitSesChannelApprovalAction(
      client,
      apiKeyAuth,
      await request({ message_id: "wamid.TEST-0002" }),
      await deps({}, calls),
    )
  );
  assertEquals(refusal.code, "channel_code_already_used");
  assertEquals(calls.length, 1);
});

Deno.test("an unreadable replay guard refuses rather than assuming no repeat", async () => {
  const state = baseState();
  state.errors = { makesafe_revision_approvals: "connection reset" };
  const calls: { auth?: any; args?: any }[] = [];
  const refusal = await refusalCode(async () =>
    submitSesChannelApprovalAction(
      fakeClient(state),
      apiKeyAuth,
      await request(),
      await deps({}, calls),
    )
  );
  assertEquals(refusal.code, "channel_replay_guard_unreadable");
  assertEquals(refusal.status, 503);
  assertEquals(calls.length, 0);
});

Deno.test("a card that does not resolve to exactly one job approves nothing", async () => {
  const calls: { auth?: any; args?: any }[] = [];
  const missing = baseState();
  missing.jobs = [];
  assertEquals(
    (await refusalCode(async () =>
      submitSesChannelApprovalAction(
        fakeClient(missing),
        apiKeyAuth,
        await request(),
        await deps({}, calls),
      )
    )).code,
    "channel_card_not_found",
  );

  const doubled = baseState();
  doubled.jobs = [
    { id: JOB_ID, job_number: "SWMS-260000" },
    { id: OTHER_USER_ID, job_number: "SWMS-260000" },
  ];
  assertEquals(
    (await refusalCode(async () =>
      submitSesChannelApprovalAction(
        fakeClient(doubled),
        apiKeyAuth,
        await request(),
        await deps({}, calls),
      )
    )).code,
    "channel_card_not_found",
  );

  // An invoice with no linked card is not a card reference either.
  const unlinked = baseState();
  unlinked.invoices = [{ invoice_number: "INV-9000", job_id: null }];
  assertEquals(
    (await refusalCode(async () =>
      submitSesChannelApprovalAction(
        fakeClient(unlinked),
        apiKeyAuth,
        await request({ message_text: `APPROVE INV-9000 ${await liveCode()}` }),
        await deps({}, calls),
      )
    )).code,
    "channel_card_not_found",
  );
  assertEquals(calls.length, 0);
});

Deno.test("a binding naming a missing account establishes no operator", async () => {
  const state = baseState();
  state.users = [];
  const calls: { auth?: any; args?: any }[] = [];
  assertEquals(
    (await refusalCode(async () =>
      submitSesChannelApprovalAction(
        fakeClient(state),
        apiKeyAuth,
        await request(),
        await deps({}, calls),
      )
    )).code,
    "channel_operator_unresolved",
  );
  assertEquals(calls.length, 0);
});

// ── the one accepted path ───────────────────────────────────────────────────

Deno.test("a bound sender with a live code acts as the bound operator", async () => {
  const calls: { auth?: any; args?: any }[] = [];
  const result: any = await submitSesChannelApprovalAction(
    fakeClient(baseState()),
    apiKeyAuth,
    await request(),
    await deps({}, calls),
  );

  assertEquals(calls.length, 1);
  const { auth, args } = calls[0]!;

  // The identity is the bound operator, loaded from the database. The relay
  // supplied no user, no role and no id.
  assertEquals(auth.mode, "jwt");
  assertEquals(auth.user.id, OPERATOR_USER_ID);
  assertEquals(auth.user.role, "admin");
  // Provenance is recorded so nobody reads mode:"jwt" as a verified session.
  assertEquals(auth.identity_provenance, "bound_channel_totp");

  // Scoped to the resolved card, and never silently authorising money.
  assertEquals(args.job_id, JOB_ID);
  assertEquals(args.includes_authorise, false);

  // The operator act carries his message id and is the audit trail.
  const act = args.evidence_refs[0];
  assertEquals(act.kind, "ses_channel_operator_act");
  assertEquals(act.message_id, "wamid.TEST-0001");
  assertEquals(act.operator_user_id, OPERATOR_USER_ID);
  assertEquals(act.act, "approve_invoice");
  assertEquals(act.card_reference, "SWMS-260000");
  assertEquals(act.totp_time_step, sesChannelTotpTimeStep(NOW_MS));
  // No raw sender id anywhere in the stored act.
  assert(!JSON.stringify(act).includes(SENDER_ID));
  assertEquals(result.channel_approval.job_number, "SWMS-260000");
});

Deno.test("an invoice number is an equally exact card reference", async () => {
  const calls: { auth?: any; args?: any }[] = [];
  await submitSesChannelApprovalAction(
    fakeClient(baseState()),
    apiKeyAuth,
    await request({ message_text: `APPROVE INV-9000 ${await liveCode()}` }),
    await deps({}, calls),
  );
  assertEquals(calls[0]!.args.job_id, JOB_ID);
  assertEquals(calls[0]!.args.evidence_refs[0].card_reference, "INV-9000");
});

Deno.test("a code from one step earlier still works and is recorded at its own step", async () => {
  // Clock skew between his phone and the edge must not cost him an approval,
  // but the SPENT step must be the one that actually matched, or the single
  // use guard would protect the wrong coordinate.
  const earlier = NOW_MS - SES_CHANNEL_TOTP_STEP_SECONDS * 1000;
  const calls: { auth?: any; args?: any }[] = [];
  await submitSesChannelApprovalAction(
    fakeClient(baseState()),
    apiKeyAuth,
    await request({
      message_text: `APPROVE SWMS-260000 ${await liveCode(earlier)}`,
    }),
    await deps({}, calls),
  );
  assertEquals(
    calls[0]!.args.evidence_refs[0].totp_time_step,
    sesChannelTotpTimeStep(earlier),
  );
});

Deno.test("the downstream refusal is the cockpit's, unchanged", async () => {
  // What may be approved is not this path's question. When the shared approve
  // action refuses, the message carries that refusal through untouched.
  const calls: { auth?: any; args?: any }[] = [];
  const payload = await request();
  const refusingDeps: SesChannelApprovalDeps = {
    ...(await deps({}, calls)),
    approveInvoice: async () => {
      throw new SesActionError(409, {
        state: "refused",
        fact:
          "This docket is not mechanically clean, so Captain approval is required.",
      });
    },
  };
  const error = await assertRejects(
    async () =>
      await submitSesChannelApprovalAction(
        fakeClient(baseState()),
        apiKeyAuth,
        payload,
        refusingDeps,
      ),
    SesActionError,
  );
  assertStringIncludes(
    (error as SesActionError).refusal.fact,
    "not mechanically clean",
  );
});
