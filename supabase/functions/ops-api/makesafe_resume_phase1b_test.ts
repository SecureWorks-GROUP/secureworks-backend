// Phase 1b — resume-aware make-safe report send ORCHESTRATION tests.
//
// MONEY/COMMS critical. These exercise the LIVE index.ts orchestration
// (makesafeSendPack with injected network seams, makesafeResumeClose,
// makesafeResetFailedPack) against a write-capable fake Supabase client. They
// PROVE the money-safety invariants by asserting side-effect COUNTERS:
//   - authorised_not_sent re-call re-emails ONCE and does NOT re-authorise;
//   - sent_marker_failed resume writes marker + closes with NO email;
//   - sent_not_closed via makesafe_resume_close closes with ZERO email + ZERO
//     authorise (counters asserted);
//   - 'sending' without a resolution -> 409 (no email, no authorise);
//   - a sent/marker-present job -> already_sent no-op;
//   - TASK C (D-d): an ambiguous/post-dispatch email failure sets status='sending'
//     NOT authorised_not_sent (the double-email firewall);
//   - failed reset: resets a PRE-SEND failed pack with no marker; refuses a marker
//     or a post-email failed_step.
//
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 \
//        supabase/functions/ops-api/makesafe_resume_phase1b_test.ts
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _makesafeResetFailedPackForTest,
  _makesafeResumeCloseForTest,
  _makesafeSendPackForTest,
} from "./index.ts";

// ─────────────────────────────────────────────────────────────────
// A write-capable fake Supabase client. Tables are arrays of row objects.
// Supports the query shapes the handlers use: chained .eq(), .in(),
// .select(), .order(), .maybeSingle(), terminal await (then), plus the WRITE
// builders .insert()/.update()/.upsert() (with .eq() predicates + optional
// trailing .select() that returns the affected rows).
// ─────────────────────────────────────────────────────────────────
type Rows = Record<string, any[]>;

interface FakeOpts {
  // Force an .update() on this table to return an {error}.
  failUpdateTable?: string;
  // Force an .update() on this table to affect 0 rows (no matching predicate).
  zeroRowUpdateTable?: string;
  // Force an .insert() on this table to THROW (models a DB write that crashes).
  throwInsertTable?: string;
}

function makeClient(seed: Rows, opts: FakeOpts = {}) {
  const tables: Rows = {};
  for (const k of Object.keys(seed)) tables[k] = seed[k].map((r) => ({ ...r }));

  function builder(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let mode: "select" | "update" | "insert" | "upsert" = "select";
    let patch: any = null;
    let insertRow: any = null;
    const rowsRef = () => (tables[table] ||= []);

    const matched = () => rowsRef().filter((r) => preds.every((p) => p(r)));

    const applyWrite = () => {
      if (mode === "insert") {
        if (opts.throwInsertTable === table) {
          throw new Error(`forced insert throw on ${table}`);
        }
        rowsRef().push({ ...insertRow });
        return { data: [{ ...insertRow }], error: null };
      }
      if (mode === "upsert") {
        rowsRef().push({ ...insertRow });
        return { data: [{ ...insertRow }], error: null };
      }
      // update
      if (opts.failUpdateTable === table) {
        return {
          data: null,
          error: { message: `forced update error on ${table}` },
        };
      }
      const target = opts.zeroRowUpdateTable === table ? [] : matched();
      for (const r of target) Object.assign(r, patch);
      return { data: target.map((r) => ({ ...r })), error: null };
    };

    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => {
        preds.push((r) => r?.[col] === val);
        return b;
      },
      neq: (col: string, val: any) => {
        preds.push((r) => r?.[col] !== val);
        return b;
      },
      in: (col: string, vals: any[]) => {
        preds.push((r) => vals.includes(r?.[col]));
        return b;
      },
      not: () => b,
      order: () => b,
      limit: () => b,
      range: async (from: number, to: number) => ({
        data: matched().slice(from, to + 1),
        error: null,
      }),
      insert: (row: any) => {
        mode = "insert";
        insertRow = Array.isArray(row) ? row[0] : row;
        return b;
      },
      upsert: (row: any) => {
        mode = "upsert";
        insertRow = Array.isArray(row) ? row[0] : row;
        return b;
      },
      update: (p: any) => {
        mode = "update";
        patch = p;
        return b;
      },
      maybeSingle: async () => {
        const m = matched();
        return { data: m[0] ? { ...m[0] } : null, error: null };
      },
      single: async () => {
        const m = matched();
        return {
          data: m[0] ? { ...m[0] } : null,
          error: m[0] ? null : { message: "no rows" },
        };
      },
      // Terminal await for both reads and writes.
      then: (resolve: (v: any) => any) => {
        if (mode === "select") {
          return resolve({
            data: matched().map((r) => ({ ...r })),
            error: null,
          });
        }
        return resolve(applyWrite());
      },
    };
    return b;
  }

  return {
    _tables: tables,
    from: (table: string) => builder(table),
    storage: {
      from: () => ({
        createSignedUrl: async (p: string) => ({
          data: { signedUrl: `https://signed.test/${p}` },
          error: null,
        }),
      }),
    },
  };
}

// Side-effect counters + injectable network seams for makesafeSendPack.
function makeSeams(opts: {
  emailMode?: "ok" | "throw" | "status5xx" | "status4xx";
  emailStatus?: number;
} = {}) {
  const counts = {
    getToken: 0,
    authorise: 0,
    fetchInvoicePdf: 0,
    attachDoc: 0,
    fetchReportPdf: 0,
    email: 0,
  };
  const deps = {
    getToken: async (_c: any) => {
      counts.getToken++;
      return { accessToken: "tok", tenantId: "ten" };
    },
    xeroPost: async (
      path: string,
      _a: string,
      _t: string,
      body: any,
      _m?: string,
    ) => {
      // The send path only calls xeroPost to AUTHORISE the invoice.
      if (
        path.startsWith("/Invoices/") &&
        body?.Invoices?.[0]?.Status === "AUTHORISED"
      ) counts.authorise++;
      return { Invoices: [{ Status: "AUTHORISED" }] };
    },
    fetchInvoicePdfBytes: async () => {
      counts.fetchInvoicePdf++;
      return new Uint8Array([1, 2, 3]);
    },
    attachDoc: async (_c: any, _b: any) => {
      counts.attachDoc++;
      return { document_id: "doc-x" };
    },
    fetchReportPdfBytes: async () => {
      counts.fetchReportPdf++;
      return new Uint8Array([4, 5, 6]);
    },
    sendEmail: async (_payload: any) => {
      counts.email++;
      if (opts.emailMode === "throw") {
        throw new Error("ECONNRESET after dispatch");
      }
      if (opts.emailMode === "status5xx") {
        return {
          ok: false,
          status: opts.emailStatus ?? 503,
          bodyText: async () => "upstream 503",
          json: async () => ({}),
        };
      }
      if (opts.emailMode === "status4xx") {
        return {
          ok: false,
          status: opts.emailStatus ?? 400,
          bodyText: async () => "bad payload",
          json: async () => ({}),
        };
      }
      return {
        ok: true,
        status: 200,
        bodyText: async () => "",
        json: async () => ({ message_id: "msg-1" }),
      };
    },
  };
  return { counts, deps };
}

const MARKER =
  "MAKESAFE_PACK_SENT | main | INV-1 | to=workorders@b.com | 2026-06-17T00:00:00Z";
const CTX = { approverId: "u1", approverEmail: "admin@x.com" };

// A ready-to-send seed: DRAFT invoice mapped to the job, report+invoice+(no swms,
// non-MLB) docs present, report_recipient configured, pack lockable.
function readySeed(extra: Partial<Rows> = {}): Rows {
  return {
    jobs: [{
      id: "job-1",
      job_number: "MS-1",
      type: "makesafe",
      status: "invoiced",
      client_name: "Jane",
    }],
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "admin_to_send_report",
      external_ref: "B-1",
      report_sent_at: null,
      makesafe_companies: {
        slug: "b",
        name: "Builder Co",
        report_recipient: "workorders@b.com",
      },
    }],
    job_documents: [
      {
        id: "d-rep",
        job_id: "job-1",
        type: "makesafe_report",
        file_name: "Make Safe Report B-1.pdf",
        storage_url: "https://docs.test/r.pdf",
        pdf_url: null,
      },
      {
        id: "d-inv",
        job_id: "job-1",
        type: "invoice",
        file_name: "Xero Invoice INV-1.pdf",
        storage_url: "https://docs.test/i.pdf",
        pdf_url: null,
      },
    ],
    xero_invoices: [{
      xero_invoice_id: "xi-1",
      invoice_number: "INV-1",
      status: "DRAFT",
      reference: "B-1",
      job_id: "job-1",
      invoice_date: "2026-06-17",
    }],
    makesafe_report_packs: [{
      id: "p-1",
      job_id: "job-1",
      pack_kind: "main",
      status: "drafted",
      report_doc_id: "d-rep",
      xero_invoice_id: "xi-1",
    }],
    job_events: [],
    business_events: [],
    ...extra,
  };
}

function packOf(client: any) {
  return client._tables.makesafe_report_packs.find((p: any) =>
    p.job_id === "job-1"
  );
}
function markerCount(client: any) {
  return client._tables.job_events.filter((e: any) =>
    e.event_type === "note" &&
    String(e.detail_json?.text || "").startsWith("MAKESAFE_PACK_SENT | main")
  ).length;
}

// ═════════════════════════════════════════════════════════════════
// 1. HAPPY PATH baseline — one email, one authorise, marker written, closed.
// ═════════════════════════════════════════════════════════════════
Deno.test("send_pack: happy path -> ONE authorise + ONE email + marker + close", async () => {
  const client = makeClient(readySeed());
  const { counts, deps } = makeSeams({ emailMode: "ok" });
  const res: any = await _makesafeSendPackForTest(
    client,
    {
      job_id: "job-1",
      recipient_email: "workorders@b.com",
      subject: "Make Safe Completion B-1",
      html_body: "<p>done</p>",
    },
    CTX,
    deps,
  );
  assertEquals(res.sent, true);
  assertEquals(res.status, "sent");
  assertEquals(counts.authorise, 1, "exactly one authorise");
  assertEquals(counts.email, 1, "exactly one email");
  assertEquals(markerCount(client), 1, "one marker written");
  assertEquals(packOf(client).status, "sent");
});

// ═════════════════════════════════════════════════════════════════
// 2. RESUME: authorised_not_sent -> re-email ONCE, NO re-authorise.
// ═════════════════════════════════════════════════════════════════
Deno.test("resume: authorised_not_sent re-call emails ONCE and does NOT re-authorise", async () => {
  const seed = readySeed();
  // The invoice is already AUTHORISED; the pack is authorised_not_sent (send failed
  // last time). The resume must skip authorise and email exactly once.
  seed.xero_invoices[0].status = "AUTHORISED";
  seed.makesafe_report_packs[0].status = "authorised_not_sent";
  seed.makesafe_report_packs[0].invoice_status = "AUTHORISED";
  const client = makeClient(seed);
  const { counts, deps } = makeSeams({ emailMode: "ok" });
  const res: any = await _makesafeSendPackForTest(
    client,
    {
      job_id: "job-1",
      recipient_email: "workorders@b.com",
      subject: "Make Safe Completion B-1",
      html_body: "<p>done</p>",
    },
    CTX,
    deps,
  );
  assertEquals(res.sent, true);
  assertEquals(
    counts.authorise,
    0,
    "must NOT re-authorise an already-authorised invoice",
  );
  assertEquals(counts.email, 1, "must re-email exactly ONCE");
  assertEquals(markerCount(client), 1);
  assertEquals(packOf(client).status, "sent");
});

// ═════════════════════════════════════════════════════════════════
// 3. RESUME: sent_marker_failed -> marker + close, NO email, NO authorise.
// ═════════════════════════════════════════════════════════════════
Deno.test("resume: sent_marker_failed -> writes marker + closes, ZERO email + ZERO authorise", async () => {
  const seed = readySeed();
  seed.xero_invoices[0].status = "AUTHORISED";
  seed.makesafe_report_packs[0].status = "sent_marker_failed";
  // No marker yet (that is the failure) — planPostSendResume writes it.
  const client = makeClient(seed);
  const { counts, deps } = makeSeams({ emailMode: "ok" });
  const res: any = await _makesafeSendPackForTest(
    client,
    {
      job_id: "job-1",
      recipient_email: "workorders@b.com",
      subject: "s",
      html_body: "<p>x</p>",
    },
    CTX,
    deps,
  );
  assertEquals(res.resumed, true);
  assertEquals(res.action, "marker_and_close");
  assertEquals(counts.email, 0, "NO email on a marker_and_close recovery");
  assertEquals(counts.authorise, 0, "NO authorise on recovery");
  assertEquals(markerCount(client), 1, "the missing marker is written");
  assertEquals(packOf(client).status, "sent");
});

// ═════════════════════════════════════════════════════════════════
// 4. RESUME: 'sending' WITHOUT a resolution -> 409, NO email, NO authorise.
// ═════════════════════════════════════════════════════════════════
Deno.test("resume: 'sending' without sending_resolution -> 409 (no email, no authorise)", async () => {
  const seed = readySeed();
  seed.xero_invoices[0].status = "AUTHORISED";
  seed.makesafe_report_packs[0].status = "sending";
  seed.makesafe_report_packs[0].send_started_at = new Date(
    Date.now() - 10 * 60 * 1000,
  ).toISOString();
  const client = makeClient(seed);
  const { counts, deps } = makeSeams({ emailMode: "ok" });
  const res: any = await _makesafeSendPackForTest(
    client,
    {
      job_id: "job-1",
      recipient_email: "workorders@b.com",
      subject: "s",
      html_body: "<p>x</p>",
    },
    CTX,
    deps,
  );
  assert(res.error, "must return an error/409 shape");
  assertEquals(res.requires, "sending_resolution");
  assertEquals(counts.email, 0);
  assertEquals(counts.authorise, 0);
});

Deno.test("resume guard: 'sending' + draft_pack cannot use sending_resolution or send", async () => {
  const seed = readySeed();
  seed.xero_invoices[0].status = "AUTHORISED";
  seed.makesafe_report_packs[0].status = "sending";
  seed.makesafe_report_packs[0].failed_step = "draft_pack";
  seed.makesafe_report_packs[0].send_started_at = new Date(
    Date.now() - 10 * 60 * 1000,
  ).toISOString();
  const client = makeClient(seed);
  const { counts, deps } = makeSeams({ emailMode: "ok" });
  const res: any = await _makesafeSendPackForTest(
    client,
    {
      job_id: "job-1",
      recipient_email: "workorders@b.com",
      subject: "s",
      html_body: "<p>x</p>",
      sending_resolution: "confirmed_not_sent",
    },
    CTX,
    deps,
  );
  assert(res.error, "must return an error shape");
  assertEquals(res.requires, "draft_pack_retry_or_reset");
  assertEquals(res.failed_step, "draft_pack");
  assertEquals(counts.email, 0);
  assertEquals(counts.authorise, 0);
  assertEquals(packOf(client).status, "sending");
});

// ═════════════════════════════════════════════════════════════════
// 5. IDEMPOTENCY: a marker-present (sent) job -> already_sent no-op.
// ═════════════════════════════════════════════════════════════════
Deno.test("idempotency: marker present -> already_sent, NO email, NO authorise", async () => {
  const seed = readySeed();
  seed.job_events = [{
    job_id: "job-1",
    event_type: "note",
    detail_json: { text: MARKER },
  }];
  const client = makeClient(seed);
  const { counts, deps } = makeSeams({ emailMode: "ok" });
  const res: any = await _makesafeSendPackForTest(
    client,
    {
      job_id: "job-1",
      recipient_email: "workorders@b.com",
      subject: "s",
      html_body: "<p>x</p>",
    },
    CTX,
    deps,
  );
  assertEquals(res.already_sent, true);
  assertEquals(counts.email, 0);
  assertEquals(counts.authorise, 0);
});

// ═════════════════════════════════════════════════════════════════
// 6. TASK C (D-d) — the DOUBLE-EMAIL FIREWALL. An ambiguous/post-dispatch email
//    failure must set status='sending' NOT 'authorised_not_sent'.
// ═════════════════════════════════════════════════════════════════
Deno.test("D-d: email DISPATCH THROWS (timeout/network) -> status='sending', NOT authorised_not_sent", async () => {
  const client = makeClient(readySeed());
  const { counts, deps } = makeSeams({ emailMode: "throw" });
  let threw = false;
  try {
    await _makesafeSendPackForTest(
      client,
      {
        job_id: "job-1",
        recipient_email: "workorders@b.com",
        subject: "s",
        html_body: "<p>x</p>",
      },
      CTX,
      deps,
    );
  } catch (_e) {
    threw = true;
  }
  assert(threw, "an unknown-outcome dispatch throw should surface as an error");
  assertEquals(
    counts.authorise,
    1,
    "the invoice WAS authorised before the send",
  );
  assertEquals(counts.email, 1, "the send was attempted once (dispatched)");
  const p = packOf(client);
  assertEquals(
    p.status,
    "sending",
    "unknown outcome must land in 'sending' (NOT authorised_not_sent)",
  );
  assert(
    p.status !== "authorised_not_sent",
    "must NEVER be authorised_not_sent (would re-offer a send => double-email)",
  );
  assertEquals(markerCount(client), 0, "no marker on an unknown outcome");
});

Deno.test("D-d: email returns 5xx (ambiguous) -> status='sending', NOT authorised_not_sent", async () => {
  const client = makeClient(readySeed());
  const { counts, deps } = makeSeams({
    emailMode: "status5xx",
    emailStatus: 502,
  });
  try {
    await _makesafeSendPackForTest(
      client,
      {
        job_id: "job-1",
        recipient_email: "workorders@b.com",
        subject: "s",
        html_body: "<p>x</p>",
      },
      CTX,
      deps,
    );
  } catch (_e) { /* expected */ }
  assertEquals(counts.authorise, 1);
  assertEquals(
    packOf(client).status,
    "sending",
    "a 5xx is ambiguous (may have dispatched) -> sending",
  );
});

Deno.test("D-d: AMBIGUOUS 4xx (e.g. 408 timeout) -> 'sending', NOT authorised_not_sent", async () => {
  // The codex-review hardening: a 408/429-class 4xx is NOT proof of pre-dispatch.
  const client = makeClient(readySeed());
  const { counts, deps } = makeSeams({
    emailMode: "status4xx",
    emailStatus: 408,
  });
  try {
    await _makesafeSendPackForTest(
      client,
      {
        job_id: "job-1",
        recipient_email: "workorders@b.com",
        subject: "s",
        html_body: "<p>x</p>",
      },
      CTX,
      deps,
    );
  } catch (_e) { /* expected */ }
  assertEquals(counts.authorise, 1);
  assertEquals(
    packOf(client).status,
    "sending",
    "a 408 is ambiguous -> sending, never authorised_not_sent",
  );
});

Deno.test("D-d: a marker-step throw AFTER a successful send -> sent_marker_failed (NOT authorised_not_sent)", async () => {
  // The email returns ok, then the marker job_events insert throws. The send went
  // out, so the state must be sent_marker_failed (resume writes the marker, no
  // re-email) — and crucially NEVER authorised_not_sent (which would re-offer a send).
  const client = makeClient(readySeed(), { throwInsertTable: "job_events" });
  const { counts, deps } = makeSeams({ emailMode: "ok" });
  try {
    await _makesafeSendPackForTest(
      client,
      {
        job_id: "job-1",
        recipient_email: "workorders@b.com",
        subject: "s",
        html_body: "<p>x</p>",
      },
      CTX,
      deps,
    );
  } catch (_e) { /* expected */ }
  assertEquals(counts.email, 1, "the email DID go out once");
  const p = packOf(client);
  assert(
    p.status === "sent_marker_failed" || p.status === "sending",
    `post-send marker failure must be sent_marker_failed or sending, got ${p.status}`,
  );
  assert(
    p.status !== "authorised_not_sent",
    "must NEVER be authorised_not_sent after a real send",
  );
});

Deno.test("D-d contrast: a CLEAN 4xx pre-dispatch reject -> authorised_not_sent (re-send is safe)", async () => {
  // The other side of the firewall: a provable pre-dispatch rejection (4xx) is the
  // ONLY non-OK case that may set authorised_not_sent (re-email later is safe).
  const client = makeClient(readySeed());
  const { counts, deps } = makeSeams({
    emailMode: "status4xx",
    emailStatus: 400,
  });
  try {
    await _makesafeSendPackForTest(
      client,
      {
        job_id: "job-1",
        recipient_email: "workorders@b.com",
        subject: "s",
        html_body: "<p>x</p>",
      },
      CTX,
      deps,
    );
  } catch (_e) { /* expected */ }
  assertEquals(counts.authorise, 1);
  assertEquals(
    packOf(client).status,
    "authorised_not_sent",
    "a clean 4xx is provably not-sent -> authorised_not_sent",
  );
});

// ═════════════════════════════════════════════════════════════════
// 7. makesafe_resume_close (TASK B) — close-only, ZERO email + ZERO authorise.
//    (No network seams are even available to this handler — it is structurally
//    incapable of emailing/authorising.)
// ═════════════════════════════════════════════════════════════════
function closeSeed(packStatus: string, withMarker: boolean): Rows {
  return {
    makesafe_report_packs: [{
      id: "p-1",
      job_id: "job-1",
      pack_kind: "main",
      status: packStatus,
      sent_at: "2026-06-17T00:00:00Z",
    }],
    makesafe_job_details: [{
      job_id: "job-1",
      substatus: "admin_to_send_report",
      report_sent_at: null,
    }],
    job_events: withMarker
      ? [{ job_id: "job-1", event_type: "note", detail_json: { text: MARKER } }]
      : [],
  };
}

Deno.test("resume_close: sent_not_closed + marker -> close applied, pack->sent, ZERO email/authorise", async () => {
  const client = makeClient(closeSeed("sent_not_closed", true));
  const res: any = await _makesafeResumeCloseForTest(client, {
    job_id: "job-1",
  });
  assertEquals(res.resumed, true);
  assertEquals(res.closed, true);
  assertEquals(res.emailed, false);
  assertEquals(res.authorised, false);
  assertEquals(packOf(client).status, "sent");
  assertEquals(client._tables.makesafe_job_details[0].substatus, "complete");
  assert(
    client._tables.makesafe_job_details[0].report_sent_at,
    "report_sent_at stamped",
  );
});

Deno.test("resume_close: close_failed + marker -> close applied", async () => {
  const client = makeClient(closeSeed("close_failed", true));
  const res: any = await _makesafeResumeCloseForTest(client, {
    job_id: "job-1",
  });
  assertEquals(res.closed, true);
  assertEquals(packOf(client).status, "sent");
});

Deno.test("resume_close: wrong status (authorised_not_sent) -> refused, pack NOT marked sent", async () => {
  const client = makeClient(closeSeed("authorised_not_sent", true));
  const res: any = await _makesafeResumeCloseForTest(client, {
    job_id: "job-1",
  });
  assert(res.error, "must refuse a non-close-recoverable status");
  assertEquals(
    packOf(client).status,
    "authorised_not_sent",
    "status untouched on refusal",
  );
});

Deno.test("resume_close: marker ABSENT -> refused (no proof of send)", async () => {
  const client = makeClient(closeSeed("sent_not_closed", false));
  const res: any = await _makesafeResumeCloseForTest(client, {
    job_id: "job-1",
  });
  assert(res.error, "must refuse when no marker");
  assert(String(res.error).includes("marker"));
  assertEquals(
    packOf(client).status,
    "sent_not_closed",
    "status untouched on refusal",
  );
});

Deno.test("resume_close: a FAILED close update does NOT mark the pack sent", async () => {
  // The update-error guard: if the makesafe_job_details update errors, the pack
  // must NOT be flipped to 'sent'.
  const client = makeClient(closeSeed("sent_not_closed", true), {
    failUpdateTable: "makesafe_job_details",
  });
  let threw = false;
  try {
    await _makesafeResumeCloseForTest(client, { job_id: "job-1" });
  } catch (_e) {
    threw = true;
  }
  assert(threw, "a failed close update must throw");
  assertEquals(
    packOf(client).status,
    "sent_not_closed",
    "pack must NOT be marked sent on a failed update",
  );
});

Deno.test("resume_close: a ZERO-ROW close update does NOT mark the pack sent", async () => {
  const client = makeClient(closeSeed("sent_not_closed", true), {
    zeroRowUpdateTable: "makesafe_job_details",
  });
  let threw = false;
  try {
    await _makesafeResumeCloseForTest(client, { job_id: "job-1" });
  } catch (_e) {
    threw = true;
  }
  assert(threw, "a 0-row close update must throw (no job detail updated)");
  assertEquals(
    packOf(client).status,
    "sent_not_closed",
    "pack must NOT be marked sent on a 0-row update",
  );
});

// ═════════════════════════════════════════════════════════════════
// 8. makesafe_reset_failed_pack (TASK D) — pre-send failed reset; refuse marker /
//    post-email failed_step.
// ═════════════════════════════════════════════════════════════════
function resetSeed(
  packStatus: string,
  failedStep: string | null,
  withMarker: boolean,
): Rows {
  return {
    makesafe_report_packs: [{
      id: "p-1",
      job_id: "job-1",
      pack_kind: "main",
      status: packStatus,
      failed_step: failedStep,
    }],
    job_events: withMarker
      ? [{ job_id: "job-1", event_type: "note", detail_json: { text: MARKER } }]
      : [],
  };
}

Deno.test("reset: a PRE-SEND failed pack with NO marker resets to lockable 'drafted'", async () => {
  const client = makeClient(resetSeed("failed", "preflight_docs", false));
  const res: any = await _makesafeResetFailedPackForTest(client, {
    job_id: "job-1",
  });
  assertEquals(res.reset, true);
  assertEquals(res.status, "drafted");
  assertEquals(packOf(client).status, "drafted");
  assertEquals(packOf(client).failed_step, null);
});

Deno.test("reset: REFUSES a failed pack that has a MAKESAFE_PACK_SENT marker", async () => {
  const client = makeClient(resetSeed("failed", "preflight_docs", true));
  const res: any = await _makesafeResetFailedPackForTest(client, {
    job_id: "job-1",
  });
  assert(res.error, "must refuse when a marker is present");
  assertEquals(packOf(client).status, "failed", "status untouched on refusal");
});

Deno.test("reset: REFUSES a POST-email failed_step (send/marker/close)", async () => {
  for (const step of ["send", "marker", "close", "send_unknown_outcome"]) {
    const client = makeClient(resetSeed("failed", step, false));
    const res: any = await _makesafeResetFailedPackForTest(client, {
      job_id: "job-1",
    });
    assert(res.error, `must refuse post-email step ${step}`);
    assertEquals(packOf(client).status, "failed");
  }
});

Deno.test("reset: REFUSES a pack that is not in 'failed' status", async () => {
  const client = makeClient(resetSeed("sent", "preflight_docs", false));
  const res: any = await _makesafeResetFailedPackForTest(client, {
    job_id: "job-1",
  });
  assert(res.error);
  assertEquals(packOf(client).status, "sent");
});
