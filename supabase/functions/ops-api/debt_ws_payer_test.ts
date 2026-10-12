// deno-lint-ignore-file no-import-prefix no-explicit-any
// Debt Workshop: the invoice's PAYER owns the contact, the conversation and the link
// (debt_ws_payer.ts and its use in debt_ws_actions.ts). A shared fence fixture shaped like
// a real two-payer job, with synthetic names (debt_ws_test_fakes.ts addSharedFence).
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resetDebtWsBankCacheForTest,
  DEBT_WS_ACTIONS,
  runDebtWsAction,
} from "./debt_ws_actions.ts";
import {
  messageIsWith,
  resolvePayer,
  sharesOf,
  splitConversation,
  type WsJobContact,
} from "./debt_ws_payer.ts";
import {
  addSharedFence,
  fakeDeps,
  FakeStore,
  IDS,
  JOBS,
  ON,
  SERVER,
  SHARED,
  SHARED_THREAD,
  SHAUN,
  STAFF,
} from "./debt_ws_test_fakes.ts";
import type { WsInvoice, WsJob } from "./debt_ws_rules.ts";

type Deps = ReturnType<typeof fakeDeps>["deps"];

async function call(
  deps: Deps,
  action: string,
  caller = SHAUN,
  input: Record<string, unknown> = {},
) {
  const method = DEBT_WS_ACTIONS[action].method;
  const params = new URLSearchParams(
    method === "GET"
      ? Object.fromEntries(
        Object.entries(input).map(([k, v]) => [k, String(v)]),
      )
      : {},
  );
  _resetDebtWsBankCacheForTest();
  return await runDebtWsAction(
    action,
    method,
    params,
    method === "POST" ? input : {},
    caller,
    deps,
  );
}

function sharedStore() {
  const store = new FakeStore();
  addSharedFence(store);
  return store;
}

const linkNeighbour = (store: FakeStore) => {
  store.contactRows.find((r) => r.id === SHARED.bRow)!.ghl_contact_id =
    SHARED.neighbourGhl;
};

const B_SEND = {
  xero_invoice_id: SHARED.bBal,
  step: "d7",
  action: "send",
  text: "Hi Riley,\n\nThere's $1,420.37 still outstanding.\n\nCheers,\nShaun",
  amount: 1420.37,
};

// ── Who the payer is ──

const JOB: WsJob = {
  id: "j1",
  status: "final_payment",
  type: "fencing",
  job_number: "SWF-1",
  client_name: "Jordan Primary",
  client_phone: "0400 111 000",
  client_email: "jordan@example.test",
  site_address: "1 Road",
  site_suburb: "Town",
  ghl_contact_id: "ghlprimary0000000001",
  xero_contact_id: "xero-a",
};
const ROW_A: WsJobContact = {
  id: "row-a",
  job_id: "j1",
  contact_type: "primary",
  contact_label: "A",
  is_primary: true,
  status: "active",
  client_name: "Jordan Primary",
  client_phone: null,
  client_email: null,
  xero_contact_id: "xero-a",
  ghl_contact_id: null,
};
const ROW_B: WsJobContact = {
  id: "row-b",
  job_id: "j1",
  contact_type: "neighbour_b",
  contact_label: "B",
  is_primary: false,
  status: "active",
  client_name: "Riley  Neighbour",
  client_phone: "0400 999 222",
  client_email: "riley@example.test",
  xero_contact_id: "xero-b",
  ghl_contact_id: null,
};
const invOf = (over: Partial<WsInvoice>) => ({
  xero_contact_id: null,
  contact_name: null,
  reference: null,
  ...over,
});

Deno.test("payer: the job_contacts row with the invoice's Xero contact, whatever the reference says", () => {
  const p = resolvePayer(
    invOf({ xero_contact_id: "XERO-B", reference: "SWF-1-FINBAL" }),
    JOB,
    [ROW_A, ROW_B],
  );
  assertEquals(p, {
    name: "Riley Neighbour",
    phone: "0400 999 222",
    email: "riley@example.test",
    ghl_contact_id: null,
    contact_row_id: "row-b",
    label: "B",
    is_primary: false,
    resolved_by: "xero_contact",
  });
});

Deno.test("payer: falls back to the share letter, then the job's Xero contact, then a single-payer job", () => {
  // Share letter: the row has no Xero contact yet.
  const byLetter = resolvePayer(
    invOf({ xero_contact_id: "xero-new", reference: "SWF-1-B-BAL" }),
    JOB,
    [ROW_A, { ...ROW_B, xero_contact_id: null }],
  );
  assertEquals(byLetter.contact_row_id, "row-b");
  assertEquals(byLetter.resolved_by, "share_letter");

  // The job's own Xero contact: the primary, whose GHL contact falls back to the job's.
  const client = resolvePayer(
    invOf({ xero_contact_id: "xero-a", reference: "SWF-1-FINBAL" }),
    JOB,
    [{ ...ROW_A, xero_contact_id: null }, ROW_B],
  );
  assertEquals(client.is_primary, true);
  assertEquals(client.resolved_by, "job_client");
  assertEquals(client.ghl_contact_id, "ghlprimary0000000001");
  assertEquals(client.phone, "0400 111 000");

  // No rows and no letter: nobody else could owe it.
  const single = resolvePayer(
    invOf({ xero_contact_id: "xero-other", reference: "SWF-1-FINBAL" }),
    JOB,
    [],
  );
  assertEquals(single.resolved_by, "single_payer_job");
  assertEquals(single.ghl_contact_id, "ghlprimary0000000001");
});

Deno.test("payer: never matched by name alone", () => {
  // Same name as the neighbour row, but a different Xero contact and no letter, on a job
  // with a neighbour: not resolved, so nothing is texted or linked by a name guess.
  const p = resolvePayer(
    invOf({
      xero_contact_id: "xero-zzz",
      contact_name: "Riley Neighbour",
      reference: "SWF-1-FINBAL",
    }),
    JOB,
    [ROW_A, ROW_B],
  );
  assertEquals(p.resolved_by, null);
  assertEquals(p.contact_row_id, null);
  assertEquals(p.ghl_contact_id, null);
  assertEquals(p.is_primary, false);
  // An inactive row does not count either.
  const gone = resolvePayer(
    invOf({ xero_contact_id: "xero-b", reference: "SWF-1-B-BAL" }),
    JOB,
    [ROW_A, { ...ROW_B, status: "removed" }],
  );
  assertEquals(gone.resolved_by, null);
});

Deno.test("conversation split: the payer's messages by contact id or email; whole thread marked by party", () => {
  const payer = resolvePayer(
    invOf({ xero_contact_id: "xero-b" }),
    JOB,
    [ROW_A, { ...ROW_B, ghl_contact_id: SHARED.neighbourGhl }],
  );
  const parties = [
    {
      name: "Jordan Primary",
      ghl_contact_id: SHARED.primaryGhl,
      phone: null,
      email: null,
    },
  ];
  const out = splitConversation(SHARED_THREAD, payer, parties);
  assertEquals(out.reason, null);
  assertEquals(out.payer_messages.map((m) => m.id), ["bev:3", "bev:4"]);
  assertEquals(out.all_messages.length, 5);
  const byId = Object.fromEntries(out.all_messages.map((m) => [m.id, m]));
  assertEquals(byId["bev:1"].party_name, "Jordan Primary");
  assertEquals(byId["bev:1"].is_payer, false);
  assertEquals(byId["bev:4"].party_name, "Riley Neighbour");
  assertEquals(byId["note:1"].party_name, null);

  // Not linked: no payer conversation at all, even though an email matches.
  const unlinked = splitConversation(
    SHARED_THREAD,
    { ...payer, ghl_contact_id: null },
    parties,
  );
  assertEquals(unlinked.payer_messages, []);
  assertEquals(unlinked.reason, "payer_not_linked");
  assert(
    messageIsWith({ phone: "+61 400 999 222" }, {
      ghl_contact_id: null,
      phone: "0400 999 222",
      email: null,
    }),
  );
});

Deno.test("shares: one per letter, voided invoices left out, paid and owing", () => {
  const history: WsInvoice[] = [
    ["SWF-1-DEP50", "VOIDED", 500, "xero-a"],
    ["SWF-1-A-BAL", "PAID", 0, "xero-a"],
    ["SWF-1-B-DEP50", "PAID", 0, "xero-b"],
    ["SWF-1-B-BAL", "AUTHORISED", 1420.37, "xero-b"],
  ].map(([reference, status, due, xero], k) => ({
    xero_invoice_id: `i${k}`,
    xero_contact_id: xero as string,
    contact_name: null,
    invoice_number: `INV-${k}`,
    invoice_type: "ACCREC",
    status: status as string,
    reference: reference as string,
    total: 1000,
    amount_due: due as number,
    invoice_date: `2026-0${k + 1}-01`,
    job_id: "j1",
    first_description: null,
  }));
  assertEquals(sharesOf(JOB, history, [ROW_A, ROW_B]), [
    {
      label: "A",
      payer_name: "Jordan Primary",
      is_primary: true,
      owing: 0,
      paid: true,
      invoice_count: 1,
    },
    {
      label: "B",
      payer_name: "Riley Neighbour",
      is_primary: false,
      owing: 1420.37,
      paid: false,
      invoice_count: 2,
    },
  ]);
});

// ── The screen ──

Deno.test("overview: the neighbour's row is theirs; ghl_linked means the PAYER is linked", async () => {
  const store = sharedStore();
  const { deps } = fakeDeps(store);
  const b = (await call(deps, "debt_ws_overview", STAFF)).body as any;
  const row = b.rows.find((r: any) => r.xero_invoice_id === SHARED.bBal);
  assertEquals(
    row.payer_label,
    "Riley Neighbour (neighbour of Jordan Primary)",
  );
  assertEquals(row.ghl_linked, false);
  assertEquals(row.payer_contact.name, "Riley Neighbour");
  assertEquals(row.payer_contact.phone, SHARED.neighbourPhone);
  assertEquals(row.payer_contact.contact_row_id, SHARED.bRow);
  // The single-payer fence is still linked through the job.
  const fence = b.rows.find((r: any) => r.xero_invoice_id === IDS.final);
  assertEquals(fence.ghl_linked, true);
});

Deno.test("job: a neighbour's invoice shows the neighbour's phone, shares, no borrowed conversation", async () => {
  const store = sharedStore();
  const { deps, rec } = fakeDeps(store, { conversation: SHARED_THREAD });
  const searched: string[] = [];
  const search = deps.searchContacts;
  deps.searchContacts = (q) => {
    searched.push(q);
    return search(q);
  };
  const b = (await call(deps, "debt_ws_job", STAFF, {
    xero_invoice_id: SHARED.bBal,
  })).body as any;
  assertEquals(
    b.row.payer_label,
    "Riley Neighbour (neighbour of Jordan Primary)",
  );
  assertEquals(b.payer_contact.phone, SHARED.neighbourPhone);
  assertEquals(b.payer_contact.is_primary, false);
  // The job still reads as the primary's job.
  assertEquals(b.job.client_phone, "0400 111 000");
  assertEquals(
    b.job.shares.map((s: any) => [s.label, s.payer_name, s.owing, s.paid]),
    [["A", "Jordan Primary", 0, true], [
      "B",
      "Riley Neighbour",
      1420.37,
      false,
    ]],
  );
  // Not linked: no conversation, and never the primary's thread in its place.
  assertEquals(b.conversation.messages, []);
  assertEquals(b.conversation.reason, "payer_not_linked");
  assertEquals(b.conversation.all_job_messages_count, 5);
  assertEquals(b.conversation.mode, "payer");
  // Candidates come from the NEIGHBOUR's phone and email.
  assertEquals(searched, [SHARED.neighbourPhone, SHARED.neighbourEmail]);
  assertEquals(b.contact.ghl_contact_id, null);
  assertEquals(b.contact.linkable, true);
  assertEquals(b.send_block.code, "payer_not_linked");
  assertEquals(rec.conversationReads.at(-1)!.contactIds, []);

  // The whole job's thread on request, each message marked by party.
  const all = (await call(deps, "debt_ws_job", STAFF, {
    xero_invoice_id: SHARED.bBal,
    conversation: "all",
  })).body as any;
  assertEquals(all.conversation.mode, "all");
  assertEquals(all.conversation.messages.length, 5);
  assertEquals(
    all.conversation.messages.find((m: any) => m.id === "bev:1").party_name,
    "Jordan Primary",
  );
  assertEquals(
    (await call(deps, "debt_ws_job", STAFF, {
      xero_invoice_id: SHARED.bBal,
      conversation: "everyone",
    })).status,
    400,
  );

  // Linked: the neighbour's own messages only, and their own thread is read too.
  linkNeighbour(store);
  const linked = (await call(deps, "debt_ws_job", STAFF, {
    xero_invoice_id: SHARED.bBal,
  })).body as any;
  assertEquals(linked.conversation.messages.map((m: any) => m.id), [
    "bev:3",
    "bev:4",
  ]);
  assertEquals(linked.conversation.reason, null);
  assertEquals(rec.conversationReads.at(-1)!.contactIds, [SHARED.neighbourGhl]);
  assertEquals(linked.contact.candidates, []);
  assertEquals(linked.send_block.code, "neighbour_send_unsupported");
});

// ── Linking ──

Deno.test("link_contact: a neighbour's contact goes on THEIR job_contacts row, never the job", async () => {
  const store = sharedStore();
  const { deps } = fakeDeps(store);
  const body = {
    xero_invoice_id: SHARED.bBal,
    ghl_contact_id: SHARED.neighbourGhl,
  };
  assertEquals(
    (await call(deps, "debt_ws_link_contact", STAFF, body)).status,
    403,
  );
  // The primary's contact on the neighbour's row is refused.
  const wrong = await call(deps, "debt_ws_link_contact", SHAUN, {
    ...body,
    ghl_contact_id: SHARED.primaryGhl,
  });
  assertEquals(wrong.status, 409);
  assertEquals(wrong.body.code, "contact_belongs_to_other_payer");
  assertEquals(
    store.contactRows.find((r) => r.id === SHARED.bRow)!.ghl_contact_id,
    null,
  );

  const ok = await call(deps, "debt_ws_link_contact", SHAUN, body);
  assertEquals(ok.status, 200);
  assertEquals(ok.body.target, "job_contacts");
  assertEquals(
    store.contactRows.find((r) => r.id === SHARED.bRow)!.ghl_contact_id,
    SHARED.neighbourGhl,
  );
  // The job's (primary's) link is untouched.
  assertEquals(
    store.jobRows.find((j) => j.id === SHARED.job)!.ghl_contact_id,
    SHARED.primaryGhl,
  );
  const logged = store.logRows.at(-1)!;
  assertEquals(logged.kind, "link_contact");
  assertEquals(logged.share_key, SHARED.bBal);
  assertEquals(logged.meta.job_contact_id, SHARED.bRow);

  // A different contact needs replace; job_id is accepted but must match the invoice.
  const other = { ...body, ghl_contact_id: "ghlneighbour00000002" };
  assertEquals(
    (await call(deps, "debt_ws_link_contact", SHAUN, other)).body.code,
    "contact_already_linked",
  );
  assertEquals(
    (await call(deps, "debt_ws_link_contact", SHAUN, {
      ...other,
      job_id: JOBS.fence,
      replace: true,
    })).body.code,
    "job_mismatch",
  );
  assertEquals(
    (await call(deps, "debt_ws_link_contact", SHAUN, {
      ...other,
      job_id: SHARED.job,
      replace: true,
    })).status,
    200,
  );
});

Deno.test("link_contact: the primary keeps the job link; a neighbour's contact never goes on the job", async () => {
  const store = sharedStore();
  linkNeighbour(store);
  const { deps } = fakeDeps(store);
  // A job_id-only call that would put the neighbour's contact on the job.
  const res = await call(deps, "debt_ws_link_contact", SHAUN, {
    job_id: SHARED.job,
    ghl_contact_id: SHARED.neighbourGhl,
    replace: true,
  });
  assertEquals(res.body.code, "contact_belongs_to_other_payer");
  assertEquals(
    store.jobRows.find((j) => j.id === SHARED.job)!.ghl_contact_id,
    SHARED.primaryGhl,
  );
  // The single-payer fence, by its invoice: the job's contact, as before.
  store.jobRows.find((j) => j.id === JOBS.fence)!.ghl_contact_id = null;
  const fence = await call(deps, "debt_ws_link_contact", SHAUN, {
    xero_invoice_id: IDS.final,
    ghl_contact_id: "ghlcandidate00000001",
  });
  assertEquals(fence.body.target, "jobs");
  assertEquals(
    store.jobRows.find((j) => j.id === JOBS.fence)!.ghl_contact_id,
    "ghlcandidate00000001",
  );
});

Deno.test("link_contact: a neighbour with no contact row on the job has nowhere to link", async () => {
  const store = new FakeStore();
  const { deps } = fakeDeps(store);
  // Share B of SWF-90004 has no job_contacts row in the fixture.
  const res = await call(deps, "debt_ws_link_contact", SHAUN, {
    xero_invoice_id: IDS.janFinal,
    ghl_contact_id: "ghlcandidate00000001",
  });
  assertEquals(res.body.code, "payer_not_on_job");
  assertEquals(
    store.jobRows.find((j) => j.id === JOBS.janFence)!.ghl_contact_id,
    "ghlcontact0000000004",
  );
  const job = (await call(deps, "debt_ws_job", STAFF, {
    xero_invoice_id: IDS.janFinal,
  })).body as any;
  assertEquals(job.contact.linkable, false);
  assertEquals(job.contact.candidates, []);
});

// ── Sending ──

Deno.test("decide: a neighbour is never texted on the job's (primary's) contact", async () => {
  const store = sharedStore();
  store.settingsRow.sending_enabled = true;
  const { deps, rec } = fakeDeps(store, { env: ON });
  const unlinked = await call(deps, "debt_ws_decide", SHAUN, B_SEND);
  assertEquals(unlinked.body.code, "payer_not_linked");
  assertEquals(rec.sms.length, 0);

  // Linked: the guarded text path only accepts the job's own contact, so a neighbour
  // send is refused with its own code and logged, not routed around the guard.
  linkNeighbour(store);
  const linked = await call(deps, "debt_ws_decide", SHAUN, B_SEND);
  assertEquals(linked.status, 409);
  assertEquals(linked.body.code, "neighbour_send_unsupported");
  assertEquals(rec.sms.length, 0);
  assertEquals(store.sendRows.length, 0);
  assertEquals(store.logRows.at(-1)!.kind, "send_refused");
  assertEquals(store.logRows.at(-1)!.meta.code, "neighbour_send_unsupported");

  // The single-payer fence still texts its payer, who is the job's contact.
  const fence = await call(deps, "debt_ws_decide", SHAUN, {
    xero_invoice_id: IDS.final,
    step: "d7",
    action: "send",
    text: "Hi Alex,\n\nThere's $1,000.00 still outstanding.\n\nCheers,\nShaun",
    amount: 1000,
  });
  assertEquals(fence.body.sent, true);
  assertEquals(rec.sms[0].ghl_contact_id, "ghlcontact0000000001");
});

// ── Jan's list and the agent ──

Deno.test("Jan's list: a neighbour's line has the neighbour's name and phone, and the site", async () => {
  const store = sharedStore();
  // Day 30: on Jan's list.
  store.invoices.find((i) => i.xero_invoice_id === SHARED.bBal)!.invoice_date =
    "2026-09-08";
  const { deps } = fakeDeps(store);
  const list = (await call(deps, "debt_ws_jan_list", STAFF)).body as any;
  const item = list.items.find((i: any) => i.xero_invoice_id === SHARED.bBal);
  assertEquals(item.name, "Riley Neighbour (neighbour of Jordan Primary)");
  assertEquals(item.phone, SHARED.neighbourPhone);
  assertEquals(item.site_address, "7 Shared Boundary Road, Testville");
});

Deno.test("agent queue: a neighbour's bundle has their contact and only their messages", async () => {
  const store = sharedStore();
  store.settingsRow.agent_enabled = true;
  const { deps } = fakeDeps(store, { conversation: SHARED_THREAD });
  const q = (await call(deps, "debt_ws_agent_queue", SERVER)).body as any;
  const item = q.items.find((i: any) => i.row.xero_invoice_id === SHARED.bBal);
  assertEquals(item.payer_contact.name, "Riley Neighbour");
  assertEquals(item.messages, []);
  assertEquals(item.conversation_reason, "payer_not_linked");
  assertEquals(item.send_block.code, "payer_not_linked");

  linkNeighbour(store);
  const q2 = (await call(deps, "debt_ws_agent_queue", SERVER)).body as any;
  const linked = q2.items.find((i: any) =>
    i.row.xero_invoice_id === SHARED.bBal
  );
  assertEquals(linked.messages.map((m: any) => m.id), ["bev:4", "bev:3"]);
  assert(linked.messages.every((m: any) => !String(m.body).includes("Jordan")));
  assertEquals(linked.send_block.code, "neighbour_send_unsupported");
});
