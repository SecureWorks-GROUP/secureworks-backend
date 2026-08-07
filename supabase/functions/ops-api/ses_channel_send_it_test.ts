// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
//
// Harden SES ticket 07: the Captain's SEND IT word binds to exactly one
// prepared release revision, on the latest docket revision, single card only.
//
// Pins:
//   1. No prepared release → channel_release_not_prepared (nothing sends).
//   2. Two awaiting releases → channel_release_ambiguous.
//   3. A multi-job release refuses on this channel (a one-line word cannot
//      fan out to unnamed cards).
//   4. A release bound to a superseded docket revision refuses as stale.
//   5. A `proposed` release is approved (with the binding hashes recorded as
//      evidence) then executed; an already-`approved` release skips straight
//      to execute. Approve/execute are the cockpit's own actions, injected.

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  executeSesChannelSendIt,
  resolveSesChannelSendItBinding,
} from "./ses_channel_send_it.ts";
import { SesActionError } from "./ses_reporting_actions.ts";

const JOB = "11111111-1111-1111-1111-111111111111";
const OTHER_JOB = "22222222-2222-2222-2222-222222222222";
const REL_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const REL_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const DOCKET_1 = "dddddddd-dddd-dddd-dddd-ddddddddddd1";
const DOCKET_2 = "dddddddd-dddd-dddd-dddd-ddddddddddd2";

interface FakeState {
  members: Array<{
    release_revision_id: string;
    job_id: string;
    docket_revision_id: string;
  }>;
  revisions: Array<{ id: string; state: string; content_hash: string }>;
  dockets: Array<{
    id: string;
    job_id: string;
    state: string;
    output_content_hash: string;
    created_at: string;
  }>;
}

function fakeClient(state: FakeState): any {
  return {
    from(table: string) {
      let rows: any[] = [];
      if (table === "makesafe_release_revision_members") rows = state.members;
      else if (table === "makesafe_release_revisions") rows = state.revisions;
      else if (table === "makesafe_docket_revisions") rows = state.dockets;
      const query: any = {
        _rows: rows.slice(),
        select() {
          return query;
        },
        eq(col: string, value: unknown) {
          query._rows = query._rows.filter((row: any) =>
            String(row[col]) === String(value)
          );
          return query;
        },
        in(col: string, values: unknown[]) {
          const set = new Set(values.map(String));
          query._rows = query._rows.filter((row: any) =>
            set.has(String(row[col]))
          );
          return query;
        },
        order(col: string, opts: { ascending: boolean }) {
          query._rows.sort((a: any, b: any) =>
            opts.ascending
              ? String(a[col]).localeCompare(String(b[col]))
              : String(b[col]).localeCompare(String(a[col]))
          );
          return query;
        },
        limit(n: number) {
          query._rows = query._rows.slice(0, n);
          return query;
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: query._rows, error: null }).then(
            resolve,
          );
        },
      };
      return query;
    },
  };
}

function baseState(): FakeState {
  return {
    members: [{
      release_revision_id: REL_A,
      job_id: JOB,
      docket_revision_id: DOCKET_1,
    }],
    revisions: [{ id: REL_A, state: "proposed", content_hash: "sha256:aa" }],
    dockets: [{
      id: DOCKET_1,
      job_id: JOB,
      state: "ready",
      output_content_hash: "sha256:d1",
      created_at: "2026-08-07T01:00:00Z",
    }],
  };
}

const operatorAuth: any = {
  mode: "jwt",
  user: { id: "op-1", email: "operator@example.test", role: "admin" },
  identity_provenance: "bound_channel_totp",
};

async function refusalCode(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof SesActionError) return (error as any).refusal;
    throw error;
  }
  throw new Error("expected a refusal");
}

function depsRecorder(calls: { name: string; args?: any }[]) {
  return {
    approveRelease: async (_auth: any, args: any) => {
      calls.push({ name: "approve", args });
      return { approved: true };
    },
    executeRelease: async (_auth: any, args: any) => {
      calls.push({ name: "execute", args });
      return { released: true };
    },
  };
}

Deno.test("no prepared release refuses with nothing sent", async () => {
  const state = baseState();
  state.revisions[0]!.state = "released";
  const calls: any[] = [];
  const refusal = await refusalCode(() =>
    executeSesChannelSendIt(fakeClient(state), operatorAuth, {
      org_id: "org",
      job_id: JOB,
      actor: "operator@example.test",
      evidence_refs: [],
    }, depsRecorder(calls))
  );
  assertStringIncludes(JSON.stringify(refusal), "channel_release_not_prepared");
  assertEquals(calls.length, 0);
});

Deno.test("two awaiting releases are ambiguous, never guessed between", async () => {
  const state = baseState();
  state.members.push({
    release_revision_id: REL_B,
    job_id: JOB,
    docket_revision_id: DOCKET_1,
  });
  state.revisions.push({
    id: REL_B,
    state: "proposed",
    content_hash: "sha256:bb",
  });
  const refusal = await refusalCode(() =>
    resolveSesChannelSendItBinding(fakeClient(state), JOB)
  );
  assertStringIncludes(JSON.stringify(refusal), "channel_release_ambiguous");
});

Deno.test("a multi-card release refuses on a one-line word", async () => {
  const state = baseState();
  state.members.push({
    release_revision_id: REL_A,
    job_id: OTHER_JOB,
    docket_revision_id: DOCKET_2,
  });
  const refusal = await refusalCode(() =>
    resolveSesChannelSendItBinding(fakeClient(state), JOB)
  );
  assertStringIncludes(
    JSON.stringify(refusal),
    "channel_release_not_single_card",
  );
});

Deno.test("a stale docket revision refuses rather than sending an old pack", async () => {
  const state = baseState();
  state.dockets.push({
    id: DOCKET_2,
    job_id: JOB,
    state: "ready",
    output_content_hash: "sha256:d2",
    created_at: "2026-08-07T02:00:00Z",
  });
  const refusal = await refusalCode(() =>
    resolveSesChannelSendItBinding(fakeClient(state), JOB)
  );
  assertStringIncludes(JSON.stringify(refusal), "channel_release_stale_docket");
});

Deno.test("a proposed release is approved with the binding hashes then executed", async () => {
  const calls: { name: string; args?: any }[] = [];
  const result: any = await executeSesChannelSendIt(
    fakeClient(baseState()),
    operatorAuth,
    {
      org_id: "org",
      job_id: JOB,
      actor: "operator@example.test",
      evidence_refs: [{ kind: "ses_channel_operator_act" }],
    },
    depsRecorder(calls),
  );
  assertEquals(calls.map((c) => c.name), ["approve", "execute"]);
  const evidence = calls[0]!.args.evidence_refs;
  assertEquals(evidence.length, 2);
  assertEquals(evidence[1].kind, "ses_channel_send_it_binding");
  assertEquals(evidence[1].release_revision_id, REL_A);
  assertEquals(evidence[1].docket_revision_id, DOCKET_1);
  assertEquals(evidence[1].docket_output_content_hash, "sha256:d1");
  assertEquals(calls[1]!.args.release_revision_id, REL_A);
  assertEquals(calls[1]!.args.actor, "operator@example.test");
  assert(result.release.released);
});

Deno.test("an already approved release goes straight to execute", async () => {
  const state = baseState();
  state.revisions[0]!.state = "approved";
  const calls: { name: string; args?: any }[] = [];
  const result: any = await executeSesChannelSendIt(
    fakeClient(state),
    operatorAuth,
    {
      org_id: "org",
      job_id: JOB,
      actor: "operator@example.test",
      evidence_refs: [],
    },
    depsRecorder(calls),
  );
  assertEquals(calls.map((c) => c.name), ["execute"]);
  assertEquals(result.approval, null);
});
