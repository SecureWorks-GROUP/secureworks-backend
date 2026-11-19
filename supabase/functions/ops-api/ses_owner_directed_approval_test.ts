import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveSesOwnerDirectedApproval,
  SES_OWNER_DIRECTED_APPROVAL_FLAG,
} from "./ses_owner_directed_approval.ts";

const OWNER = { id: "706c5258-70dd-483a-b36c-af6864b24498", email: "owner@example.test", role: "admin" };

function fakeClient(opts: {
  flag?: boolean | "error";
  users?: Array<Record<string, unknown>>;
  operators?: Array<Record<string, unknown>>;
}) {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return chain;
        },
        ilike: (col: string, val: unknown) => {
          filters.push([col, val]);
          return chain;
        },
        limit: async () => {
          if (table === "feature_flags") {
            if (opts.flag === "error") return { data: null, error: { message: "boom" } };
            const name = filters.find(([c]) => c === "flag_name")?.[1];
            return {
              data: name === SES_OWNER_DIRECTED_APPROVAL_FLAG && opts.flag !== undefined
                ? [{ enabled: opts.flag }]
                : [],
              error: null,
            };
          }
          if (table === "users") return { data: opts.users ?? [OWNER], error: null };
          if (table === "ses_release_operators") {
            const id = filters.find(([c]) => c === "user_id")?.[1];
            return {
              data: (opts.operators ?? [{ user_id: OWNER.id, operator_class: "admin_owner", active: true }])
                .filter((row) => row.user_id === id),
              error: null,
            };
          }
          return { data: [], error: null };
        },
      };
      return chain;
    },
  };
}

const REQUEST = { owner_email: "Owner@Example.test", owner_statement: "Approve both invoices now" };

Deno.test("owner-directed approval: an active admin_owner's quoted words become an approval auth marked as relayed", async () => {
  const result = await resolveSesOwnerDirectedApproval(fakeClient({ flag: true }), "api_key", REQUEST, "agent:jarvis-mcp");
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.auth.mode, "jwt");
  assertEquals(result.auth.user?.id, OWNER.id);
  assertEquals(result.auth.identity_provenance, "owner_directed_via_agent");
  assertEquals(result.evidence_ref.kind, "owner_directive");
  assertEquals(result.evidence_ref.owner_statement, "Approve both invoices now");
  assertEquals(result.evidence_ref.relayed_by, "agent:jarvis-mcp");
});

Deno.test("owner-directed approval: off, missing or unreadable switch refuses", async () => {
  for (const flag of [false, undefined, "error"] as const) {
    const result = await resolveSesOwnerDirectedApproval(fakeClient({ flag }), "api_key", REQUEST, null);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.refusal.code, "owner_directed_approval_off");
  }
});

Deno.test("owner-directed approval: never a routine or a browser session", async () => {
  for (const mode of ["routine", "jwt"] as const) {
    const result = await resolveSesOwnerDirectedApproval(fakeClient({ flag: true }), mode, REQUEST, null);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.refusal.code, "owner_directed_server_key_only");
  }
});

Deno.test("owner-directed approval: the words and the email are required", async () => {
  const noWords = await resolveSesOwnerDirectedApproval(
    fakeClient({ flag: true }),
    "api_key",
    { owner_email: REQUEST.owner_email, owner_statement: " " },
    null,
  );
  assertEquals(noWords.ok ? "" : noWords.refusal.code, "owner_statement_required");
  const noEmail = await resolveSesOwnerDirectedApproval(
    fakeClient({ flag: true }),
    "api_key",
    { owner_statement: "yes" },
    null,
  );
  assertEquals(noEmail.ok ? "" : noEmail.refusal.code, "owner_email_required");
});

Deno.test("owner-directed approval: an inactive, unknown or non-approving operator cannot direct", async () => {
  const cases = [
    { operators: [{ user_id: OWNER.id, operator_class: "admin_owner", active: false }], code: "owner_not_an_approving_operator" },
    { operators: [{ user_id: OWNER.id, operator_class: "shaun_clean", active: true }], code: "owner_not_an_approving_operator" },
    { operators: [], code: "owner_not_an_approving_operator" },
    { users: [], code: "owner_not_found" },
    { users: [{ ...OWNER, email: "someone.else@example.test" }], code: "owner_not_found" },
  ];
  for (const c of cases) {
    const result = await resolveSesOwnerDirectedApproval(
      fakeClient({ flag: true, ...c } as any),
      "api_key",
      REQUEST,
      null,
    );
    assertEquals(result.ok ? "" : result.refusal.code, c.code);
  }
});

Deno.test("owner directive: a job event keeps who and when, never the words or the address", async () => {
  const { ownerDirectiveEventStamp } = await import("./ses_owner_directed_approval.ts");
  const evidence = {
    kind: "owner_directive",
    owner_email: "OWNER-ADDRESS-TOKEN",
    owner_statement: "Approve it now",
    relayed_by: "agent",
    recorded_at: "2026-11-19T08:00:00.000Z",
  };
  const stamp = ownerDirectiveEventStamp(evidence, "owner-user-id");
  assertEquals(stamp, { kind: "owner_directive", owner_user_id: "owner-user-id", recorded_at: "2026-11-19T08:00:00.000Z" });
  const text = JSON.stringify(stamp);
  for (const leaked of ["OWNER-ADDRESS-TOKEN", "Approve it now", "agent"]) {
    assertEquals(text.includes(leaked), false, leaked);
  }
  // A signed-in session directed nothing.
  assertEquals(ownerDirectiveEventStamp(null, "owner-user-id"), null);
  // Both job event writers use the stamp, never the raw evidence.
  for (const file of ["./job_additional_work_orders.ts", "./restoration_work_order.ts"]) {
    const src = await Deno.readTextFile(new URL(file, import.meta.url));
    assertEquals(src.includes("owner_directive: approver.evidence"), false, file);
    assertEquals(src.includes("owner_directive: ownerDirectiveEventStamp(approver.evidence, approver.userId)"), true, file);
  }
});
