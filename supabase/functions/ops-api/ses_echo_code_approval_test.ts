import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  issueSesChannelApprovalAction,
  SES_ECHO_CODE_LOCKOUT_THRESHOLD,
  submitSesEchoCodeApprovalAction,
} from "./ses_echo_code_approval.ts";
import { sesChannelSenderFingerprint } from "./ses_channel_approval.ts";
import {
  approveSesInvoiceRevisionAction,
  SesActionError,
} from "./ses_reporting_actions.ts";

const USER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const JOB = "cccccccc-3333-4333-8333-cccccccccccc";
const ORG = "00000000-0000-0000-0000-000000000001";
const SECOND_USER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SENDER = "test-sender-token-alpha";
const OTHER_SENDER = "test-sender-token-beta";
const SECOND_ENROLLED_SENDER = "test-sender-token-gamma";
const ROOT = "echo-code-test-root";
const NOW = Date.UTC(2026, 7, 8, 3, 0, 0);
const DOCKET = "docket-reviewed";
const OBLIGATION = "obligation-reviewed";
const OUTPUT_HASH = "sha256:reviewed-output";

type RequestRow = {
  request_id: string;
  channel: string;
  sender: string;
  message_hash: string;
  code_hash: string;
  consumed: boolean;
  expires: number;
  org_id: string;
  job_id: string;
};

async function bindingJson(): Promise<string> {
  return JSON.stringify([{
    channel: "whatsapp",
    sender_fingerprint: await sesChannelSenderFingerprint("whatsapp", SENDER),
    operator_user_id: USER,
    label: "captain",
  }, {
    channel: "whatsapp",
    sender_fingerprint: await sesChannelSenderFingerprint(
      "whatsapp",
      SECOND_ENROLLED_SENDER,
    ),
    operator_user_id: SECOND_USER,
    label: "second-operator",
  }]);
}

function makeClient(jobNumber = "SWMS-260000") {
  const requests = new Map<string, RequestRow>();
  const lock = { failed_attempts: 0, locked_until: 0 };
  const client: any = {
    requests,
    lock,
    coordinates: {
      docket_revision_id: DOCKET,
      invoice_obligation_revision_id: OBLIGATION,
      output_content_hash: OUTPUT_HASH,
    },
    from(table: string) {
      const rows: Record<string, string>[] = table === "jobs"
        ? [{ id: JOB, job_number: jobNumber }]
        : table === "users"
        ? [{ id: USER, email: "operator-account", role: "admin" }]
        : table === "makesafe_docket_revisions_current"
        ? [{
          id: client.coordinates.docket_revision_id,
          job_id: JOB,
          output_content_hash: client.coordinates.output_content_hash,
          invoice_obligation_revision_id:
            client.coordinates.invoice_obligation_revision_id,
        }]
        : table === "makesafe_invoice_obligation_revisions"
        ? [{
          id: client.coordinates.invoice_obligation_revision_id,
          job_id: JOB,
        }]
        : [];
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: string) => {
          builder.rows = rows.filter((row) =>
            String(row[column] ?? "") === String(value)
          );
          return builder;
        },
        maybeSingle: () =>
          Promise.resolve({
            data: (builder.rows ?? rows)[0] ?? null,
            error: null,
          }),
        limit: () => Promise.resolve({ data: rows, error: null }),
      };
      return builder;
    },
    async rpc(name: string, args: Record<string, string | number>) {
      if (name === "issue_ses_channel_approval_request") {
        if (
          lock.locked_until > Number(args.p_issued_at) ||
          lock.locked_until > NOW
        ) {
          return {
            data: [{ request_id: null, expires_at: args.p_expires_at }],
            error: null,
          };
        }
        requests.set(String(args.p_request_id), {
          request_id: String(args.p_request_id),
          channel: String(args.p_channel),
          sender: String(args.p_sender_fingerprint),
          message_hash: String(args.p_message_hash),
          code_hash: String(args.p_code_hash),
          consumed: false,
          expires: Date.parse(String(args.p_expires_at)),
          org_id: String(args.p_org_id),
          job_id: String(args.p_job_id),
        });
        return {
          data: [{
            request_id: args.p_request_id,
            expires_at: args.p_expires_at,
          }],
          error: null,
        };
      }
      const row = requests.get(String(args.p_request_id));
      if (!row || row.consumed) {
        return {
          data: [{ accepted: false, reason: "already_used" }],
          error: null,
        };
      }
      if (
        row.channel !== args.p_channel ||
        row.sender !== args.p_sender_fingerprint
      ) {
        return {
          data: [{ accepted: false, reason: "sender_mismatch" }],
          error: null,
        };
      }
      row.consumed = true;
      const now = Date.parse(String(args.p_now));
      if (lock.locked_until > now) {
        return { data: [{ accepted: false, reason: "locked" }], error: null };
      }
      const match = row.message_hash === args.p_message_hash &&
        row.code_hash === args.p_code_hash;
      if (!match) {
        lock.failed_attempts++;
        if (lock.failed_attempts >= SES_ECHO_CODE_LOCKOUT_THRESHOLD) {
          lock.locked_until = now + 15 * 60_000;
        }
        return {
          data: [{
            accepted: false,
            reason: lock.locked_until > now ? "locked" : "invalid",
            failed_attempts: lock.failed_attempts,
          }],
          error: null,
        };
      }
      lock.failed_attempts = 0;
      lock.locked_until = 0;
      return {
        data: [{
          accepted: true,
          reason: "accepted",
          org_id: row.org_id,
          job_id: row.job_id,
        }],
        error: null,
      };
    },
  };
  return client;
}

const auth = { mode: "api_key" as const, user: null };
const issueAuth = {
  mode: "jwt" as const,
  user: { id: USER, email: "operator-account", role: "admin" },
};

async function issue(client: any) {
  return await issueSesChannelApprovalAction(client, issueAuth, {
    org_id: ORG,
    job_id: JOB,
    channel: "whatsapp",
  }, { bindings_raw: await bindingJson(), root_secret: ROOT });
}

async function submit(
  client: any,
  issued: any,
  overrides: Record<string, unknown> = {},
) {
  return await submitSesEchoCodeApprovalAction(client, auth, {
    org_id: ORG,
    channel: "whatsapp",
    sender_id: SENDER,
    message_id: `message-${issued.echo_code.request_id}`,
    message_text: issued.echo_code.message_text,
    message_sent_at: new Date(NOW).toISOString(),
    request_id: issued.echo_code.request_id,
    expected_docket_revision_id: issued.echo_code.expected_docket_revision_id,
    expected_invoice_obligation_revision_id:
      issued.echo_code.expected_invoice_obligation_revision_id,
    expected_output_content_hash: issued.echo_code.expected_output_content_hash,
    ...overrides,
  }, {
    env: { bindings_raw: await bindingJson(), root_secret: ROOT },
    now: () => NOW,
    approveInvoice: async (_operator, args) => ({
      approved_job_id: args.job_id,
      approved_org_id: args.org_id,
    }),
    executeSendIt: async () => {
      throw new Error("SEND IT must not be coupled");
    },
  });
}

async function refusal(
  fn: () => Promise<unknown>,
): Promise<{ code: string; fact: string }> {
  const error = await assertRejects(fn, SesActionError) as SesActionError;
  return {
    code: String((error.refusal as any).code),
    fact: String((error.refusal as any).fact),
  };
}

Deno.test("issue is server-minted and returns the code only in the transport envelope", async () => {
  const client = makeClient();
  const first: any = await issue(client);
  const second: any = await issue(client);
  assert(first.echo_code.message_text !== second.echo_code.message_text);
  assertStringIncludes(first.echo_code.message_text, "APPROVE SWMS-260000");
  assertEquals(first.echo_code.expected_docket_revision_id, DOCKET);
  assertEquals(
    first.echo_code.expected_invoice_obligation_revision_id,
    OBLIGATION,
  );
  assertEquals(first.echo_code.expected_output_content_hash, OUTPUT_HASH);
  assert(!JSON.stringify(client.requests).includes("operator-account"));
});

Deno.test("channel approval refuses when the current docket changes after issue", async () => {
  const client = makeClient();
  const issued: any = await issue(client);
  const currentDocket: any = {
    docket_revision_id: "docket-corrected-after-issue",
    invoice_obligation_revision_id: OBLIGATION,
    docket_output_content_hash: "sha256:corrected-output",
    clean_input: { pricing_disposition: "priced_from_canon" },
  };
  const bindingsRaw = await bindingJson();
  const error = await assertRejects(
    () =>
      submitSesEchoCodeApprovalAction(client, auth, {
        org_id: ORG,
        channel: "whatsapp",
        sender_id: SENDER,
        message_id: `message-${issued.echo_code.request_id}`,
        message_text: issued.echo_code.message_text,
        message_sent_at: new Date(NOW).toISOString(),
        request_id: issued.echo_code.request_id,
        expected_docket_revision_id:
          issued.echo_code.expected_docket_revision_id,
        expected_invoice_obligation_revision_id:
          issued.echo_code.expected_invoice_obligation_revision_id,
        expected_output_content_hash:
          issued.echo_code.expected_output_content_hash,
      }, {
        env: { bindings_raw: bindingsRaw, root_secret: ROOT },
        now: () => NOW,
        approveInvoice: (operator, args) =>
          approveSesInvoiceRevisionAction(client, operator, args, {
            loadDocket: async () => currentDocket,
          }),
        executeSendIt: async () => {
          throw new Error("SEND IT must not be coupled");
        },
      }),
    SesActionError,
  ) as SesActionError;
  assertEquals((error.refusal as any).code, "stale_review");
});

Deno.test("issuance refuses a card whose reference the verifier cannot read back", async () => {
  const client = makeClient("260000");
  const result = await refusal(() => issue(client));
  assertEquals(result.code, "echo_code_card_reference_unusable");
  assertEquals(client.requests.size, 0);
});

Deno.test("the relay cannot issue a code", async () => {
  const client = makeClient();
  const bindings_raw = await bindingJson();
  const result = await refusal(() =>
    issueSesChannelApprovalAction(client, auth, {
      org_id: ORG,
      job_id: JOB,
      channel: "whatsapp",
    }, { bindings_raw, root_secret: ROOT })
  );
  assertEquals(result.code, "echo_code_issue_requires_session");
});

Deno.test("ATTACK PROOF watched fail: a valid code from an unenrolled sender", async () => {
  const client = makeClient();
  const issued: any = await issue(client);
  const result = await refusal(() =>
    submit(client, issued, { sender_id: OTHER_SENDER })
  );
  assertEquals(result.code, "channel_sender_not_bound");
  assertStringIncludes(result.fact, "enrolled sender");
  assertEquals(
    client.requests.get(issued.echo_code.request_id).consumed,
    false,
  );
});

Deno.test("ATTACK PROOF watched fail: repeated mismatched-sender attempts neither lock the captain out nor spend his request", async () => {
  const client = makeClient();
  const issued: any = await issue(client);
  for (
    let attempt = 0;
    attempt < SES_ECHO_CODE_LOCKOUT_THRESHOLD * 2;
    attempt++
  ) {
    const unenrolled = await refusal(() =>
      submit(client, issued, { sender_id: OTHER_SENDER })
    );
    assertEquals(unenrolled.code, "channel_sender_not_bound");
    const otherOperator = await refusal(() =>
      submit(client, issued, { sender_id: SECOND_ENROLLED_SENDER })
    );
    assertEquals(otherOperator.code, "echo_code_sender_mismatch");
  }
  assertEquals(client.lock.failed_attempts, 0);
  assertEquals(client.lock.locked_until, 0);
  assertEquals(
    client.requests.get(issued.echo_code.request_id).consumed,
    false,
  );
  const approved: any = await submit(client, issued);
  assertEquals(approved.approval.approved_job_id, JOB);
});

Deno.test("ATTACK PROOF watched fail: a valid code against a different request", async () => {
  const client = makeClient();
  const first: any = await issue(client);
  const second: any = await issue(client);
  const result = await refusal(() =>
    submit(client, second, { message_text: first.echo_code.message_text })
  );
  assertEquals(result.code, "echo_code_invalid");
  assertEquals(client.requests.get(second.echo_code.request_id).consumed, true);
});

Deno.test("ATTACK PROOF watched fail: changing the issued message consumes the code", async () => {
  const client = makeClient();
  const issued: any = await issue(client);
  const result = await refusal(() =>
    submit(client, issued, { message_text: "APPROVE SWMS-260000 000000" })
  );
  assertEquals(result.code, "echo_code_invalid");
  const replay = await refusal(() => submit(client, issued));
  assertEquals(replay.code, "echo_code_already_used");
});

Deno.test("ATTACK PROOF watched fail: a reused code", async () => {
  const client = makeClient();
  const issued: any = await issue(client);
  await submit(client, issued);
  const result = await refusal(() =>
    submit(client, issued, { message_id: "replay" })
  );
  assertEquals(result.code, "echo_code_already_used");
});

Deno.test("a wrong verification spends that request even before a later correct retry", async () => {
  const client = makeClient();
  const issued: any = await issue(client);
  await refusal(() =>
    submit(client, issued, { message_text: "APPROVE SWMS-260000 000000" })
  );
  const result = await refusal(() => submit(client, issued));
  assertEquals(result.code, "echo_code_already_used");
});

Deno.test("ATTACK PROOF watched fail: wrong guesses reach sender lockout", async () => {
  const client = makeClient();
  for (let attempt = 1; attempt <= SES_ECHO_CODE_LOCKOUT_THRESHOLD; attempt++) {
    const issued: any = await issue(client);
    const result = await refusal(() =>
      submit(client, issued, { message_text: "APPROVE SWMS-260000 000000" })
    );
    if (attempt < SES_ECHO_CODE_LOCKOUT_THRESHOLD) {
      assertEquals(result.code, "echo_code_invalid");
    } else assertEquals(result.code, "echo_code_sender_locked");
  }
  assertEquals(client.lock.failed_attempts, SES_ECHO_CODE_LOCKOUT_THRESHOLD);
});

Deno.test("ATTACK PROOF watched fail: a fresh code cannot bypass sender lockout", async () => {
  const client = makeClient();
  for (let attempt = 0; attempt < SES_ECHO_CODE_LOCKOUT_THRESHOLD; attempt++) {
    const issued: any = await issue(client);
    await refusal(() =>
      submit(client, issued, { message_text: "APPROVE SWMS-260000 000000" })
    );
  }
  const result = await refusal(() => issue(client));
  assertEquals(result.code, "echo_code_sender_locked");
});

Deno.test("a relayed SEND IT word is refused by name and consumes nothing", async () => {
  const client = makeClient();
  const issued: any = await issue(client);
  const result = await refusal(() =>
    submit(client, issued, { message_text: "SEND IT SWMS-260000 123456" })
  );
  assertEquals(result.code, "channel_send_not_supported");
  assertEquals(
    client.requests.get(issued.echo_code.request_id).consumed,
    false,
  );
});

Deno.test("the approval records the org bound at issuance, never the relay's", async () => {
  const client = makeClient();
  const issued: any = await issue(client);
  const approved: any = await submit(client, issued, {
    org_id: "99999999-9999-4999-8999-999999999999",
  });
  assertEquals(approved.approval.approved_org_id, ORG);
  assertEquals(approved.approval.approved_job_id, JOB);
});
