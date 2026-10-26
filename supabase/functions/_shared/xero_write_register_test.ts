// deno-lint-ignore-file no-explicit-any no-import-prefix
// The Xero write register's call-site test (Integrated Job Framework INT-33).
// It scans every edge function source for Xero writes and fails when a site
// appears that the register (xero_write_register.json) does not name, or the
// register names one that is gone. To add a write: add its key to the X row it
// belongs to, or a new row, in the same PR, and say so for the CFO desk and
// Marnin (a new path is a person's decision).
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { scanFunctions, scanSource } from "./xero_write_sites.ts";

const FUNCTIONS = new URL("../", import.meta.url);
const REGISTER = JSON.parse(
  await Deno.readTextFile(
    new URL("./xero_write_register.json", import.meta.url),
  ),
);
const DOC = await Deno.readTextFile(
  new URL("../../../docs/xero-write-register.md", import.meta.url),
);

/** The register's own reading: keys it names, and the row each belongs to. */
function registerKeys(register: any): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of register.rows) {
    for (const key of row.call_sites) out.set(key, row.id);
  }
  for (const n of register.not_writes) out.set(n.key, "not_a_write");
  return out;
}

/** Sites the register does not name, and keys the register names that are gone. */
export function registerDrift(
  siteKeys: string[],
  register: any,
): { unregistered: string[]; gone: string[] } {
  const known = registerKeys(register);
  const found = new Set(siteKeys);
  return {
    unregistered: siteKeys.filter((k) => !known.has(k)),
    gone: [...known.keys()].filter((k) => !found.has(k)),
  };
}

Deno.test("every Xero write site in supabase/functions is on the register, and every register site still exists", async () => {
  const sites = await scanFunctions(FUNCTIONS);
  const drift = registerDrift(sites.map((s) => s.key), REGISTER);
  const where = (k: string) => {
    const s = sites.find((x) => x.key === k);
    return s ? `${k} (line ${s.line})` : k;
  };
  assertEquals(
    drift.unregistered.map(where),
    [],
    "A Xero write site no register row names. Add its key to the X row it belongs to in _shared/xero_write_register.json (and docs/xero-write-register.md), or a new row for the CFO desk and Marnin to confirm.",
  );
  assertEquals(
    drift.gone,
    [],
    "The register names a site the sources no longer have. Remove or rename it.",
  );
  // Today's count, so a scan that silently finds nothing cannot pass.
  assert(sites.length >= 40, `only ${sites.length} sites found`);
});

Deno.test("the register's rows are X1 to X14, each with an owner and a gate, each key on one row", () => {
  const ids = REGISTER.rows.map((r: any) => r.id);
  assertEquals(ids, Array.from({ length: 14 }, (_, i) => `X${i + 1}`));
  const seen = new Set<string>();
  for (const row of REGISTER.rows) {
    assert(String(row.write || "").length > 0, `${row.id} write`);
    assert(String(row.owner || "").length > 0, `${row.id} owner`);
    assert(String(row.gate_today || "").length > 0, `${row.id} gate_today`);
    assertEquals(typeof row.moves_money, "boolean", `${row.id} moves_money`);
    assertEquals(
      typeof row.cfo_confirmed,
      "boolean",
      `${row.id} cfo_confirmed`,
    );
    assert(
      row.call_sites.length > 0 || String(row.via || "").length > 0,
      `${row.id} has no call site and no via`,
    );
    for (const key of row.call_sites) {
      assert(!seen.has(key), `${key} is on two rows`);
      seen.add(key);
    }
  }
});

Deno.test("the human register names every row and every call site", () => {
  for (const row of REGISTER.rows) {
    assert(DOC.includes(`| ${row.id} |`), `${row.id} missing from the doc`);
    for (const key of row.call_sites) {
      assert(DOC.includes(key), `${key} missing from the doc`);
    }
  }
});

Deno.test("a dummy xeroPost makes the register fail", () => {
  const dummy = `
async function sneakyBill(client: any) {
  const { accessToken, tenantId } = await getToken(client)
  await xeroPost('/Invoices', accessToken, tenantId, { Invoices: [] }, 'PUT')
}`;
  const sites = scanSource("ops-api/sneaky.ts", dummy);
  assertEquals(sites.map((s) => s.key), [
    "ops-api/sneaky.ts :: sneakyBill :: PUT /Invoices",
  ]);
  const drift = registerDrift(sites.map((s) => s.key), {
    rows: REGISTER.rows,
    not_writes: REGISTER.not_writes,
  });
  assertEquals(drift.unregistered, [
    "ops-api/sneaky.ts :: sneakyBill :: PUT /Invoices",
  ]);
});

Deno.test("the scan finds direct fetch writes, transports passed in, and xero-sync write actions; not reads or comments", () => {
  const src = `
// await xeroPost('/Payments', a, t, {}, 'PUT')
export function gateway(deps: any) {
  return {
    async pay(id: string) {
      await deps.xeroPost(\`/Invoices/\${id}\`, a, t, {}, 'POST')
    },
  }
}
const attach = async (id: string) => {
  await fetchImpl(\`\${XERO_API_BASE}/Invoices/\${encodeURIComponent(id)}/Attachments/x.pdf\`, { method: "PUT" })
  await fetchImpl(\`\${XERO_API_BASE}/Invoices/\${id}\`, { headers: {} })
  await fetch('https://api.xero.com/api.xro/2.0/Contacts', { method: 'POST' })
}
async function link() {
  await fetch(\`\${SUPABASE_URL}/functions/v1/xero-sync?action=create_or_find_contact\`, { method: 'POST' })
  await fetch(\`\${SUPABASE_URL}/functions/v1/xero-sync?action=sync_invoices\`, { method: 'POST' })
}`;
  assertEquals(scanSource("x.ts", src).map((s) => s.key), [
    "x.ts :: gateway.pay :: POST /Invoices/{id}",
    "x.ts :: attach :: PUT /Invoices/{id}/Attachments/x.pdf",
    "x.ts :: attach :: POST /Contacts",
    "x.ts :: link :: POST xero-sync:create_or_find_contact",
  ]);
});

Deno.test("the register names the Xero paths the framework expects", async () => {
  const sites = await scanFunctions(FUNCTIONS);
  const keys = sites.map((s) => s.key);
  for (
    const expected of [
      "send-quote/index.ts :: createXeroQuote :: PUT /Quotes",
      "ops-api/index.ts :: reconcilePayment :: PUT /Payments",
      "ops-api/xero_attachment.ts :: attachPdfToXeroInvoice :: PUT /Invoices/{id}/Attachments/{id}",
      "ops-api/xero_accpay_books.ts :: createSupplierBill :: PUT /Invoices",
    ]
  ) {
    assert(keys.includes(expected), expected);
  }
});
