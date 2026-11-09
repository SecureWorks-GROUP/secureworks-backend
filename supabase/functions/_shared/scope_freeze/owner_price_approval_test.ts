// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  OWNER_APPROVAL_SAVED_REVISION_FLAG,
  ownerPriceGate,
  recordUnapprovedLegacySend,
} from "./owner_price_approval.ts";
import type { SealedSendSource } from "./quote_scope_revision_link.ts";

const JOB = "00000000-0000-4000-8000-000000000001";
const REV = "00000000-0000-4000-8000-000000000002";
const sealed: SealedSendSource = {
  kind: "sealed",
  revision_id: REV,
  scope_json: {},
  pricing_json: {},
};

function client(opts: {
  rpc?: () => Promise<{ data: unknown; error: unknown }>;
  flag?: () => Promise<{ data: unknown; error: unknown }>;
  insert?: (row: any) => Promise<{ error: unknown }>;
}) {
  const calls: any[] = [];
  return {
    calls,
    rpc(name: string, args: unknown) {
      calls.push({ rpc: name, args });
      return opts.rpc
        ? opts.rpc()
        : Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      calls.push({ from: table });
      return {
        select() {
          return this;
        },
        eq(column: string, value: unknown) {
          calls.push({ eq: [column, value] });
          return this;
        },
        maybeSingle() {
          return opts.flag
            ? opts.flag()
            : Promise.resolve({ data: null, error: null });
        },
        insert(row: any) {
          calls.push({ insert: row });
          return opts.insert
            ? opts.insert(row)
            : Promise.resolve({ error: null });
        },
      };
    },
  };
}

Deno.test("owner price gate: a saved revision with the owner's price decision is approved", async () => {
  const sb = client({
    rpc: () =>
      Promise.resolve({ data: { id: "a1", kind: "price" }, error: null }),
  });
  const gate = await ownerPriceGate(sb, JOB, sealed);
  assertEquals(gate, {
    kind: "approved",
    approval_id: "a1",
    scope_revision_id: REV,
  });
  assertEquals(sb.calls[0], {
    rpc: "scope_price_owner_approval",
    args: { p_job_id: JOB, p_scope_revision_id: REV },
  });
});

Deno.test("owner price gate: a saved revision with no price decision is refused, nothing sent", async () => {
  const gate = await ownerPriceGate(client({}), JOB, sealed);
  assertEquals(gate.kind, "refused");
  if (gate.kind !== "refused") return;
  assertEquals(gate.status, 409);
  assertEquals(gate.body.code, "owner_price_approval_required");
});

Deno.test("owner price gate: an unreadable decision fails closed", async () => {
  for (
    const rpc of [
      () => Promise.resolve({ data: null, error: { code: "57014" } }),
      () => Promise.reject(new Error("network")),
    ]
  ) {
    const gate = await ownerPriceGate(client({ rpc }), JOB, sealed);
    assertEquals(gate.kind, "refused");
    if (gate.kind !== "refused") return;
    assertEquals(gate.status, 503);
    assertEquals(gate.body.code, "owner_price_approval_unreadable");
  }
});

Deno.test("owner price gate: a refused sealed source is left to its own refusal", async () => {
  const sb = client({});
  const gate = await ownerPriceGate(sb, JOB, {
    kind: "refused",
    status: 409,
    body: { error: "x", code: "x", reason: "x" },
  });
  assertEquals(gate, { kind: "not_judged" });
  assertEquals(sb.calls, []);
});

Deno.test("owner price gate: a send naming no saved revision follows the switch", async () => {
  const off = client({
    flag: () => Promise.resolve({ data: { enabled: false }, error: null }),
  });
  assertEquals(await ownerPriceGate(off, JOB, { kind: "legacy" }), {
    kind: "legacy_unapproved",
  });
  assertEquals(
    off.calls.find((c) => c.eq)?.eq,
    ["flag_name", OWNER_APPROVAL_SAVED_REVISION_FLAG],
  );
  const missing = client({});
  assertEquals(await ownerPriceGate(missing, JOB, { kind: "legacy" }), {
    kind: "legacy_unapproved",
  });
  const on = await ownerPriceGate(
    client({
      flag: () => Promise.resolve({ data: { enabled: true }, error: null }),
    }),
    JOB,
    { kind: "legacy" },
  );
  assertEquals(on.kind, "refused");
  if (on.kind !== "refused") return;
  assertEquals(on.status, 409);
  assertEquals(on.body.code, "owner_price_approval_requires_saved_revision");
  const unreadable = await ownerPriceGate(
    client({
      flag: () => Promise.resolve({ data: null, error: { code: "x" } }),
    }),
    JOB,
    { kind: "legacy" },
  );
  assertEquals(unreadable.kind, "refused");
  if (unreadable.kind !== "refused") return;
  assertEquals(unreadable.status, 503);
});

Deno.test("owner price gate: an unapproved legacy send is recorded with ids only, never blocking", async () => {
  const sb = client({});
  await recordUnapprovedLegacySend(sb, JOB, {
    path: "send",
    document_ids: ["d1"],
  });
  assertEquals(sb.calls.find((c) => c.insert)?.insert, {
    job_id: JOB,
    event_type: "quote_send_price_unapproved",
    detail_json: {
      reason: "no_saved_revision",
      path: "send",
      document_ids: ["d1"],
    },
  });
  const failing = client({ insert: () => Promise.reject(new Error("down")) });
  await recordUnapprovedLegacySend(failing, JOB, {
    path: "send-runs",
    document_ids: [],
  });
});
