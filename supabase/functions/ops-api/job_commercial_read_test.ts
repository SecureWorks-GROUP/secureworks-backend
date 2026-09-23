// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
//
// Context slice D1 (23 Sep 2026): the job read answers "what was quoted, for
// how much, which version, accepted or not", the variations and the scope.
//
// Named rows (dossier design section 10; row labels only, synthetic ids,
// emails and money shaped on each row). The job_quote_values rows each fixture
// feeds the reader are exactly what the SQL contract
// supabase/tests/migration-contracts/20260923233000_job_quote_values proves
// the function returns for the same shape, so the two tests chain.
//
// Pins (named rows are the LIVE shapes read from production on 23 Sep 2026):
//   R3  SWF-261458  one sealed quote: $4,776.75 from its revision.
//   R6  SWF-26818   Q-0491 v2 current with no sealed value (null, never
//                   invented; a forged log row is ignored); the REAR run
//                   document has no party and is the client's, $4,842.45;
//                   superseded Q-0439 ($5,571.50) is history; variation $374
//                   pending, not agreed.
//   R7  SWF-261355  accepted Q-0738 with no sealed value: accepted, value null
//                   with the reason, never the live price.
//   R8  SWF-26163   variation approved with no send and no acceptance reads
//                   "approved internally, customer acceptance not recorded".
//   R9  SWF-26177   $7,000 variation pending since 4 Jun: listed with age.
//   R10 SWP-261456  no quote document (emailed from Outlook): none_recorded
//                   with the honest note; live price separate.
//   R12 SWMS-261464 no scope: scope no_scope, no error.
//   R14 SWF-26904   three parties recorded, one whole quote: its $7,733.
//   R15 SWF-26395   per-party whole quotes; party C never accepted:
//                   partially_accepted naming her; no party shows the whole
//                   job's $5,104 (job level only).
//   R23 SWF-26167 / SWF-261111 / SWF-26997 / SWP-26634  recipient_mismatch
//                   and "sent, but to <address>".
//   R24 SWP-261203  changed_since_last_quote by the rule (live: never sent).
//   Send-runs shape (synthetic, no named row has live run parties): each
//   party's own share; accepted only when every party on every run accepted.
//   Invoice read agrees with the job read on quote total and variations.
//   Failures: a failed value read is a null section with a code; a failed
//   recipient read keeps values and marks sent_to unknown.
//   Read only: the dossier makes no insert/update/delete/upsert, calls only
//   the job_quote_values RPC, and makes no network call.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildJobQuotes,
  currentPriceIncGst,
  decodeVariationText,
  readJobQuotes,
  readJobVariations,
  summariseScope,
  variationView,
} from "./job_commercial_read.ts";
import { _assembleJobDossierForTest } from "./index.ts";
import { invoiceContext } from "./invoice_context.ts";
import { isCurrentContextFact } from "./context_visibility.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-09-23T06:00:00.000Z");

type Tables = Record<string, any[]>;

// ── fake client: filters honoured, writes trapped ───────────────────────────

const WRITE_METHODS = ["insert", "update", "upsert", "delete"];

function fakeClient(
  tables: Tables,
  opts: { failing?: Set<string> } = {},
) {
  const failing = opts.failing ?? new Set<string>();
  const reads: string[] = [];
  const rpcs: string[] = [];
  const writes: string[] = [];
  return {
    reads,
    rpcs,
    writes,
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push(fn);
      if (failing.has(`rpc:${fn}`)) {
        return { data: null, error: { code: "PGRST202", message: "missing" } };
      }
      const rows = (tables[`rpc:${fn}`] ?? []).filter((r) =>
        r._job_id === args.p_job_id
      ).map(({ _job_id, ...rest }) => rest);
      return { data: rows, error: null };
    },
    from(table: string) {
      reads.push(table);
      const filters: Array<(r: any) => boolean> = [];
      let order: { col: string; asc: boolean } | null = null;
      let limit: number | null = null;
      let single = false;
      const q: any = {};
      for (const m of WRITE_METHODS) {
        q[m] = () => {
          writes.push(`${m}:${table}`);
          throw new Error(`write attempted: ${m} ${table}`);
        };
      }
      q.select = () => q;
      q.eq = (c: string, v: any) => {
        filters.push((r) => r[c] === v);
        return q;
      };
      q.neq = (c: string, v: any) => {
        filters.push((r) => r[c] !== v);
        return q;
      };
      q.in = (c: string, v: any[]) => {
        filters.push((r) => v.includes(r[c]));
        return q;
      };
      q.gt = (c: string, v: any) => {
        filters.push((r) => r[c] != null && r[c] > v);
        return q;
      };
      q.ilike = (c: string, v: string) => {
        filters.push((r) =>
          String(r[c] ?? "").toLowerCase() === v.toLowerCase()
        );
        return q;
      };
      for (
        const m of ["is", "or", "not", "gte", "lt", "lte", "contains", "range"]
      ) {
        q[m] = () => q;
      }
      q.order = (c: string, o: any) => {
        order = { col: c, asc: o?.ascending !== false };
        return q;
      };
      q.limit = (n: number) => {
        limit = n;
        return q;
      };
      q.maybeSingle = () => {
        single = true;
        return q;
      };
      q.single = q.maybeSingle;
      q.then = (resolve: any, reject: any) => {
        if (failing.has(table)) {
          return Promise.resolve({
            data: null,
            error: { code: "42P01", message: `${table} unavailable` },
          }).then(resolve, reject);
        }
        let rows = (tables[table] ?? []).filter((r) =>
          filters.every((f) => f(r))
        );
        if (order) {
          const { col, asc } = order;
          rows = [...rows].sort((a, b) =>
            (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1)
          );
        }
        if (limit !== null) rows = rows.slice(0, limit);
        return Promise.resolve({
          data: single ? rows[0] ?? null : rows,
          error: null,
        }).then(resolve, reject);
      };
      return q;
    },
  };
}

// ── helpers to shape fixtures ────────────────────────────────────────────────

function doc(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    type: "quote",
    version: 1,
    quote_number: null,
    run_label: null,
    job_contact_id: null,
    sent_at: null,
    viewed_at: null,
    accepted_at: null,
    declined_at: null,
    superseded_at: null,
    quote_revision_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function value(documentId: string, over: Record<string, unknown> = {}) {
  return {
    document_id: documentId,
    job_contact_id: null,
    party_is_owner: null,
    run_label: null,
    value_inc_gst: null,
    value_source: "not recorded on the sent quote",
    whole_quote_total_inc: null,
    whole_quote_source: null,
    ...over,
  };
}

function quotesInput(p: {
  clientEmail?: string | null;
  values: any[];
  documents: any[];
  runAcceptances?: any[];
  revisions?: any[];
  parties?: any[];
  sentEvents?: any[];
}) {
  return {
    job: { client_email: p.clientEmail ?? null },
    values: p.values,
    documents: p.documents,
    runAcceptances: p.runAcceptances ?? [],
    recipients: {
      revisions: p.revisions ?? [],
      parties: p.parties ?? [],
      sentEvents: p.sentEvents ?? [],
    },
  };
}

// ── R3 SWF-261458 ────────────────────────────────────────────────────────────

Deno.test("D1 row 3 SWF-261458: one sealed quote reads sent at $4,776.75 from its revision", () => {
  const q = buildJobQuotes(quotesInput({
    clientEmail: "row3@example.test",
    documents: [doc("r3-q", {
      quote_number: "Q-3001",
      sent_at: "2026-09-18T02:00:00.000Z",
    })],
    values: [value("r3-q", {
      value_inc_gst: 4776.75,
      value_source: "quote_revision",
    })],
    revisions: [{
      id: "r3-rev",
      job_document_id: "r3-q",
      recipient_email: "Row3@Example.test",
      released_via: "send-quote/send",
      version: 1,
      sent_at: "2026-09-18T02:00:00.000Z",
    }],
  }));
  assertEquals(q.status, "sent");
  assertEquals(q.current.length, 1);
  assertEquals(q.current[0].value_inc_gst, 4776.75);
  assertEquals(q.current[0].value_source, "quote_revision");
  assertEquals(q.current[0].recipient_mismatch, false);
  assertEquals(q.current[0].status_line, "sent");
  assertEquals(q.headline?.value_inc_gst, 4776.75);
  assertEquals(q.headline?.basis, "newest_current");
  assertEquals(q.whole_quote_total, null);
});

// ── R6 SWF-26818 (live shape, 23 Sep read) ──────────────────────────────────

function row6Input() {
  return quotesInput({
    clientEmail: "owner6@example.test",
    documents: [
      doc("r6-q0439", {
        quote_number: "Q-0439",
        version: 1,
        sent_at: "2026-06-25T12:15:36.000Z",
        viewed_at: "2026-06-25T13:00:00.000Z",
        superseded_at: "2026-07-05T00:00:00.000Z",
      }),
      doc("r6-q0491", {
        quote_number: "Q-0491",
        version: 2,
        sent_at: "2026-07-05T01:00:00.000Z",
        viewed_at: "2026-07-05T02:00:00.000Z",
      }),
      // live: the REAR run document carries no party and no quote number
      doc("r6-rear", {
        run_label: "REAR",
        sent_at: "2026-07-06T01:00:00.000Z",
        viewed_at: "2026-07-22T01:00:00.000Z",
      }),
    ],
    // Exactly the SQL contract's output for this shape.
    values: [
      value("r6-rear", {
        party_is_owner: true,
        run_label: "REAR",
        value_inc_gst: 4842.45,
        value_source: "run_snapshot_share",
      }),
      value("r6-q0491"),
      value("r6-q0439", {
        value_inc_gst: 5571.5,
        value_source: "quote_revision",
      }),
    ],
    revisions: [{
      id: "r6-rev",
      job_document_id: "r6-q0439",
      recipient_email: "owner6@example.test",
      released_via: "send-quote/send",
      version: 1,
      sent_at: "2026-06-25T12:15:36.000Z",
    }],
    sentEvents: [{
      occurred_at: "2026-06-25T12:15:36.000Z",
      source: "send-quote/send",
      payload: { document_id: "r6-q0439", sent_to: "owner6@example.test" },
    }, {
      // forged row from a public source naming the current document
      occurred_at: "2026-07-06T02:00:00.000Z",
      source: "website_form",
      payload: { document_id: "r6-q0491", sent_to: "attacker@example.test" },
    }],
  });
}

Deno.test("D1 row 6 SWF-26818: current v2 and the client's REAR run share, v1 in history, no invented value", () => {
  const q = buildJobQuotes(row6Input());
  assertEquals(q.current.map((c) => c.document_id), ["r6-rear", "r6-q0491"]);
  const rear = q.current[0];
  assertEquals(rear.value_inc_gst, 4842.45);
  assertEquals(rear.value_source, "run_snapshot_share");
  assertEquals(rear.party_is_owner, true);
  const v2 = q.current[1];
  assertEquals(v2.value_inc_gst, null);
  assertEquals(v2.value_source, "not recorded on the sent quote");
  assertEquals(v2.sent_to, null, "forged row ignored");
  assertEquals(v2.recipient_mismatch, null);
  assertEquals(q.history.map((h) => h.quote_number), ["Q-0439"]);
  assertEquals(q.history[0].value_inc_gst, 5571.5);
  assertEquals(q.history[0].sent_to, "owner6@example.test");
  assertEquals(q.whole_quote_total, null);
  assertEquals(q.status, "viewed");
  assertEquals(q.headline?.document_id, "r6-rear");
});

Deno.test("D1 row 6 SWF-26818: variation $374 pending approval is listed, not agreed", () => {
  const v = variationView({
    variation_number: 1,
    description: "Extra &amp; taller gate&#39;s posts",
    amount: 374,
    status: "pending_approval",
    created_at: "2026-07-05T00:00:00.000Z",
  }, NOW);
  assertEquals(v.agreement, "pending_internal_approval");
  assertEquals(v.agreed, false);
  assertEquals(v.amount, 374);
  assertEquals(v.description, "Extra & taller gate's posts");
});

// ── R7 SWF-261355 ────────────────────────────────────────────────────────────

Deno.test("D1 row 7 SWF-261355: accepted with no sealed value reads accepted, value null with the reason", () => {
  const q = buildJobQuotes(quotesInput({
    clientEmail: "row7@example.test",
    documents: [doc("r7-q", {
      quote_number: "Q-0738",
      sent_at: "2026-08-01T02:00:00.000Z",
      accepted_at: "2026-08-03T02:00:00.000Z",
    })],
    values: [value("r7-q")],
  }));
  assertEquals(q.status, "accepted");
  assertEquals(q.headline?.basis, "accepted");
  assertEquals(q.headline?.value_inc_gst, null);
  assertEquals(q.headline?.value_source, "not recorded on the sent quote");
  assertEquals(q.current[0].status, "accepted");
  assertEquals(q.bound_revision, {
    state: "missing",
    revision_id: null,
    snapshot_version: null,
    snapshot_has_version: false,
  });
});

// ── R8 SWF-26163, R9 SWF-26177 ───────────────────────────────────────────────

Deno.test("D1 row 8 SWF-26163: approved, never sent, never accepted", () => {
  const v = variationView({
    variation_number: 1,
    description: "Extra panels",
    amount: 1312.5,
    status: "approved",
    approved_at: "2026-06-24T02:00:00.000Z",
    sent_at: null,
    accepted_at: null,
    created_at: "2026-06-23T02:00:00.000Z",
  }, NOW);
  assertEquals(v.agreement, "approved_internally_not_accepted");
  assertEquals(v.note, "approved internally, customer acceptance not recorded");
  assertEquals(v.agreed, false);
  assertEquals(v.amount, 1312.5);
});

Deno.test("D1 row 9 SWF-26177: $7,000 pending since 4 Jun is listed with its age, not agreed", () => {
  const v = variationView({
    variation_number: 2,
    description: "Retaining wall",
    amount: 7000,
    status: "pending_approval",
    created_at: "2026-06-04T01:00:00.000Z",
  }, NOW);
  assertEquals(v.agreed, false);
  assertEquals(v.age_days, 111);
  assertEquals(v.agreement, "pending_internal_approval");
});

Deno.test("D1 variations: descriptions are decoded, tag-free and capped at 300 characters", () => {
  assertEquals(
    decodeVariationText("<p>Move&nbsp;gate&#x2F;post</p>"),
    "Move gate/post",
  );
  const long = decodeVariationText("x".repeat(400))!;
  assertEquals(long.length, 300);
  assertEquals(decodeVariationText("   "), null);
});

// ── R10 SWP-261456 ───────────────────────────────────────────────────────────

Deno.test("D1 row 10 SWP-261456: a quote emailed from Outlook reads none_recorded with the honest note", () => {
  const q = buildJobQuotes(quotesInput({
    documents: [doc("r10-draft", { created_at: "2026-09-22T13:40:00.000Z" })],
    values: [],
  }));
  assertEquals(q.status, "none_recorded");
  assert(q.note?.includes("No quote recorded in SecureWorks systems"));
  assert(q.note?.includes("not proof the job was never quoted"));
  assertEquals(q.unsent_documents, 1);
  assertEquals(q.headline, null);

  const scope = summariseScope({
    id: "r10",
    type: "patio",
    scope_json: {
      patios: [{
        config: {
          structure_type: "flyover",
          dimensions: { width: 8.8, depth: 3.6, height: 2.7 },
          roof_sheet_colour: "Surfmist",
        },
      }],
    },
    pricing_json: { totalIncGST: 21309.04, totalExGST: 19371.85 },
    scope_version: 1,
    scope_updated_at: null,
  }, {
    newestQuoteSentAt: null,
    signedOff: {
      at: "2026-09-22T13:44:00.000Z",
      source: "scope.completed:scoping_tool",
    },
  });
  assertEquals(scope.status, "summarised");
  assertEquals(scope.kind, "patio");
  assertEquals(scope.lines[0], "flyover, 8.8 m x 3.6 m, height 2.7 m");
  assertEquals(scope.current_price_inc_gst, 21309.04);
  assertEquals(scope.signed_off_at, "2026-09-22T13:44:00.000Z");
  assertEquals(scope.changed_since_last_quote, null);
  assertEquals(scope.changed_since_last_quote_basis, "no_sent_quote");
});

// ── R12 SWMS-261464 ──────────────────────────────────────────────────────────

Deno.test("D1 row 12 SWMS-261464: no scope reads no_scope, no error", () => {
  const scope = summariseScope({
    id: "r12",
    type: "makesafe",
    scope_json: null,
    pricing_json: null,
  }, { newestQuoteSentAt: null, signedOff: null });
  assertEquals(scope.status, "no_scope");
  assertEquals(scope.lines, []);
  assertEquals(scope.current_price_inc_gst, null);
});

Deno.test("D1 scope: a job type with no adapter says so instead of failing", () => {
  const scope = summariseScope({
    id: "deck",
    type: "decking",
    scope_json: { boards: 30 },
    pricing_json: {},
  }, { newestQuoteSentAt: null, signedOff: null });
  assertEquals(scope.status, "not_summarised:no_adapter");
  assertEquals(scope.kind, "decking");
});

// ── R14 SWF-26904 (live shape) ───────────────────────────────────────────────

Deno.test("D1 row 14 SWF-26904: three parties recorded but one whole quote: its sealed $7,733, no invented shares", () => {
  const q = buildJobQuotes(quotesInput({
    clientEmail: "party-a14@example.test",
    documents: [doc("r14-q0481", {
      quote_number: "Q-0481",
      sent_at: "2026-07-02T14:12:05.000Z",
      viewed_at: "2026-07-02T15:00:00.000Z",
    })],
    values: [value("r14-q0481", {
      value_inc_gst: 7733,
      value_source: "quote_revision",
    })],
    revisions: [{
      id: "r14-rev",
      job_document_id: "r14-q0481",
      recipient_email: "party-a14@example.test",
      released_via: "send-quote/send",
      version: 1,
      sent_at: "2026-07-02T14:12:05.000Z",
    }],
    parties: [
      { id: "r14-a", client_email: "party-a14@example.test" },
      { id: "r14-b", client_email: "party-b14@example.test" },
      { id: "r14-c", client_email: "party-c14@example.test" },
    ],
  }));
  assertEquals(q.current.length, 1);
  assertEquals(q.current[0].value_inc_gst, 7733);
  assertEquals(q.current[0].recipient_mismatch, false);
  assertEquals(q.whole_quote_total, null);
  assertEquals(q.run_acceptances, []);
  // live: the job is invoiced but the quote document itself records no acceptance
  assertEquals(q.status, "viewed");
});

// ── send-runs shape (synthetic: no named row has live run parties) ──────────

const R14 = { owner: "r14-owner", a: "r14-nb-a", b: "r14-nb-b" };
function row14Input(bStatus: "accepted" | "pending") {
  const docs = [
    doc("r14-owner-rear", {
      quote_number: "Q-1401",
      run_label: "REAR",
      job_contact_id: R14.owner,
      sent_at: "2026-08-01T02:00:00.000Z",
      accepted_at: "2026-08-02T00:00:00.000Z",
    }),
    doc("r14-a-rear", {
      quote_number: "Q-1402",
      run_label: "REAR",
      job_contact_id: R14.a,
      sent_at: "2026-08-01T02:00:00.000Z",
      accepted_at: "2026-08-03T00:00:00.000Z",
    }),
    doc("r14-b-lhs", {
      quote_number: "Q-1403",
      run_label: "LHS",
      job_contact_id: R14.b,
      sent_at: "2026-08-01T02:00:00.000Z",
      accepted_at: bStatus === "accepted" ? "2026-08-04T00:00:00.000Z" : null,
    }),
    doc("r14-owner-lhs", {
      quote_number: "Q-1406",
      run_label: "LHS",
      job_contact_id: R14.owner,
      sent_at: "2026-08-01T02:00:00.000Z",
      accepted_at: "2026-08-02T00:00:00.000Z",
    }),
  ];
  const whole = {
    whole_quote_total_inc: 12195,
    whole_quote_source: "quote_revision",
  };
  return quotesInput({
    clientEmail: "owner14@example.test",
    documents: docs,
    values: [
      value("r14-owner-rear", {
        job_contact_id: R14.owner,
        party_is_owner: true,
        run_label: "REAR",
        value_inc_gst: 4023,
        value_source: "run_snapshot_share",
        ...whole,
      }),
      value("r14-a-rear", {
        job_contact_id: R14.a,
        party_is_owner: false,
        run_label: "REAR",
        value_inc_gst: 3710,
        value_source: "run_snapshot_share",
        ...whole,
      }),
      value("r14-b-lhs", {
        job_contact_id: R14.b,
        party_is_owner: false,
        run_label: "LHS",
        value_inc_gst: 1731,
        value_source: "run_snapshot_share",
        ...whole,
      }),
      value("r14-owner-lhs", {
        job_contact_id: R14.owner,
        party_is_owner: true,
        run_label: "LHS",
        value_inc_gst: 1731,
        value_source: "run_snapshot_share",
        ...whole,
      }),
    ],
    runAcceptances: [
      {
        job_contact_id: R14.owner,
        job_document_id: "r14-owner-rear",
        run_label: "REAR",
        status: "accepted",
        accepted_at: "2026-08-02T00:00:00.000Z",
        declined_at: null,
      },
      {
        job_contact_id: R14.a,
        job_document_id: "r14-a-rear",
        run_label: "REAR",
        status: "accepted",
        accepted_at: "2026-08-03T00:00:00.000Z",
        declined_at: null,
      },
      {
        job_contact_id: R14.b,
        job_document_id: "r14-b-lhs",
        run_label: "LHS",
        status: bStatus,
        accepted_at: bStatus === "accepted" ? "2026-08-04T00:00:00.000Z" : null,
        declined_at: null,
      },
      {
        job_contact_id: R14.owner,
        job_document_id: "r14-owner-lhs",
        run_label: "LHS",
        status: "accepted",
        accepted_at: "2026-08-02T00:00:00.000Z",
        declined_at: null,
      },
    ],
    parties: [
      { id: R14.owner, client_email: "owner14@example.test" },
      { id: R14.a, client_email: "neighbour14a@example.test" },
      { id: R14.b, client_email: "neighbour14b@example.test" },
    ],
  });
}

Deno.test("D1 send-runs shape: each party's run document shows its own share; accepted only when every party on every run accepted", () => {
  const all = buildJobQuotes(row14Input("accepted"));
  assertEquals(all.status, "accepted");
  const byDoc = Object.fromEntries(all.current.map((c) => [c.quote_number, c]));
  assertEquals(byDoc["Q-1401"].value_inc_gst, 4023);
  assertEquals(byDoc["Q-1402"].value_inc_gst, 3710);
  assertEquals(byDoc["Q-1403"].value_inc_gst, 1731);
  assert(all.current.every((c) => c.value_source === "run_snapshot_share"));
  assert(
    all.current.every((c) => c.value_inc_gst !== 12195),
    "no document shows the whole-job total",
  );
  assertEquals(all.whole_quote_total?.value_inc_gst, 12195);
  assertEquals(all.run_acceptances.length, 4);

  const partial = buildJobQuotes(row14Input("pending"));
  assertEquals(partial.status, "partially_accepted");
  assertEquals(partial.outstanding, [{
    job_contact_id: R14.b,
    run_label: "LHS",
    status: "pending",
  }]);
});

// ── R15 SWF-26395 (live shape) ──────────────────────────────────────────────

Deno.test("D1 row 15 SWF-26395: party C never accepted her per-party quote: partially_accepted naming her, and no party shows the whole job's $5,104", () => {
  const owner = "r15-a", b = "r15-b", c = "r15-c";
  const perParty = {
    value_inc_gst: null,
    value_source: "party share not recorded on this per-party quote",
    whole_quote_total_inc: 5104,
    whole_quote_source: "quote_revision",
  };
  const q = buildJobQuotes(quotesInput({
    clientEmail: "party-a15@example.test",
    documents: [
      doc("r15-q0206", {
        quote_number: "Q-0206",
        version: 1,
        job_contact_id: owner,
        sent_at: "2026-06-02T23:59:01.000Z",
        viewed_at: "2026-06-03T01:00:00.000Z",
        accepted_at: "2026-07-02T01:00:00.000Z",
      }),
      doc("r15-q0207", {
        quote_number: "Q-0207",
        version: 2,
        job_contact_id: b,
        sent_at: "2026-06-02T23:59:02.000Z",
        viewed_at: "2026-06-03T01:00:00.000Z",
        accepted_at: "2026-08-19T01:00:00.000Z",
      }),
      doc("r15-q0208", {
        quote_number: "Q-0208",
        version: 3,
        job_contact_id: c,
        sent_at: "2026-06-02T23:59:03.000Z",
        viewed_at: "2026-06-03T01:00:00.000Z",
      }),
    ],
    // Exactly the SQL contract's output for this shape.
    values: [
      value("r15-q0208", {
        job_contact_id: c,
        party_is_owner: false,
        ...perParty,
      }),
      value("r15-q0207", {
        job_contact_id: b,
        party_is_owner: false,
        ...perParty,
      }),
      value("r15-q0206", {
        job_contact_id: owner,
        party_is_owner: true,
        ...perParty,
      }),
    ],
    parties: [
      { id: owner, client_email: "party-a15@example.test" },
      { id: b, client_email: "party-b15@example.test" },
      { id: c, client_email: "party-c15@example.test" },
    ],
  }));
  assertEquals(q.status, "partially_accepted");
  assertEquals(q.outstanding, [{
    job_contact_id: c,
    run_label: null,
    status: "viewed",
  }]);
  assert(q.current.every((d) => d.value_inc_gst === null));
  assert(
    q.current.every((d) =>
      d.value_source === "party share not recorded on this per-party quote"
    ),
  );
  assertEquals(q.whole_quote_total, {
    value_inc_gst: 5104,
    source: "quote_revision",
  });
  assertEquals(q.run_acceptances, []);
});

Deno.test("D1 roll-up: a per-party whole-quote job with one party outstanding is never read as accepted", () => {
  // Pre-run neighbour quotes: one whole-quote document per party.
  const q = buildJobQuotes(quotesInput({
    documents: [
      doc("o", {
        job_contact_id: "p-owner",
        sent_at: "2026-05-01T00:00:00.000Z",
        accepted_at: "2026-05-02T00:00:00.000Z",
      }),
      doc("n", { job_contact_id: "p-nb", sent_at: "2026-05-01T00:00:00.000Z" }),
    ],
    values: [
      value("o", {
        job_contact_id: "p-owner",
        party_is_owner: true,
        value_inc_gst: 3000,
        value_source: "quote_revision",
      }),
      value("n", {
        job_contact_id: "p-nb",
        party_is_owner: false,
        value_inc_gst: 1500,
        value_source: "quote_sent_log_unverified",
      }),
    ],
  }));
  assertEquals(q.status, "partially_accepted");
  assertEquals(q.outstanding, [{
    job_contact_id: "p-nb",
    run_label: null,
    status: "pending",
  }]);
});

Deno.test("D1 roll-up: options for one recipient accept as one; a declined-only job reads declined; an unsent run ask does not count", () => {
  const options = buildJobQuotes(quotesInput({
    documents: [
      doc("opt-a", {
        sent_at: "2026-05-01T00:00:00.000Z",
        accepted_at: "2026-05-03T00:00:00.000Z",
      }),
      doc("opt-b", {
        sent_at: "2026-05-01T00:00:00.000Z",
        superseded_at: "2026-05-03T00:00:00.000Z",
      }),
    ],
    values: [
      value("opt-a", { value_inc_gst: 9000, value_source: "quote_revision" }),
      value("opt-b", { value_inc_gst: 12000, value_source: "quote_revision" }),
    ],
  }));
  assertEquals(options.status, "accepted");
  assertEquals(options.headline?.value_inc_gst, 9000);

  const declined = buildJobQuotes(quotesInput({
    documents: [
      doc("d1", {
        sent_at: "2026-05-01T00:00:00.000Z",
        declined_at: "2026-05-02T00:00:00.000Z",
      }),
    ],
    values: [
      value("d1", { value_inc_gst: 800, value_source: "quote_revision" }),
    ],
  }));
  assertEquals(declined.status, "declined");
  assertEquals(declined.current, []);
  assertEquals(declined.history.length, 1);

  const unsentAsk = buildJobQuotes(quotesInput({
    documents: [
      doc("run-sent", {
        run_label: "REAR",
        job_contact_id: "p1",
        sent_at: "2026-05-01T00:00:00.000Z",
        accepted_at: "2026-05-02T00:00:00.000Z",
      }),
      doc("run-unsent", { run_label: "REAR", job_contact_id: "p2" }),
    ],
    values: [
      value("run-sent", {
        job_contact_id: "p1",
        party_is_owner: true,
        run_label: "REAR",
        value_inc_gst: 100,
        value_source: "run_snapshot_share",
      }),
    ],
    runAcceptances: [
      {
        job_contact_id: "p1",
        job_document_id: "run-sent",
        run_label: "REAR",
        status: "accepted",
        accepted_at: "2026-05-02T00:00:00.000Z",
        declined_at: null,
      },
      {
        job_contact_id: "p2",
        job_document_id: "run-unsent",
        run_label: "REAR",
        status: "pending",
        accepted_at: null,
        declined_at: null,
      },
    ],
  }));
  assertEquals(unsentAsk.status, "accepted");
});

// ── R23: wrong recipients ────────────────────────────────────────────────────

Deno.test("D1 row 23 SWF-26167 / SWF-261111 / SWF-26997 / SWP-26634: a quote sent elsewhere says so", () => {
  const cases: Array<[string, string, boolean]> = [
    // live 23 Sep: recipient on neither the job nor a party
    ["SWF-26167 another client's address", "other.client@example.test", true],
    ["SWF-261111 a wrong address", "typo@exmaple.test", true],
    // live 23 Sep: recipient on our own domain
    ["SWF-26997 our own address", "quotes@secureworksgroup.app", true],
    ["control: the job's own client", "Client@Example.test", false],
  ];
  for (const [label, to, mismatch] of cases) {
    const q = buildJobQuotes(quotesInput({
      clientEmail: "client@example.test",
      documents: [doc("q", { sent_at: "2026-07-01T00:00:00.000Z" })],
      values: [
        value("q", { value_inc_gst: 1000, value_source: "quote_revision" }),
      ],
      revisions: [{
        id: "rev",
        job_document_id: "q",
        recipient_email: to,
        released_via: "send-quote/send",
        version: 1,
        sent_at: "2026-07-01T00:00:00.000Z",
      }],
    }));
    assertEquals(q.current[0].recipient_mismatch, mismatch, label);
    assertEquals(
      q.current[0].status_line,
      mismatch ? `sent, but to ${to}` : "sent",
      label,
    );
  }
  // SWP-26634 (live 23 Sep): the recipient equals the job's recorded client
  // email. When that recorded email is a staff address it is still our
  // address and the customer never received it; when it is the customer's
  // it matches (the control above).
  const staffAsClient = buildJobQuotes(quotesInput({
    clientEmail: "sales@secureworkswa.com.au",
    documents: [doc("q", { sent_at: "2026-07-01T00:00:00.000Z" })],
    values: [
      value("q", { value_inc_gst: 1000, value_source: "quote_revision" }),
    ],
    revisions: [{
      id: "rev",
      job_document_id: "q",
      recipient_email: "sales@secureworkswa.com.au",
      released_via: "send-quote/send",
      version: 1,
      sent_at: "2026-07-01T00:00:00.000Z",
    }],
  }));
  assertEquals(staffAsClient.current[0].recipient_mismatch, true);
  // A neighbour's own address on the job is not a mismatch.
  const nb = buildJobQuotes(quotesInput({
    clientEmail: "client@example.test",
    documents: [doc("q", { sent_at: "2026-07-01T00:00:00.000Z" })],
    values: [
      value("q", { value_inc_gst: 1000, value_source: "quote_revision" }),
    ],
    parties: [{ id: "p", client_email: "neighbour@example.test" }],
    sentEvents: [{
      occurred_at: "2026-07-01T00:00:01.000Z",
      source: "send-quote/send",
      payload: { document_id: "q", sent_to: "neighbour@example.test" },
    }],
  }));
  assertEquals(nb.current[0].sent_to, "neighbour@example.test");
  assertEquals(nb.current[0].recipient_mismatch, false);
});

// ── R24 SWP-261203 ───────────────────────────────────────────────────────────

Deno.test("D1 row 24 SWP-261203: scope edited after the newest current quote reads changed_since_last_quote", () => {
  const job = {
    id: "r24",
    type: "patio",
    scope_json: {
      patios: [{ config: { dimensions: { width: 6, depth: 3 } } }],
    },
    pricing_json: { totalIncGST: 9000 },
    scope_version: 2,
    scope_updated_at: "2026-09-12T00:00:00.000Z",
  };
  const after = summariseScope(job, {
    newestQuoteSentAt: "2026-09-10T00:00:00.000Z",
    signedOff: null,
  });
  assertEquals(after.changed_since_last_quote, true);
  assertEquals(after.scope_version, 2);
  const before = summariseScope(job, {
    newestQuoteSentAt: "2026-09-13T00:00:00.000Z",
    signedOff: null,
  });
  assertEquals(before.changed_since_last_quote, false);
  const unknown = summariseScope({ ...job, scope_updated_at: null }, {
    newestQuoteSentAt: "2026-09-13T00:00:00.000Z",
    signedOff: null,
  });
  assertEquals(unknown.changed_since_last_quote, null);
  assertEquals(
    unknown.changed_since_last_quote_basis,
    "scope_update_time_not_recorded",
  );
});

Deno.test("D1 row 24 SWP-261203: patio correction class — scope_version differs from the bound revision snapshot", async () => {
  const client = fakeClient({
    job_documents: [{
      ...doc("r24-q", {
        quote_number: "Q-1203",
        sent_at: "2026-09-10T00:00:00.000Z",
        quote_revision_id: "r24-rev",
      }),
      job_id: "job-r24",
    }],
    run_acceptances: [],
    quote_revisions: [{
      id: "r24-rev",
      job_id: "job-r24",
      job_document_id: "r24-q",
      recipient_email: "row24@example.test",
      released_via: "send-quote/send",
      version: 1,
      sent_at: "2026-09-10T00:00:00.000Z",
      scope_snapshot_json: {
        version: 1,
        job_type: "patio",
        job_number: "SWP-261203",
      },
    }],
    job_contacts: [],
    business_events: [],
    "rpc:job_quote_values": [{
      _job_id: "job-r24",
      ...value("r24-q", {
        value_inc_gst: 9000,
        value_source: "quote_revision",
      }),
    }],
  });
  const out = await readJobQuotes(client, {
    id: "job-r24",
    client_email: "row24@example.test",
  });
  assertEquals(out.status.ok, true);
  assertEquals(out.quotes?.bound_revision, {
    state: "present",
    revision_id: "r24-rev",
    snapshot_version: 1,
    snapshot_has_version: true,
  });
  const patio = summariseScope({
    id: "job-r24",
    type: "patio",
    scope_json: {
      patios: [{ config: { dimensions: { width: 6, depth: 3 } } }],
    },
    pricing_json: { totalIncGST: 9000 },
    scope_version: 2,
    scope_updated_at: null,
  }, {
    newestQuoteSentAt: out.quotes!.current[0].sent_at,
    boundRevision: out.quotes!.bound_revision,
    signedOff: null,
  });
  assertEquals(patio.changed_since_last_quote, true);
  assertEquals(
    patio.changed_since_last_quote_basis,
    "scope_version_vs_revision_snapshot",
  );
  assertEquals(client.writes, []);
});

Deno.test("D1 scope: a send-quote snapshot with no version key keeps the timestamp half", () => {
  const job = {
    id: "r24-manifest",
    type: "patio",
    scope_json: {
      patios: [{ config: { dimensions: { width: 6, depth: 3 } } }],
    },
    pricing_json: { totalIncGST: 9000 },
    scope_version: 2,
    scope_updated_at: null,
  };
  const noVersion = {
    state: "present" as const,
    revision_id: "rev",
    snapshot_version: null,
    snapshot_has_version: false,
  };
  const unknown = summariseScope(job, {
    newestQuoteSentAt: "2026-09-10T00:00:00.000Z",
    boundRevision: noVersion,
    signedOff: null,
  });
  assertEquals(unknown.changed_since_last_quote, null);
  assertEquals(
    unknown.changed_since_last_quote_basis,
    "revision_snapshot_has_no_version",
  );
  const later = summariseScope({
    ...job,
    scope_updated_at: "2026-09-12T00:00:00.000Z",
  }, {
    newestQuoteSentAt: "2026-09-10T00:00:00.000Z",
    boundRevision: noVersion,
    signedOff: null,
  });
  assertEquals(later.changed_since_last_quote, true);
  assertEquals(
    later.changed_since_last_quote_basis,
    "scope_updated_at_vs_newest_current_quote",
  );
});

Deno.test("D1 current_price_inc_gst: only totalIncGST; a total-only blob is unknown", () => {
  assertEquals(
    currentPriceIncGst({ totalIncGST: 21309.04, total: 19371.85 }),
    21309.04,
  );
  assertEquals(currentPriceIncGst({ total: 7227.56 }), null);
  assertEquals(currentPriceIncGst({ grandTotal: 100, amount: 90 }), null);
  assertEquals(currentPriceIncGst(null), null);
});

Deno.test("D1 scope: a failed quote read leaves changed_since_last_quote unknown", () => {
  const scope = summariseScope({
    id: "r6",
    type: "fencing",
    scope_json: {
      runs: [{
        run_label: "REAR",
        type: "Colorbond",
        length_m: 18,
        height_mm: 1800,
      }],
    },
    pricing_json: { totalIncGST: 5571.5 },
    scope_version: 1,
    scope_updated_at: "2026-09-12T00:00:00.000Z",
  }, {
    newestQuoteSentAt: null,
    quoteReadFailed: true,
    signedOff: null,
  });
  assertEquals(scope.changed_since_last_quote, null);
  assertEquals(scope.changed_since_last_quote_basis, "quote_read_failed");
  assertEquals(scope.changed_since_last_quote_basis !== "no_sent_quote", true);
});

Deno.test("D1 row 7 SWF-261355: a later scope_updated_at is changed even with no sent revision", () => {
  const q = buildJobQuotes(quotesInput({
    clientEmail: "row7@example.test",
    documents: [doc("r7-q", {
      quote_number: "Q-0738",
      sent_at: "2026-08-01T02:00:00.000Z",
      accepted_at: "2026-08-03T02:00:00.000Z",
    })],
    values: [value("r7-q")],
  }));
  assertEquals(q.bound_revision?.state, "missing");
  const job = {
    id: "r7",
    type: "fencing",
    scope_json: {
      runs: [{
        run_label: "SIDE",
        type: "Colorbond",
        length_m: 12,
        height_mm: 1800,
      }],
    },
    pricing_json: { totalIncGST: 4100 },
    scope_version: 1,
    scope_updated_at: "2026-08-10T00:00:00.000Z",
  };
  const later = summariseScope(job, {
    newestQuoteSentAt: q.current[0].sent_at,
    boundRevision: q.bound_revision,
    signedOff: null,
  });
  assertEquals(later.changed_since_last_quote, true);
  assertEquals(
    later.changed_since_last_quote_basis,
    "scope_updated_at_vs_newest_current_quote",
  );
  const notLater = summariseScope({
    ...job,
    scope_updated_at: "2026-07-20T00:00:00.000Z",
  }, {
    newestQuoteSentAt: q.current[0].sent_at,
    boundRevision: q.bound_revision,
    signedOff: null,
  });
  assertEquals(notLater.changed_since_last_quote, null);
  assertEquals(notLater.changed_since_last_quote_basis, "no_revision");
});

Deno.test("D1 scope: an unreadable revision stays unknown unless the timestamp already proved changed", async () => {
  const client = fakeClient(row3Tables(), {
    failing: new Set(["quote_revisions"]),
  });
  const out = await readJobQuotes(client, {
    id: "job-r3",
    client_email: "row3@example.test",
  });
  assertEquals(out.status.ok, true);
  assertEquals(out.quotes?.bound_revision?.state, "unavailable");
  const job = {
    id: "job-r3",
    type: "patio",
    scope_json: {
      patios: [{ config: { dimensions: { width: 6, depth: 3 } } }],
    },
    pricing_json: { totalIncGST: 9000 },
    scope_version: 2,
    scope_updated_at: "2026-09-17T00:00:00.000Z",
  };
  const notLater = summariseScope(job, {
    newestQuoteSentAt: out.quotes!.current[0].sent_at,
    boundRevision: out.quotes!.bound_revision,
    signedOff: null,
  });
  assertEquals(notLater.changed_since_last_quote, null);
  assertEquals(notLater.changed_since_last_quote_basis, "revision_read_failed");
  const later = summariseScope({
    ...job,
    scope_updated_at: "2026-09-20T00:00:00.000Z",
  }, {
    newestQuoteSentAt: out.quotes!.current[0].sent_at,
    boundRevision: out.quotes!.bound_revision,
    signedOff: null,
  });
  assertEquals(later.changed_since_last_quote, true);
  assertEquals(
    later.changed_since_last_quote_basis,
    "scope_updated_at_vs_newest_current_quote",
  );
});

// ── reader failure modes ─────────────────────────────────────────────────────

function row3Tables(): Tables {
  return {
    job_documents: [{
      ...doc("r3-q", {
        quote_number: "Q-3001",
        sent_at: "2026-09-18T02:00:00.000Z",
      }),
      job_id: "job-r3",
    }],
    run_acceptances: [],
    quote_revisions: [{
      id: "r3-rev",
      job_id: "job-r3",
      job_document_id: "r3-q",
      recipient_email: "row3@example.test",
      released_via: "send-quote/send",
      version: 1,
      sent_at: "2026-09-18T02:00:00.000Z",
    }],
    job_contacts: [],
    business_events: [],
    "rpc:job_quote_values": [{
      _job_id: "job-r3",
      ...value("r3-q", {
        value_inc_gst: 4776.75,
        value_source: "quote_revision",
      }),
    }],
  };
}

Deno.test("D1 reader: a failed value read is a null section with a code, never an empty list", async () => {
  const client = fakeClient(row3Tables(), {
    failing: new Set(["rpc:job_quote_values"]),
  });
  const out = await readJobQuotes(client, { id: "job-r3", client_email: null });
  assertEquals(out.quotes, null);
  assertEquals(out.status, {
    ok: false,
    state: "failed",
    count: 0,
    code: "PGRST202",
  });
});

Deno.test("D1 reader: a failed recipient read keeps the values and marks sent_to unknown", async () => {
  const client = fakeClient(row3Tables(), {
    failing: new Set(["quote_revisions"]),
  });
  const out = await readJobQuotes(client, {
    id: "job-r3",
    client_email: "row3@example.test",
  });
  assertEquals(out.status.ok, true);
  assertEquals(out.quotes?.current[0].value_inc_gst, 4776.75);
  assertEquals(out.quotes?.current[0].sent_to, null);
  assertEquals(out.quotes?.current[0].recipient_mismatch, null);
  assertEquals(out.quotes?.read.recipients, "failed:42P01");
});

Deno.test("D1 reader: variation read failure is null with a code", async () => {
  const client = fakeClient({}, { failing: new Set(["job_variations"]) });
  const out = await readJobVariations(client, "job-x", NOW);
  assertEquals(out.variations, null);
  assertEquals(out.status.code, "42P01");
});

// ── dossier: sections, read-only contract, and agreement with the invoice read ──

const DOSSIER_JOB = "d1000000-0000-4000-8000-000000026818";
function dossierTables(): Tables {
  return {
    jobs: [{
      id: DOSSIER_JOB,
      job_number: "SWF-26818",
      type: "fencing",
      status: "archived",
      client_name: "Row Six",
      client_email: "owner6@example.test",
      ghl_contact_id: null,
      org_id: ORG,
      scope_json: {
        runs: [{
          run_label: "REAR",
          type: "Colorbond",
          length_m: 18,
          height_mm: 1800,
        }],
      },
      pricing_json: { totalIncGST: 5571.5 },
      scope_version: 1,
      scope_updated_at: null,
    }],
    job_documents: row6Input().documents.map((d) => ({
      ...d,
      job_id: DOSSIER_JOB,
    })),
    run_acceptances: row6Input().runAcceptances.map((r) => ({
      ...r,
      job_id: DOSSIER_JOB,
    })),
    quote_revisions: [],
    job_contacts: [],
    job_variations: [{
      job_id: DOSSIER_JOB,
      variation_number: 1,
      description: "Extra post",
      amount: 374,
      status: "pending_approval",
      created_at: "2026-07-05T00:00:00.000Z",
    }],
    business_events: [
      {
        id: "qs-1",
        job_id: null, // cleared by the attribution ladder
        entity_type: "job",
        entity_id: DOSSIER_JOB,
        event_type: "quote.sent",
        source: "send-quote/send",
        occurred_at: "2026-06-25T12:15:36.000Z",
        payload: { document_id: "r6-q0439", sent_to: "owner6@example.test" },
      },
      {
        id: "sc-1",
        job_id: null,
        entity_type: "job",
        entity_id: DOSSIER_JOB,
        event_type: "scope.completed",
        source: "scoping_tool",
        occurred_at: "2026-05-20T02:00:00.000Z",
        payload: {},
      },
    ],
    "rpc:job_quote_values": row6Input().values.map((v) => ({
      _job_id: DOSSIER_JOB,
      ...v,
    })),
  };
}

Deno.test("D1 dossier: quotes, variations and scope sections on SWF-26818, read only, no network", async () => {
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (() => {
    fetches++;
    throw new Error("the dossier must not call the network");
  }) as typeof fetch;
  try {
    const client = fakeClient(dossierTables());
    const d: any = await _assembleJobDossierForTest(client, {
      job_id: DOSSIER_JOB,
    });

    // read-only contract
    assertEquals(client.writes, []);
    assertEquals([...new Set(client.rpcs)], ["job_quote_values"]);
    assertEquals(fetches, 0);

    assertEquals(d.sections_version, 2);
    assertEquals(d._kind, "job_dossier_v1");
    const q = d.operationalTruth.quotes;
    assertEquals(q.status, "viewed");
    assertEquals(q.current.map((c: any) => c.document_id), [
      "r6-rear",
      "r6-q0491",
    ]);
    assertEquals(q.current[0].value_inc_gst, 4842.45);
    // found by the job it names although the ladder cleared job_id
    assertEquals(q.history[0].sent_to, "owner6@example.test");
    assertEquals(q.whole_quote_total, null);
    assertEquals(d.operationalTruth.variations[0].amount, 374);
    assertEquals(d.operationalTruth.variations[0].agreed, false);
    assertEquals(d.scope.kind, "fence");
    assertEquals(d.scope.current_price_inc_gst, 5571.5);
    assertEquals(d.scope.signed_off_at, "2026-05-20T02:00:00.000Z");
    assertEquals(d.diagnostics.sourceStatus.quotes, {
      ok: true,
      state: "ok",
      count: 3,
    });
    assertEquals(d.diagnostics.sourceStatus.variations, {
      ok: true,
      state: "ok",
      count: 1,
    });
    assertEquals(d.diagnostics.sourceStatus.scope.ok, true);
    // the raw blobs are read, never returned
    assertEquals(d.job.scope_json, undefined);
    assertEquals(d.job.pricing_json, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("D1 dossier: a failed value read leaves quotes null and diagnostics not ok", async () => {
  const client = fakeClient(dossierTables(), {
    failing: new Set(["rpc:job_quote_values"]),
  });
  const d: any = await _assembleJobDossierForTest(client, {
    job_id: DOSSIER_JOB,
  });
  assertEquals(d.operationalTruth.quotes, null);
  assertEquals(d.diagnostics.sourceStatus.quotes.state, "failed");
  assertEquals(d.diagnostics.ok, false);
  assertEquals(d.scope.changed_since_last_quote, null);
  assertEquals(d.scope.changed_since_last_quote_basis, "quote_read_failed");
  assertEquals(client.writes, []);
});

Deno.test("D1 invoice read agrees with the job read on the quote total and variations", async () => {
  const t = dossierTables();
  t.xero_invoices = [{
    org_id: ORG,
    invoice_type: "ACCREC",
    xero_invoice_id: "b0000000-0000-4000-8000-000000026818",
    xero_contact_id: "xc-6",
    contact_name: "Row Six",
    invoice_number: "INV-2681",
    reference: "SWF-26818 DEP",
    status: "AUTHORISED",
    total: 2421.23,
    amount_due: 2421.23,
    amount_paid: 0,
    invoice_date: "2026-07-02",
    due_date: "2026-07-16",
    job_id: DOSSIER_JOB,
    synced_at: "2026-09-23T05:00:00.000Z",
    line_items: [],
    raw_json: {},
  }];
  const client = fakeClient(t);
  const inv: any = await invoiceContext(
    new URLSearchParams({ invoice: "INV-2681" }),
    {
      client,
      orgId: ORG,
      getJobConversation: async () => ({ messages: [] }),
      isCurrentContextFact,
      now: () => NOW,
    },
  );
  const d: any = await _assembleJobDossierForTest(fakeClient(dossierTables()), {
    job_id: DOSSIER_JOB,
  });
  const headline = d.operationalTruth.quotes.headline;
  assertEquals(inv.job.promised.quote_total, headline.value_inc_gst);
  assertEquals(inv.job.promised.quote_total_source, headline.value_source);
  assertEquals(
    inv.job.promised.quote_document.document_id,
    headline.document_id,
  );
  // the live price is reported separately and never as the quote total
  assertEquals(inv.job.promised.current_price_inc_gst, 5571.5);
  assert(inv.job.promised.quote_total !== 5571.5);
  assertEquals(
    inv.job.promised.variations.map((v: any) => [v.number, v.amount, v.agreed]),
    d.operationalTruth.variations.map((
      v: any,
    ) => [`VAR${v.variation_number}`, v.amount, v.agreed]),
  );
  assertEquals(inv.job.promised.variations_code, null);
  assertEquals(client.writes, []);
});

Deno.test("D1 invoice read: a failed variation read leaves promised.variations null with the reason", async () => {
  const t = dossierTables();
  t.xero_invoices = [{
    org_id: ORG,
    invoice_type: "ACCREC",
    xero_invoice_id: "b0000000-0000-4000-8000-000000026818",
    xero_contact_id: "xc-6",
    contact_name: "Row Six",
    invoice_number: "INV-2681",
    reference: "SWF-26818 DEP",
    status: "AUTHORISED",
    total: 2421.23,
    amount_due: 2421.23,
    amount_paid: 0,
    invoice_date: "2026-07-02",
    due_date: "2026-07-16",
    job_id: DOSSIER_JOB,
    synced_at: "2026-09-23T05:00:00.000Z",
    line_items: [],
    raw_json: {},
  }];
  const client = fakeClient(t, { failing: new Set(["job_variations"]) });
  const inv: any = await invoiceContext(
    new URLSearchParams({ invoice: "INV-2681" }),
    {
      client,
      orgId: ORG,
      getJobConversation: async () => ({ messages: [] }),
      isCurrentContextFact,
      now: () => NOW,
    },
  );
  assertEquals(inv.job.promised.variations, null);
  assertEquals(inv.job.promised.variations_code, "42P01");
  assertEquals(inv.sources.promised.ok, false);
  assert(String(inv.sources.promised.error).includes("job_variations"));
  assertEquals(client.writes, []);
});
