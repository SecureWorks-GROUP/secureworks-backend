// deno-lint-ignore-file no-explicit-any no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  attachBankTransactionReceipt,
  bankReceiptDoorDecision,
} from "./xero_bank_receipt_attach.ts";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TXN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LOCAL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RECEIPT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const PDF = (() => {
  const encoded = new TextEncoder().encode("%PDF-1.4\nZZTEST\n");
  const bytes = new Uint8Array(encoded.byteLength);
  bytes.set(encoded);
  return bytes;
})();

function caller(role: string | null, authMode = "jwt", orgId: string | null = ORG) {
  return { authMode, role, orgId };
}

function db(opts: {
  flags?: Record<string, boolean>;
  txn?: { id: string; org_id: string; xero_txn_id: string } | null;
  attached?: boolean;
  receipt?: { id: string; receipt_storage_bucket: string | null; receipt_storage_path: string } | null;
} = {}) {
  const tables: string[] = [];
  const inserts: any[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      if (table === "feature_flags") {
        return {
          select() {
            return {
              eq(_column: string, name: string) {
                return {
                  limit: () => Promise.resolve({
                    data: [{ enabled: opts.flags?.[name] === true }],
                    error: null,
                  }),
                };
              },
            };
          },
        };
      }
      if (table === "xero_bank_transactions") {
        const filters: Record<string, string> = {};
        const node: any = {
          select() { return node; },
          eq(column: string, value: string) {
            filters[column] = value;
            return node;
          },
          limit() {
            const txn = opts.txn;
            const match = txn && filters.org_id === txn.org_id &&
              (filters.xero_txn_id === txn.xero_txn_id || filters.id === txn.id);
            return Promise.resolve({ data: match ? [txn] : [], error: null });
          },
        };
        return node;
      }
      if (table === "xero_document_attachments") {
        const node: any = {
          select() { return node; },
          eq() { return node; },
          limit: () => Promise.resolve({ data: opts.attached ? [{ id: "ZZTEST" }] : [], error: null }),
          insert(row: any) {
            inserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
        return node;
      }
      if (table === "expense_receipts") {
        const node: any = {
          select() { return node; },
          eq() { return node; },
          limit: () => Promise.resolve({ data: opts.receipt ? [opts.receipt] : [], error: null }),
        };
        return node;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client, tables, inserts };
}

Deno.test("bank receipt door refuses trades, signed-out callers and the server key", () => {
  for (const role of ["owner", "admin", "ops_manager", "bookkeeper"]) {
    assertEquals(bankReceiptDoorDecision("jwt", role).ok, true, role);
  }
  for (const role of ["crew", "installer", "trade", "lead_installer"]) {
    const decision = bankReceiptDoorDecision("jwt", role);
    assertEquals(decision.ok, false, role);
    if (!decision.ok) assertEquals(decision.status, 403, role);
  }
  const signedOut = bankReceiptDoorDecision("none", null);
  const serverKey = bankReceiptDoorDecision("api_key", "owner");
  assertEquals(signedOut.ok, false);
  assertEquals(serverKey.ok, false);
  if (!signedOut.ok) assertEquals(signedOut.status, 403);
  if (!serverKey.ok) assertEquals(serverKey.status, 403);
});

Deno.test("bank receipt attachment is refused before any read when the caller is not allowed", async () => {
  const store = db({ flags: { xero_bank_txn_receipt_attach_v1: true }, txn: { id: LOCAL, org_id: ORG, xero_txn_id: TXN } });
  let downloads = 0;
  let tokens = 0;
  const result = await attachBankTransactionReceipt(store.client, {
    xero_bank_transaction_id: TXN,
    storage_path: "ZZTEST/receipt.pdf",
  }, {
    caller: caller("crew"),
    getToken: () => {
      tokens += 1;
      return Promise.resolve({ accessToken: "fixture-token", tenantId: "fixture-tenant" });
    },
    downloadStorage: () => {
      downloads += 1;
      return Promise.resolve(PDF);
    },
  });
  assertEquals(result.status, 403);
  assertEquals(result.body.code, "forbidden");
  assertEquals(store.tables, []);
  assertEquals(downloads, 0);
  assertEquals(tokens, 0);
});

Deno.test("bank receipt attachment does nothing while its switch is off", async () => {
  const store = db({ flags: { xero_bank_txn_receipt_attach_v1: false } });
  let downloads = 0;
  let fetches = 0;
  const result = await attachBankTransactionReceipt(store.client, {
    xero_bank_transaction_id: TXN,
    storage_path: "ZZTEST/receipt.pdf",
  }, {
    caller: caller("bookkeeper"),
    getToken: () => Promise.reject(new Error("token read")),
    fetchImpl: (() => {
      fetches += 1;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
    downloadStorage: () => {
      downloads += 1;
      return Promise.resolve(PDF);
    },
  });
  assertEquals(result.status, 409);
  assertEquals(result.body.code, "xero_bank_txn_receipt_attach_disabled");
  assertEquals(store.tables, ["feature_flags"]);
  assertEquals(store.inserts, []);
  assertEquals(downloads, 0);
  assertEquals(fetches, 0);
});

Deno.test("bank receipt attachment puts the file on the caller's bank transaction once", async () => {
  const urls: string[] = [];
  const store = db({
    flags: { xero_bank_txn_receipt_attach_v1: true },
    txn: { id: LOCAL, org_id: ORG, xero_txn_id: TXN },
  });
  const result = await attachBankTransactionReceipt(store.client, {
    xero_bank_transaction_id: LOCAL,
    storage_bucket: "expense-receipts",
    storage_path: "ZZTEST/receipt.pdf",
    file_name: "ZZTEST receipt.pdf",
  }, {
    caller: caller("owner"),
    getToken: () => Promise.resolve({ accessToken: "fixture-token", tenantId: "fixture-tenant" }),
    fetchImpl: ((url, init) => {
      urls.push(String(url));
      assertEquals(init?.method, "PUT");
      assertEquals(new Headers(init?.headers).get("Authorization"), "Bearer fixture-token");
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
    downloadStorage: () => Promise.resolve(PDF),
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.attached, true);
  assertEquals(result.body.xero_bank_transaction_id, TXN);
  assertEquals(urls, [
    `https://api.xero.com/api.xro/2.0/BankTransactions/${TXN}/Attachments/ZZTEST_receipt.pdf`,
  ]);
  assertEquals(store.inserts.length, 1);
  assertEquals(store.inserts[0].status, "attached");
  assertEquals(store.inserts[0].org_id, ORG);
  assertEquals(typeof result.body.file_sha256, "string");
});

Deno.test("the same receipt sha is not sent to Xero again", async () => {
  let fetches = 0;
  const store = db({
    flags: { xero_bank_txn_receipt_attach_v1: true },
    txn: { id: LOCAL, org_id: ORG, xero_txn_id: TXN },
    attached: true,
    receipt: {
      id: RECEIPT,
      receipt_storage_bucket: "expense-receipts",
      receipt_storage_path: "ZZTEST/from-receipt.pdf",
    },
  });
  const result = await attachBankTransactionReceipt(store.client, {
    xero_bank_transaction_id: TXN,
    receipt_id: RECEIPT,
  }, {
    caller: caller("ops_manager"),
    getToken: () => Promise.reject(new Error("token read")),
    fetchImpl: (() => {
      fetches += 1;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
    downloadStorage: (_bucket, path) => {
      assertEquals(path, "ZZTEST/from-receipt.pdf");
      return Promise.resolve(PDF);
    },
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.skipped, "already_attached");
  assertEquals(fetches, 0);
  assertEquals(store.inserts, []);
});

Deno.test("a bank receipt that is not a PDF or photo never calls Xero", async () => {
  let tokens = 0;
  const store = db({
    flags: { xero_bank_txn_receipt_attach_v1: true },
    txn: { id: LOCAL, org_id: ORG, xero_txn_id: TXN },
  });
  const result = await attachBankTransactionReceipt(store.client, {
    xero_bank_transaction_id: TXN,
    storage_path: "ZZTEST/notes.txt",
  }, {
    caller: caller("admin"),
    getToken: () => {
      tokens += 1;
      return Promise.resolve({ accessToken: "fixture-token", tenantId: "fixture-tenant" });
    },
    downloadStorage: () => Promise.resolve(new Uint8Array([1, 2, 3, 4])),
  });
  assertEquals(result.status, 400);
  assertEquals(result.body.code, "FILE_TYPE_NOT_ALLOWED");
  assertEquals(tokens, 0);
  assertEquals(store.inserts, []);
});

Deno.test("a bank transaction outside the caller org is not found and no file is read", async () => {
  let downloads = 0;
  const store = db({
    flags: { xero_bank_txn_receipt_attach_v1: true },
    txn: { id: LOCAL, org_id: ORG, xero_txn_id: TXN },
  });
  const result = await attachBankTransactionReceipt(store.client, {
    xero_bank_transaction_id: TXN,
    storage_path: "ZZTEST/receipt.pdf",
  }, {
    caller: caller("bookkeeper", "jwt", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
    getToken: () => Promise.reject(new Error("token read")),
    downloadStorage: () => {
      downloads += 1;
      return Promise.resolve(PDF);
    },
  });
  assertEquals(result.status, 404);
  assertEquals(result.body.code, "BANK_TXN_NOT_FOUND");
  assertEquals(downloads, 0);
});

Deno.test("a 429 from a bank receipt attach is returned once and recorded as failed", async () => {
  let fetches = 0;
  const store = db({
    flags: { xero_bank_txn_receipt_attach_v1: true },
    txn: { id: LOCAL, org_id: ORG, xero_txn_id: TXN },
  });
  const result = await attachBankTransactionReceipt(store.client, {
    xero_bank_transaction_id: TXN,
    storage_path: "../secret.pdf",
  }, {
    caller: caller("bookkeeper"),
    getToken: () => Promise.resolve({ accessToken: "fixture-token", tenantId: "fixture-tenant" }),
    fetchImpl: (() => {
      fetches += 1;
      return Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "15" } }));
    }) as typeof fetch,
    downloadStorage: () => Promise.resolve(PDF),
  });
  assertEquals(result.status, 400);
  assertEquals(result.body.code, "STORAGE_PATH_INVALID");
  assertEquals(fetches, 0);

  const limited = await attachBankTransactionReceipt(store.client, {
    xero_bank_transaction_id: TXN,
    storage_path: "ZZTEST/receipt.pdf",
  }, {
    caller: caller("bookkeeper"),
    getToken: () => Promise.resolve({ accessToken: "fixture-token", tenantId: "fixture-tenant" }),
    fetchImpl: (() => {
      fetches += 1;
      return Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "15" } }));
    }) as typeof fetch,
    downloadStorage: () => Promise.resolve(PDF),
  });
  assertEquals(limited.status, 429);
  assertEquals(limited.body.code, "XERO_RATE_LIMITED");
  assertEquals(fetches, 1);
  assertEquals(store.inserts.at(-1).status, "failed");
  assertEquals(store.inserts.at(-1).error_code, "XERO_RATE_LIMITED");
});
