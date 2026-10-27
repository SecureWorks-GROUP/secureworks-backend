// deno-lint-ignore-file no-import-prefix no-explicit-any
// INT-01 (Jan, 27 Oct 2026): "crew members shouldnt or customers, but our
// internal offie staff that have access to ai thats fine".
//
// The office (staff sessions and server callers, which is how office agents
// reach ops-api) reads the dossier with every figure. A crew, supplier or
// customer never gets that shape: the front door refuses them, the action
// refuses them again, and a request naming an outward audience is refused.
// The crew's own read (trade_job_detail) strips the Sales scoper's pricing.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveDossierAudience } from "./dossier_audience.ts";
import {
  _authorizeOpsApiAction,
  redactTradeScopeQuote,
} from "./index.ts";

Deno.test("INT-01 audience: an office caller reads the office shape", () => {
  assertEquals(resolveDossierAudience(true, undefined), { ok: true, audience: "office" });
  assertEquals(resolveDossierAudience(true, null), { ok: true, audience: "office" });
  assertEquals(resolveDossierAudience(true, "office"), { ok: true, audience: "office" });
});

Deno.test("INT-01 audience: crew, supplier and customer are never served the dossier", () => {
  for (const asked of ["crew", "supplier", "customer"]) {
    for (const office of [true, false]) {
      const r = resolveDossierAudience(office, asked);
      assertEquals(r.ok, false, `${asked} (office=${office})`);
      if (!r.ok) {
        assertEquals(r.status, 400);
        assertEquals(r.code, "outward_audience_not_served");
      }
    }
  }
});

Deno.test("INT-01 audience: a caller that is not office is refused even with no audience named", () => {
  for (const asked of [undefined, null, "office"]) {
    const r = resolveDossierAudience(false, asked);
    assertEquals(r.ok, false);
    if (!r.ok) {
      assertEquals(r.status, 403);
      assertEquals(r.code, "operator_access_required");
    }
  }
});

Deno.test("INT-01 audience: an unknown audience is a caller mistake, never the office shape", () => {
  for (const asked of ["Office", "staff", "agent", 1, true, {}]) {
    const r = resolveDossierAudience(true, asked);
    assertEquals(r.ok, false, String(asked));
    if (!r.ok) assertEquals(r.code, "invalid_audience");
  }
});

Deno.test("INT-01 front door: only staff sessions and server secrets reach the dossier", () => {
  const url = new URL("https://x.invalid/ops-api?action=assemble_job_dossier");
  for (const role of ["admin", "owner", "ops_manager"]) {
    assertEquals(_authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role } }).ok, true, role);
  }
  for (const role of ["lead_installer", "installer", "trade", "unknown"]) {
    const r = _authorizeOpsApiAction({
      url,
      authMode: "jwt",
      authUser: { role, managedVerticals: ["fencing", "patio"] } as any,
    });
    assertEquals(r.ok, false, role);
  }
  assertEquals(_authorizeOpsApiAction({ url, authMode: "api_key", serverSecretPresented: true }).ok, true);
  assertEquals(_authorizeOpsApiAction({ url, authMode: "api_key", serverSecretPresented: false }).ok, false);
});

Deno.test("INT-01 crew surface: trade_job_detail's scope fence drops the Sales scoper's margin, commission and rates", () => {
  const scope = {
    tool: "patio-scoper",
    version: "2.0",
    lines: [{ description: "Roof sheet", quantity: 8, unit: "ea" }],
    expected: { total: 99901, margin: 99902 },
    draft: {
      site: { storeys: "single", houseRoof: "tile" },
      design: { shape: "skillion", widthMm: 6000 },
      pricing: {
        rates: { roof: 77711 },
        materialsTotal: 77712,
        oneFigure: 77713,
        labour: { trades: 2, days: 3, amount: 77714 },
        marginPct: 35,
        commissionPct: 13,
      },
    },
  };
  const out = redactTradeScopeQuote(scope);
  const text = JSON.stringify(out);
  for (const leak of ["77711", "77712", "77713", "77714", "99901", "99902", "marginPct", "commissionPct", "materialsTotal", "rates", "oneFigure"]) {
    assert(!text.includes(leak), `${leak} reached the crew`);
  }
  // The installer's own labour budget inputs and the design stay.
  assertEquals(out.draft.pricing, { labour: { trades: 2, days: 3 } });
  assertEquals(out.draft.design.shape, "skillion");
});
