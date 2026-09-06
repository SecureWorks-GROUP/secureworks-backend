import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { QUOTE_SEND_CLAIM_TTL_MS } from "../_shared/trade_quote_pack/quote_send_publication.ts";
import {
  claimInvoiceEmailSend,
  invoiceEmailDocumentIdempotencyKey,
  invoiceEmailResendIdempotencyKey,
  invoiceEmailSendClaimPayload,
  publishInvoiceEmailSendOrRevert,
  revertInvoiceEmailSendClaim,
  touchInvoiceEmailSendClaim,
} from "./invoice_email_send_claim.ts";

const INVOICE = "xero-inv-1";
const JOB = "11111111-1111-1111-1111-111111111111";

type Row = {
  xero_invoice_id: string;
  job_id: string;
  send_claimed_at: string | null;
  send_claim_token: string | null;
  send_resend_idempotency_key: string | null;
  sent_at: string | null;
};

function makeInvoiceClaimSb(initial: Row | null = null) {
  let row = initial;
  const updates: Record<string, unknown>[] = [];
  const inserts: Record<string, unknown>[] = [];
  const eqs: Array<{ col: string; value: unknown }> = [];
  const filters: string[] = [];

  const api = {
    updates,
    inserts,
    eqs,
    filters,
    get row() {
      return row;
    },
    from(table: string) {
      assertEquals(table, "invoice_email_send_claims");
      return {
        select() {
          return {
            eq(col: string, value: unknown) {
              eqs.push({ col, value });
              return {
                maybeSingle: async () => ({ data: row, error: null }),
              };
            },
          };
        },
        insert(payload: Record<string, unknown>) {
          inserts.push(payload);
          return {
            select() {
              return {
                maybeSingle: async () => {
                  if (row) {
                    return {
                      data: null,
                      error: { code: "23505", message: "duplicate key" },
                    };
                  }
                  row = {
                    xero_invoice_id: String(payload.xero_invoice_id),
                    job_id: String(payload.job_id),
                    send_claimed_at: payload.send_claimed_at as string,
                    send_claim_token: payload.send_claim_token as string,
                    send_resend_idempotency_key:
                      payload.send_resend_idempotency_key as string,
                    sent_at: null,
                  };
                  return { data: { xero_invoice_id: INVOICE }, error: null };
                },
              };
            },
          };
        },
        update(payload: Record<string, unknown>) {
          updates.push(payload);
          const wanted: Record<string, unknown> = {};
          const chain = {
            eq(col: string, value: unknown) {
              eqs.push({ col, value });
              wanted[col] = value;
              return chain;
            },
            is(col: string, value: unknown) {
              filters.push(`is:${col}:${String(value)}`);
              wanted[`is:${col}`] = value;
              return chain;
            },
            lt(col: string, value: unknown) {
              filters.push(`lt:${col}`);
              wanted[`lt:${col}`] = value;
              return chain;
            },
            select() {
              return {
                maybeSingle: async () => {
                  if (!row) return { data: null, error: null };
                  if (wanted.xero_invoice_id && row.xero_invoice_id !== wanted.xero_invoice_id) {
                    return { data: null, error: null };
                  }
                  if (
                    wanted.send_claim_token &&
                    row.send_claim_token !== wanted.send_claim_token
                  ) {
                    return { data: null, error: null };
                  }
                  if ("is:send_claimed_at" in wanted && row.send_claimed_at != null) {
                    return { data: null, error: null };
                  }
                  if ("is:sent_at" in wanted && row.sent_at != null) {
                    return { data: null, error: null };
                  }
                  if ("lt:send_claimed_at" in wanted) {
                    const staleBefore = Date.parse(String(wanted["lt:send_claimed_at"]));
                    const claimed = row.send_claimed_at
                      ? Date.parse(row.send_claimed_at)
                      : NaN;
                    if (!Number.isFinite(claimed) || claimed >= staleBefore) {
                      return { data: null, error: null };
                    }
                  }
                  row = {
                    ...row,
                    job_id: typeof payload.job_id === "string" ? payload.job_id : row.job_id,
                    send_claimed_at: "send_claimed_at" in payload
                      ? (payload.send_claimed_at as string | null)
                      : row.send_claimed_at,
                    send_claim_token: "send_claim_token" in payload
                      ? (payload.send_claim_token as string | null)
                      : row.send_claim_token,
                    send_resend_idempotency_key: "send_resend_idempotency_key" in payload
                      ? (payload.send_resend_idempotency_key as string | null)
                      : row.send_resend_idempotency_key,
                    sent_at: "sent_at" in payload
                      ? (payload.sent_at as string | null)
                      : row.sent_at,
                  };
                  return {
                    data: {
                      xero_invoice_id: row.xero_invoice_id,
                      send_resend_idempotency_key: row.send_resend_idempotency_key,
                    },
                    error: null,
                  };
                },
              };
            },
          };
          return chain;
        },
      };
    },
  };
  return api;
}

Deno.test("R13-004 exclusive insert claims a new invoice send row", async () => {
  const sb = makeInvoiceClaimSb(null);
  const now = new Date("2026-09-06T12:00:00.000Z");
  const claimed = await claimInvoiceEmailSend(sb, INVOICE, JOB, now);
  assertEquals(claimed.status, "claimed");
  if (claimed.status === "claimed") {
    assertEquals(claimed.claim.xero_invoice_id, INVOICE);
    assertEquals(claimed.claim.job_id, JOB);
    assertEquals(
      claimed.claim.resend_idempotency_key,
      invoiceEmailResendIdempotencyKey(claimed.claim.token),
    );
  }
  assertEquals(sb.inserts.length, 1);
});

Deno.test("R13-004 published row is already_sent and not reclaimed", async () => {
  const sb = makeInvoiceClaimSb({
    xero_invoice_id: INVOICE,
    job_id: JOB,
    send_claimed_at: null,
    send_claim_token: null,
    send_resend_idempotency_key: "invoice-send:old",
    sent_at: "2026-09-06T11:00:00.000Z",
  });
  const claimed = await claimInvoiceEmailSend(
    sb,
    INVOICE,
    JOB,
    new Date("2026-09-06T12:00:00.000Z"),
  );
  assertEquals(claimed, { status: "already_sent" });
});

Deno.test("R13-004 fresh in-flight claim stays exclusive", async () => {
  const sb = makeInvoiceClaimSb({
    xero_invoice_id: INVOICE,
    job_id: JOB,
    send_claimed_at: "2026-09-06T11:55:00.000Z",
    send_claim_token: "live-token",
    send_resend_idempotency_key: "invoice-send:live-token",
    sent_at: null,
  });
  const claimed = await claimInvoiceEmailSend(
    sb,
    INVOICE,
    JOB,
    new Date("2026-09-06T12:00:00.000Z"),
  );
  assertEquals(claimed, { status: "unavailable" });
});

Deno.test("R13-004 stale reclaim keeps the first-claim Resend key", async () => {
  const firstKey = "invoice-send:first-token";
  const now = new Date("2026-09-06T12:00:00.000Z");
  const sb = makeInvoiceClaimSb({
    xero_invoice_id: INVOICE,
    job_id: JOB,
    send_claimed_at: new Date(now.getTime() - QUOTE_SEND_CLAIM_TTL_MS - 60_000).toISOString(),
    send_claim_token: "first-token",
    send_resend_idempotency_key: firstKey,
    sent_at: null,
  });
  const claimed = await claimInvoiceEmailSend(sb, INVOICE, JOB, now);
  assertEquals(claimed.status, "claimed");
  if (claimed.status === "claimed") {
    assertEquals(claimed.claim.resend_idempotency_key, firstKey);
    assertNotEquals(claimed.claim.token, "first-token");
  }
  assert(sb.filters.includes("lt:send_claimed_at"));
});

Deno.test("R13-004 missing stored key falls back to invoice-scoped Resend key", async () => {
  const now = new Date("2026-09-06T12:00:00.000Z");
  const sb = makeInvoiceClaimSb({
    xero_invoice_id: INVOICE,
    job_id: JOB,
    send_claimed_at: new Date(now.getTime() - QUOTE_SEND_CLAIM_TTL_MS - 60_000).toISOString(),
    send_claim_token: "old",
    send_resend_idempotency_key: null,
    sent_at: null,
  });
  const claimed = await claimInvoiceEmailSend(sb, INVOICE, JOB, now);
  assertEquals(claimed.status, "claimed");
  if (claimed.status === "claimed") {
    assertEquals(
      claimed.claim.resend_idempotency_key,
      invoiceEmailDocumentIdempotencyKey(INVOICE),
    );
  }
});

Deno.test("R13-004 heartbeat and publish are token-fenced", async () => {
  const sb = makeInvoiceClaimSb({
    xero_invoice_id: INVOICE,
    job_id: JOB,
    send_claimed_at: "2026-09-06T12:00:00.000Z",
    send_claim_token: "tok-owner",
    send_resend_idempotency_key: "invoice-send:tok-owner",
    sent_at: null,
  });
  const lost = await touchInvoiceEmailSendClaim(sb, INVOICE, "tok-other");
  assertEquals(lost.updated, false);
  const beat = await touchInvoiceEmailSendClaim(sb, INVOICE, "tok-owner");
  assertEquals(beat.updated, true);
  const published = await publishInvoiceEmailSendOrRevert(sb, INVOICE, "tok-owner");
  assertEquals(published, { published: true });
  assertEquals(typeof sb.row?.sent_at, "string");
  assertEquals(sb.row?.send_claim_token, null);
});

Deno.test("R13-004 revert is token-fenced and clears the Resend key", async () => {
  const sb = makeInvoiceClaimSb({
    xero_invoice_id: INVOICE,
    job_id: JOB,
    send_claimed_at: "2026-09-06T12:00:00.000Z",
    send_claim_token: "tok-owner",
    send_resend_idempotency_key: "invoice-send:tok-owner",
    sent_at: null,
  });
  const other = await revertInvoiceEmailSendClaim(sb, INVOICE, "tok-other");
  assertEquals(other.updated, false);
  assertEquals(sb.row?.send_resend_idempotency_key, "invoice-send:tok-owner");
  const own = await revertInvoiceEmailSendClaim(sb, INVOICE, "tok-owner");
  assertEquals(own.updated, true);
  assertEquals(sb.row?.send_claimed_at, null);
  assertEquals(sb.row?.send_claim_token, null);
  assertEquals(sb.row?.send_resend_idempotency_key, null);
});

Deno.test("R14-002 post-send revert keeps the first-claim Resend key", async () => {
  const sb = makeInvoiceClaimSb({
    xero_invoice_id: INVOICE,
    job_id: JOB,
    send_claimed_at: "2026-09-06T12:00:00.000Z",
    send_claim_token: "tok-owner",
    send_resend_idempotency_key: "invoice-send:tok-owner",
    sent_at: null,
  });
  const own = await revertInvoiceEmailSendClaim(sb, INVOICE, "tok-owner", "keep_provider_key");
  assertEquals(own.updated, true);
  assertEquals(sb.row?.send_claimed_at, null);
  assertEquals(sb.row?.send_claim_token, null);
  assertEquals(sb.row?.send_resend_idempotency_key, "invoice-send:tok-owner");
});

Deno.test("R13-004 exclusive claim payload mints invoice-send idempotency key", () => {
  const payload = invoiceEmailSendClaimPayload(
    new Date("2026-09-06T00:00:00.000Z"),
    "tok-1",
  );
  assertEquals(payload.send_claim_token, "tok-1");
  assertEquals(payload.send_resend_idempotency_key, "invoice-send:tok-1");
  assertEquals(payload.send_claimed_at, "2026-09-06T00:00:00.000Z");
});
