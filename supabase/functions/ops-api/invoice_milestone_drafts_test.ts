// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  acceptedBillingMilestones,
  acceptedInstallMilestone,
  billingTerms,
  councilBillingTerms,
  matchesDraft,
  processInstallDrafts,
  reconcileMilestoneDraft,
} from "./invoice_milestone_drafts.ts";
const ORG = "00000000-0000-0000-0000-000000000001";
const id = (n: number) =>
  `11000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const JOB = id(1),
  DOC = id(2),
  REV = id(3),
  CONTACT = id(4),
  REVIEW = id(5),
  INVOICE = id(6);
const amount = Math.round(Math.PI * 100) / 100; // Algorithmic fixture only, never a catalogue or job price.
function pricing() {
  const terms = billingTerms(2);
  return {
    pricing_complete: true,
    totalIncGST: amount * 2,
    payment_schedule: {
      version: 1,
      payments: [{
        id: "deposit",
        label: "Deposit",
        printed_terms: "On acceptance",
        amount_inc_gst: amount,
      }, {
        id: "install",
        label: "Installation payment",
        printed_terms: terms,
        amount_inc_gst: amount,
      }],
    },
    billing_milestones: {
      version: 1,
      currency: "AUD",
      milestones: [{
        id: "install",
        trigger: { kind: "install_scheduled" },
        due_rule: { kind: "days_after_trigger", days: 2 },
        label: "Installation payment",
        amount_inc_gst: amount,
        printed_terms: terms,
      }],
    },
  };
}
export function fixture(options: any = {}) {
  const tables: Record<string, any[]> = {
    jobs: [{
      id: JOB,
      org_id: ORG,
      type: "fencing",
      status: "processing",
      job_number: "SWF-FIXTURE",
      client_name: "Fixture",
      site_address: "Fixture",
      site_suburb: "Fixture",
      pricing_json: { billing_contact: { name: "Mutable unrelated payer" } },
      metadata: {},
      xero_contact_id: CONTACT,
    }],
    job_documents: [{
      id: DOC,
      job_id: JOB,
      type: "quote",
      quote_revision_id: REV,
      accepted_at: "2026-11-03T00:00:00Z",
      sent_at: "2026-11-02T00:00:00Z",
      job_contact_id: null,
      superseded_at: null,
    }],
    quote_revisions: [{
      id: REV,
      job_id: JOB,
      job_document_id: DOC,
      sent_at: "2026-11-02T00:00:00Z",
      pricing_snapshot_json: { raw: options.rawPricing || pricing() },
    }],
    quote_invoice_billing_bindings: [{
      quote_revision_id: REV,
      org_id: ORG,
      job_id: JOB,
      xero_contact_id: CONTACT,
      state: "eligible",
    }],
    invoice_milestone_reviews: [{
      id: REVIEW,
      org_id: ORG,
      job_id: JOB,
      accepted_document_id: DOC,
      accepted_quote_revision_id: REV,
      job_contact_id: null,
      trigger_kind: "scheduled",
      created_at: "2026-11-04T09:00:00Z",
    }],
    invoice_milestone_draft_claims: [],
    xero_invoices: [],
    xero_tokens: [{
      org_id: ORG,
      access_token: "fixture-token",
      tenant_id: "fixture-tenant",
      expires_at: "2099-01-01T00:00:00Z",
    }],
  };
  const writes: any[] = [];
  let serial = 20;
  const client = {
    from(table: string) {
      let mode = "read",
        payload: any = null,
        upsertOptions: any = {},
        done = false,
        result: any;
      const predicates: Array<(r: any) => boolean> = [];
      const run = () => {
        if (done) return result;
        done = true;
        const data = tables[table] ||= [];
        let found = data.filter((r) => predicates.every((p) => p(r)));
        if (options.failTable === table && mode !== "read") {
          return result = {
            data: null,
            error: { message: "fixture persistence failure" },
          };
        }
        if (mode === "update") {
          for (const row of found) Object.assign(row, structuredClone(payload));
          writes.push({ table, mode, payload });
        }
        if (mode === "insert" || mode === "upsert") {
          const incoming = Array.isArray(payload) ? payload : [payload];
          found = [];
          for (const value of incoming) {
            let old = mode === "upsert"
              ? data.find((r) =>
                (upsertOptions.onConflict || "id").split(",").every((
                  k: string,
                ) => r[k] === value[k])
              )
              : null;
            if (old) {
              if (!upsertOptions.ignoreDuplicates) {
                Object.assign(
                  old,
                  structuredClone(value),
                );
              }
              found.push(old);
            } else {
              old = { id: id(serial++), ...structuredClone(value) };
              data.push(old);
              found.push(old);
            }
          }
          writes.push({ table, mode, payload });
        }
        return result = { data: structuredClone(found), error: null };
      };
      const q: any = {
        select: () => q,
        eq: (k: string, v: any) => {
          predicates.push((r) => r[k] === v);
          return q;
        },
        neq: (k: string, v: any) => {
          predicates.push((r) => r[k] !== v);
          return q;
        },
        is: (k: string, v: any) => {
          predicates.push((r) => (r[k] ?? null) === v);
          return q;
        },
        not: () => q,
        in: () => q,
        or: () => q,
        order: () => q,
        limit: () => q,
        range: () => q,
        update: (v: any) => {
          mode = "update";
          payload = v;
          return q;
        },
        insert: (v: any) => {
          mode = "insert";
          payload = v;
          return q;
        },
        upsert: (v: any, o: any) => {
          mode = "upsert";
          payload = v;
          upsertOptions = o || {};
          return q;
        },
        maybeSingle: async () => {
          const r = run();
          return { ...r, data: r.data?.[0] || null };
        },
        single: async () => {
          const r = run();
          return { ...r, data: r.data?.[0] || null };
        },
        then: (ok: any, bad: any) => Promise.resolve(run()).then(ok, bad),
      };
      return q;
    },
  };
  let creates = 0, searches = 0, reads = 0;
  const provider: any[] = [];
  const invoice = (claim: any) => ({
    InvoiceID: INVOICE,
    Type: "ACCREC",
    Status: "DRAFT",
    Contact: { ContactID: CONTACT },
    Reference: claim.reference,
    CurrencyCode: "AUD",
    Total: amount,
    SubTotal: Math.round(amount / 1.1 * 100) / 100,
    TotalTax: Math.round(amount / 11 * 100) / 100,
    AmountPaid: 0,
    LineAmountTypes: "Inclusive",
    LineItems: [{ Description: claim.label, Quantity: 1, UnitAmount: amount }],
    DueDateString: claim.due_date,
  });
  const deps = {
    search: async () => {
      searches++;
      if (options.searchFails) throw new Error("unreadable provider");
      return structuredClone(provider);
    },
    read: async () => {
      reads++;
      if (options.readFails) throw new Error("read unavailable");
      return {
        ...structuredClone(provider[0]),
        ...(options.readOverride || {}),
      };
    },
    create: async (_payload: any, claim: any) => {
      creates++;
      provider.push(invoice(claim));
      if (options.timeout) throw new Error("accepted but response unknown");
      return {
        success: true,
        xero_invoice_id: INVOICE,
        xero_provider_status: "DRAFT",
        xero_provider_type: "ACCREC",
        emailed: false,
        email_status: "not_requested",
      };
    },
  };
  return {
    client,
    tables,
    writes,
    deps,
    provider,
    invoice,
    counts: () => ({ creates, searches, reads }),
  };
}
Deno.test("accepted billing parser: only exact later sealed stage and balanced printed schedule", () => {
  assertEquals(acceptedInstallMilestone(pricing()).ok, true);
  const mutations = [
    (p: any) => p.billing_milestones.milestones[0].id = "deposit",
    (p: any) => p.billing_milestones.milestones[0].label = "Deposit again",
    (p: any) => p.billing_milestones.milestones[0].amount_inc_gst += 0.01,
    (p: any) => p.payment_schedule.payments[1].printed_terms = "Free text",
    (p: any) => p.payment_schedule.payments[1].id = "deposit",
    (p: any) => p.totalIncGST += 0.01,
    (p: any) =>
      p.billing_milestones.milestones.push(p.billing_milestones.milestones[0]),
    (p: any) => p.billing_milestones.milestones[0].due_rule.days = -1,
    (p: any) => p.pricing_complete = false,
  ];
  for (const mutate of mutations) {
    const p = pricing();
    mutate(p);
    assertEquals(acceptedInstallMilestone(p).ok, false);
  }
  assertEquals(acceptedInstallMilestone({}).ok, false);
});
Deno.test("accepted billing: concurrent schedule writers make one inclusive draft, frozen payer and exact cents", async () => {
  const f = fixture();
  const results = await Promise.all([
    processInstallDrafts(f.client, f.deps, JOB, ORG),
    processInstallDrafts(f.client, f.deps, JOB, ORG),
  ]);
  assertEquals(f.counts().creates, 1);
  assertEquals(f.tables.invoice_milestone_draft_claims.length, 1);
  const claim = f.tables.invoice_milestone_draft_claims[0];
  assertEquals(claim.state, "draft_confirmed");
  assertEquals(claim.xero_contact_id, CONTACT);
  assertEquals(claim.amount_cents, Math.round(amount * 100));
  assertEquals(claim.due_date, "2026-11-06");
  assertEquals(f.tables.xero_invoices[0].quote_revision_id, REV);
  assert(results.every((r) => r.automatic_send === false));
  await processInstallDrafts(f.client, f.deps, JOB, ORG);
  assertEquals(f.counts().creates, 1);
});
Deno.test("accepted billing: timeout after provider acceptance remains unknown on all writer retries, recovery binds same draft", async () => {
  const f = fixture({ timeout: true });
  await processInstallDrafts(f.client, f.deps, JOB, ORG);
  const claim = f.tables.invoice_milestone_draft_claims[0];
  assertEquals(claim.state, "unknown");
  const realNow = Date.now;
  Date.now = () => realNow() + 7 * 60 * 1000;
  try {
    await processInstallDrafts(f.client, f.deps, JOB, ORG);
    await processInstallDrafts(f.client, f.deps, JOB, ORG);
  } finally {
    Date.now = realNow;
  }
  assertEquals(f.counts().creates, 1);
  const recovered = await reconcileMilestoneDraft(f.client, f.deps, claim);
  assertEquals(recovered.state, "draft_confirmed");
  assertEquals(recovered.provider_invoice_id, INVOICE);
  assertEquals(f.counts().creates, 1);
});
Deno.test("accepted billing: empty recovery never releases an unknown claim for another create", async () => {
  const f = fixture({ timeout: true });
  await processInstallDrafts(f.client, f.deps, JOB, ORG);
  f.provider.length = 0;
  const r = await reconcileMilestoneDraft(
    f.client,
    f.deps,
    f.tables.invoice_milestone_draft_claims[0],
  );
  assertEquals(r.state, "unknown");
  await processInstallDrafts(f.client, f.deps, JOB, ORG);
  assertEquals(f.counts().creates, 1);
});
Deno.test("accepted billing: search, read-back and mirror faults retain claim with no second PUT", async () => {
  for (
    const options of [
      { searchFails: true },
      { readFails: true },
      { readOverride: { Status: "AUTHORISED" } },
      { readOverride: { Contact: { ContactID: id(99) } } },
      { readOverride: { Total: amount + 0.01 } },
      { failTable: "xero_invoices" },
    ]
  ) {
    const f = fixture(options);
    await processInstallDrafts(f.client, f.deps, JOB, ORG);
    assertEquals(f.tables.invoice_milestone_draft_claims[0].state, "unknown");
    const before = f.counts().creates;
    await processInstallDrafts(f.client, f.deps, JOB, ORG);
    assertEquals(f.counts().creates, before);
  }
});
Deno.test("accepted billing: old, unbound, multi-payer and council contexts hold without provider traffic", async () => {
  const mutations = [
    (f: any) => f.tables.quote_invoice_billing_bindings.length = 0,
    (f: any) => f.tables.quote_invoice_billing_bindings[0].state = "held",
    (f: any) => f.tables.job_documents[0].quote_revision_id = id(88),
    (f: any) => f.tables.job_documents[0].job_contact_id = id(89),
    (f: any) => f.tables.job_documents[0].accepted_at = null,
    (f: any) =>
      f.tables.job_documents.push({ ...f.tables.job_documents[0], id: id(90) }),
    (f: any) => f.tables.quote_revisions[0].pricing_snapshot_json.raw = {},
    (f: any) =>
      f.tables.invoice_milestone_reviews[0].trigger_kind =
        "council_step_complete",
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    await processInstallDrafts(f.client, f.deps, JOB, ORG);
    assertEquals(f.counts(), { creates: 0, searches: 0, reads: 0 });
  }
});
Deno.test("accepted billing: existing exact provider draft reconciles before a first create", async () => {
  const f = fixture({ searchFails: true });
  await processInstallDrafts(f.client, f.deps, JOB, ORG);
  const claim = f.tables.invoice_milestone_draft_claims[0];
  f.provider.push(f.invoice(claim));
  const deps = { ...f.deps, search: async () => f.provider };
  const result = await reconcileMilestoneDraft(f.client, deps, claim);
  assertEquals(result.state, "draft_confirmed");
  assertEquals(f.counts().creates, 0);
});
Deno.test("accepted billing: provider identity, line basis and due date are part of read-back", () => {
  const f = fixture();
  const claim = {
    reference: "fixture",
    xero_contact_id: CONTACT,
    amount_cents: Math.round(amount * 100),
    label: "Installation payment",
    due_date: "2026-11-06",
  };
  const inv = f.invoice(claim);
  assert(matchesDraft(inv, claim));
  for (
    const patch of [
      { Type: "ACCPAY" },
      { CurrencyCode: "USD" },
      { LineAmountTypes: "Exclusive" },
      { DueDateString: "2026-11-07" },
      { LineItems: [] },
    ]
  ) assertEquals(matchesDraft({ ...inv, ...patch }, claim), false);
});

// Real ops-api writer, real createInvoice choke point, captured provider only.
const saved = {
  url: Deno.env.get("SUPABASE_URL"),
  key: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  xero: Deno.env.get("XERO_CLIENT_ID"),
};
Deno.env.set("XERO_CLIENT_ID", "fixture-client-id");
Deno.env.set("SUPABASE_URL", "https://fixture.supabase.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fixture-service-key");
const runtime = await import("./index.ts");
if (saved.xero === undefined) Deno.env.delete("XERO_CLIENT_ID");
else Deno.env.set("XERO_CLIENT_ID", saved.xero);
if (saved.url === undefined) Deno.env.delete("SUPABASE_URL");
else Deno.env.set("SUPABASE_URL", saved.url);
if (saved.key === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", saved.key);
Deno.test("real scheduled status writer reaches one Xero DRAFT PUT; no sends, authorise or contact redirect", async () => {
  let f = fixture();
  const original = globalThis.fetch;
  const puts: any[] = [];
  let provider: any = null;
  let forbidden = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/rest/v1/org_config")) return Response.json([]);
    if (url.includes("/TrackingCategories")) {
      return Response.json({ TrackingCategories: [] });
    }
    if (url.endsWith("/Invoices") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      const total = body.Invoices[0].LineItems.reduce(
        (sum: number, line: any) => sum + line.UnitAmount * line.Quantity,
        0,
      );
      provider = {
        ...body.Invoices[0],
        InvoiceID: INVOICE,
        InvoiceNumber: "INV-FIXTURE",
        Total: total,
        SubTotal: Math.round(total / 1.1 * 100) / 100,
        TotalTax: Math.round(total / 11 * 100) / 100,
        DueDateString: body.Invoices[0].DueDate,
      };
      return Response.json({ Invoices: [provider] });
    }
    if (
      url.includes(`/Invoices/${INVOICE}`) &&
      (!init?.method || init.method === "GET")
    ) return Response.json({ Invoices: [provider] });
    if (url.includes("/Invoices?")) {
      return Response.json({ Invoices: provider ? [provider] : [] });
    }
    if (
      url.includes("/Email") || url.includes("/Contacts") ||
      (url.includes("/Invoices") && init?.method === "POST")
    ) {
      forbidden++;
      throw new Error("Forbidden provider transport");
    }
    if (url.startsWith("https://fixture.supabase.test/functions/")) {
      return Response.json({ success: true });
    }
    throw new Error(`Unexpected captured transport ${url}`);
  };
  try {
    const a = await runtime._updateJobStatus(f.client, {
      job_id: JOB,
      status: "scheduled",
      skip_ghl_push: true,
    });
    assert(
      "invoice_drafts" in a && a.invoice_drafts && "drafts" in a.invoice_drafts,
    );
    assertEquals(a.invoice_drafts.drafts[0]?.state, "draft_confirmed");
    assertEquals(puts.length, 1);
    assertEquals(puts[0].Invoices[0].Status, "DRAFT");
    assertEquals(puts[0].Invoices[0].Contact.ContactID, CONTACT);
    assertEquals(puts[0].Invoices[0].LineAmountTypes, "Inclusive");
    assertEquals(forbidden, 0);
    await runtime._updateJobStatus(f.client, {
      job_id: JOB,
      status: "scheduled",
      skip_ghl_push: true,
    });
    assertEquals(puts.length, 1);
    assertEquals(f.tables.jobs[0].status, "scheduled");
    f = fixture();
    provider = null;
    puts.length = 0;
    const booking = await runtime.createAssignment(f.client, {
      job_id: JOB,
      user_id: id(80),
      scheduled_date: "2026-11-09",
      assignment_type: "install",
    });
    assert(
      "invoice_drafts" in booking && booking.invoice_drafts &&
        "drafts" in booking.invoice_drafts,
    );
    assertEquals(booking.invoice_drafts.drafts[0]?.state, "draft_confirmed");
    assertEquals(puts.length, 1);
    assertEquals(forbidden, 0);
    await runtime.createAssignment(f.client, {
      job_id: JOB,
      user_id: id(81),
      scheduled_date: "2026-11-09",
      assignment_type: "install",
    });
    assertEquals(puts.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});
Deno.test("invoice draft office action denies trades, foreign org and body bypass before provider", async () => {
  const f = fixture();
  for (
    const auth of [{ role: "trade", orgId: ORG }, {
      role: "admin",
      orgId: id(90),
    }]
  ) {
    const r = await runtime._invoiceMilestoneDraftsActionForTest(
      f.client,
      { job_id: JOB, mode: "process" },
      new URLSearchParams(),
      "POST",
      "jwt",
      auth,
      false,
    );
    assertEquals(r.status, 403);
  }
  const bad = await runtime._invoiceMilestoneDraftsActionForTest(
    f.client,
    { job_id: JOB, mode: "process", send_email: true },
    new URLSearchParams(),
    "POST",
    "jwt",
    { role: "admin", orgId: ORG },
    false,
  );
  assertEquals(bad.status, 400);
});

Deno.test("council billing: typed step identity can coexist with installation, duplicate trigger and free text are refused", () => {
  const raw: any = pricing();
  const selected = raw.billing_milestones.milestones[0];
  const trigger = {
    kind: "council_step_completed",
    submission_id: id(7),
    step_id: id(8),
    step_name: "Fixture council checkpoint",
  };
  const stage = {
    ...structuredClone(selected),
    id: "council",
    trigger,
    printed_terms: councilBillingTerms(2, trigger.step_name),
  };
  raw.payment_schedule.payments.push({
    id: stage.id,
    label: stage.label,
    printed_terms: stage.printed_terms,
    amount_inc_gst: amount,
  });
  raw.totalIncGST = amount * 3;
  raw.billing_milestones.milestones.push(stage);
  assertEquals(acceptedBillingMilestones(raw).ok, true);
  for (
    const patch of [{ step_id: "guessed" }, {
      step_name: "Different checkpoint",
    }]
  ) {
    const bad = structuredClone(raw);
    Object.assign(bad.billing_milestones.milestones[1].trigger, patch);
    assertEquals(acceptedBillingMilestones(bad).ok, false);
  }
  const bad = structuredClone(raw);
  bad.billing_milestones.milestones[1].trigger = structuredClone(
    selected.trigger,
  );
  bad.billing_milestones.milestones[1].printed_terms = selected.printed_terms;
  bad.payment_schedule.payments[2].printed_terms = selected.printed_terms;
  assertEquals(acceptedBillingMilestones(bad).ok, false);
});
Deno.test("real explicit council completion reaches one draft and ignores workflow jumps, including exact producer raw when supplied", async () => {
  const file = Deno.env.get("WS6_PRODUCER_PRICING_FILE");
  let raw: any;
  if (file) raw = JSON.parse(await Deno.readTextFile(file));
  else {
    raw = pricing();
    const stage = raw.billing_milestones.milestones[0];
    stage.trigger = {
      kind: "council_step_completed",
      submission_id: id(7),
      step_id: id(8),
      step_name: "Fixture council checkpoint",
    };
    stage.printed_terms = councilBillingTerms(2, stage.trigger.step_name);
    raw.payment_schedule.payments[1].printed_terms = stage.printed_terms;
  }
  const parsed = acceptedBillingMilestones(raw);
  assert(parsed.ok);
  const stage = parsed.stages.find((s: any) =>
    s.trigger.kind === "council_step_completed"
  );
  assert(stage);
  const f = fixture({ rawPricing: raw });
  const sub = {
    id: stage.trigger.submission_id,
    org_id: ORG,
    job_id: JOB,
    template_type: "fixture",
    steps: [{
      step_id: stage.trigger.step_id,
      name: stage.trigger.step_name,
      status: "pending",
    }],
    current_step_index: 0,
  };
  f.tables.council_submissions = [sub];
  f.tables.quote_invoice_council_bindings = [{
    quote_revision_id: REV,
    stage_id: stage.id,
    org_id: ORG,
    job_id: JOB,
    submission_id: sub.id,
    step_id: stage.trigger.step_id,
    step_name: stage.trigger.step_name,
    state: "eligible",
  }];
  f.tables.invoice_milestone_reviews.push({
    ...f.tables.invoice_milestone_reviews[0],
    id: id(9),
    trigger_kind: "council_step_complete",
    source: { submission_id: sub.id, step_id: stage.trigger.step_id },
  });
  const original = globalThis.fetch;
  const creates: any[] = [];
  const provider = new Map<string, any>();
  let forbidden = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/rest/v1/org_config")) return Response.json([]);
    if (url.includes("/TrackingCategories")) {
      return Response.json({ TrackingCategories: [] });
    }
    if (url.endsWith("/Invoices") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      const inv = body.Invoices[0];
      const total = inv.LineItems.reduce(
        (sum: number, line: any) => sum + line.Quantity * line.UnitAmount,
        0,
      );
      const invoice = {
        ...inv,
        InvoiceID: id(100 + creates.length),
        InvoiceNumber: "INV-FIXTURE",
        Total: total,
        SubTotal: Math.round(total / 1.1 * 100) / 100,
        TotalTax: Math.round(total / 11 * 100) / 100,
        DueDateString: inv.DueDate,
      };
      creates.push(body);
      provider.set(invoice.InvoiceID, invoice);
      return Response.json({ Invoices: [invoice] });
    }
    const match = url.match(/\/Invoices\/([0-9a-f-]+)$/);
    if (match && (!init?.method || init.method === "GET")) {
      return Response.json({
        Invoices: provider.has(match[1]) ? [provider.get(match[1])] : [],
      });
    }
    if (url.includes("/Invoices?")) {
      const query = new URL(url).searchParams.get("where") || "";
      return Response.json({
        Invoices: [...provider.values()].filter((i) =>
          query === `Reference=="${i.Reference}"`
        ),
      });
    }
    if (
      url.includes("/Email") || url.includes("/Contacts") ||
      (url.includes("/Invoices") && init?.method === "POST")
    ) {
      forbidden++;
      throw new Error("Forbidden provider transport");
    }
    if (url.startsWith("https://fixture.supabase.test/functions/")) {
      return Response.json({ success: true });
    }
    throw new Error("Unexpected fixture transport");
  };
  try {
    const choices = await runtime._billingCouncilStepsActionForTest(
      f.client,
      new URLSearchParams({ job_id: JOB }),
      "GET",
      "jwt",
      { role: "admin", orgId: ORG },
      false,
    );
    const choiceBody = await choices.json();
    assertEquals(choiceBody.steps[0].step_id, stage.trigger.step_id);
    // Fake source row mirrors the actual SQL trigger; PostgreSQL contract proves the capture and binding separately.
    sub.steps[0] = {
      ...sub.steps[0],
      status: "complete",
      completion_source: "workflow_jump",
    } as any;
    await processInstallDrafts(
      f.client,
      runtime._milestoneDraftDepsForTest(f.client),
      JOB,
      ORG,
      "council_step_complete",
    );
    assertEquals(creates.length, 0);
    const completed: any = await runtime._updateCouncilStatusForTest(f.client, {
      submission_id: sub.id,
      step_id: stage.trigger.step_id,
      status: "complete",
    });
    assertEquals(
      completed.invoice_drafts?.drafts?.[0]?.state,
      "draft_confirmed",
    );
    assertEquals(creates.length, 1);
    await runtime._updateCouncilStatusForTest(f.client, {
      submission_id: sub.id,
      step_id: stage.trigger.step_id,
      status: "complete",
    });
    assertEquals(creates.length, 1);
    if (
      file &&
      parsed.stages.some((s: any) => s.trigger.kind === "install_scheduled")
    ) {
      await runtime._updateJobStatus(f.client, {
        job_id: JOB,
        status: "scheduled",
        skip_ghl_push: true,
      });
      assertEquals(creates.length, 2);
    }
    assertEquals(forbidden, 0);
    assert(
      [...provider.values()].every((i) =>
        i.Status === "DRAFT" && i.LineAmountTypes === "Inclusive" &&
        i.Contact.ContactID === CONTACT
      ),
    );
  } finally {
    globalThis.fetch = original;
  }
});
Deno.test("council step choices are staff-only exact-job GET, never inferred or written", async () => {
  const f = fixture();
  const params = new URLSearchParams({ job_id: JOB });
  for (
    const auth of [{ role: "trade", orgId: ORG }, {
      role: "admin",
      orgId: id(90),
    }]
  ) {
    assertEquals(
      (await runtime._billingCouncilStepsActionForTest(
        f.client,
        params,
        "GET",
        "jwt",
        auth,
        false,
      )).status,
      403,
    );
  }
  assertEquals(
    (await runtime._billingCouncilStepsActionForTest(
      f.client,
      params,
      "POST",
      "jwt",
      { role: "admin", orgId: ORG },
      false,
    )).status,
    405,
  );
  assertEquals(f.writes.length, 0);
});
