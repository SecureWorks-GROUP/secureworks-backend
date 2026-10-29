// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  readXeroTieout,
  tieoutParams,
  XeroTieoutError,
} from "./xero_tieout.ts";
import {
  _authorizeOpsApiAction,
  _opsApiActionNeedsStaffRole,
  AGENT_READ_ALLOWED_ACTIONS,
  LEAD_INSTALLER_READ_ACTIONS,
} from "./index.ts";

function url(query = ""): URL {
  return new URL(`https://example.invalid/ops-api?action=xero_tieout${query}`);
}

Deno.test("Xero tie-out: parameters default to today and 12 months", () => {
  assertEquals(tieoutParams(null, null), { p_as_of: null, p_months: 12 });
  assertEquals(tieoutParams("", " "), { p_as_of: null, p_months: 12 });
  assertEquals(tieoutParams("2026-10-29", "6"), {
    p_as_of: "2026-10-29",
    p_months: 6,
  });
});

Deno.test("Xero tie-out: a bad date or month count is refused, not guessed", () => {
  for (const d of ["2026-13-01", "2026-02-30", "29/10/2026", "yesterday"]) {
    assertThrows(() => tieoutParams(d, null), XeroTieoutError, "as_of", d);
  }
  for (const m of ["0", "121", "2.5", "six"]) {
    assertThrows(() => tieoutParams(null, m), XeroTieoutError, "months", m);
  }
});

Deno.test("Xero tie-out: passes the parameters and returns the read whole", async () => {
  const calls: any[] = [];
  const body = { covers: "bills only", months: [{ month: "2026-10" }] };
  const client = {
    rpc: (name: string, args: any) => {
      calls.push([name, args]);
      return Promise.resolve({ data: body, error: null });
    },
  };
  assertEquals(
    await readXeroTieout(client, { asOf: "2026-10-29", months: "6" }),
    { ok: true, tieout: body },
  );
  assertEquals(calls, [["xero_tieout_monthly", {
    p_as_of: "2026-10-29",
    p_months: 6,
  }]]);
});

Deno.test("Xero tie-out: an unreadable answer is a 503, never an empty page", async () => {
  for (
    const res of [
      {
        data: null,
        error: { message: "function xero_tieout_monthly does not exist" },
      },
      { data: null, error: null },
      { data: { covers: "bills only" }, error: null },
    ]
  ) {
    const err = await assertRejects(
      () => readXeroTieout({ rpc: () => Promise.resolve(res) }, {}),
      XeroTieoutError,
    );
    assertEquals(err.status, 503);
  }
});

Deno.test("Xero tie-out: staff only at the ops-api front door", () => {
  assertEquals(_opsApiActionNeedsStaffRole(url()), true);
  assertEquals(AGENT_READ_ALLOWED_ACTIONS.has("xero_tieout"), false);
  assertEquals(LEAD_INSTALLER_READ_ACTIONS.has("xero_tieout"), false);
  const status = (
    authMode: any,
    role?: string,
    extra: Record<string, unknown> = {},
  ) => {
    const d = _authorizeOpsApiAction({
      url: url(),
      authMode,
      authUser: role ? { role, managedVerticals: ["fencing"] } : null,
      ...extra,
    } as any);
    return d.ok ? 200 : d.status;
  };
  assertEquals(status("none"), 401);
  assertEquals(status("api_key"), 401);
  assertEquals(
    status("api_key", undefined, { serverSecretPresented: true }),
    200,
  );
  for (const role of ["admin", "owner", "ops_manager"]) {
    assertEquals(status("jwt", role), 200, role);
  }
  for (const role of ["trade", "lead_installer", "installer"]) {
    assertEquals(status("jwt", role), 403, role);
  }
});
