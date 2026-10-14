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
  DebtWsSendRefusedError,
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
  // No payer contact: no held (unplaced) messages are asked for either.
  assertEquals(rec.conversationReads.at(-1)!.heldContactIds, []);

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
  // Held (unplaced) messages are read for the PAYER's contact only, never the main client's.
  assertEquals(rec.conversationReads.at(-1)!.heldContactIds, [
    SHARED.neighbourGhl,
  ]);
  assertEquals(linked.contact.candidates, []);
  // A linked neighbour can be texted at their own contact.
  assertEquals(linked.send_block, null);
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

Deno.test("decide: a linked neighbour is texted at THEIR own contact, never the job's", async () => {
  const store = sharedStore();
  store.settingsRow.sending_enabled = true;
  const { deps, rec } = fakeDeps(store, { env: ON });
  const unlinked = await call(deps, "debt_ws_decide", SHAUN, B_SEND);
  assertEquals(unlinked.body.code, "payer_not_linked");
  assertEquals(rec.sms.length, 0);

  // Linked: the text goes to the neighbour's job_contacts contact, and names the job so
  // sendChaseSms's contact/job match (job contact or a live party on the same job's
  // contact list) runs on it.
  linkNeighbour(store);
  const linked = await call(deps, "debt_ws_decide", SHAUN, B_SEND);
  assertEquals(linked.body.sent, true);
  assertEquals(rec.sms.length, 1);
  assertEquals(rec.sms[0].ghl_contact_id, SHARED.neighbourGhl);
  assertEquals(rec.sms[0].job_id, SHARED.job);
  assertEquals(rec.sms[0].xero_invoice_id, SHARED.bBal);
  assert(rec.sms[0].ghl_contact_id !== SHARED.primaryGhl);

  // The single-payer fence still texts its payer, who is the job's contact.
  const fence = await call(deps, "debt_ws_decide", SHAUN, {
    xero_invoice_id: IDS.final,
    step: "d7",
    action: "send",
    text: "Hi Alex,\n\nThere's $1,000.00 still outstanding.\n\nCheers,\nShaun",
    amount: 1000,
  });
  assertEquals(fence.body.sent, true);
  assertEquals(rec.sms[1].ghl_contact_id, "ghlcontact0000000001");
});

Deno.test("decide: the guard refusing a neighbour's contact sends nothing and releases the claim", async () => {
  const store = sharedStore();
  store.settingsRow.sending_enabled = true;
  linkNeighbour(store);
  const { deps } = fakeDeps(store, {
    env: ON,
    smsError: new DebtWsSendRefusedError("contact is not on this job"),
  });
  const res = await call(deps, "debt_ws_decide", SHAUN, B_SEND);
  assertEquals(res.body.code, "send_refused_by_guard");
  assertEquals(store.sendRows.at(-1)!.status, "refused");
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
  assertEquals(linked.send_block, null);
});

// ── Greeting name (Shaun, 14 Oct 2026): drafts greet the payer by their GoHighLevel name ──

const FENCE_GHL = "ghlcontact0000000001";

/** A contact search that knows these GoHighLevel contacts, and counts its calls. */
function ghlBook(
  deps: Deps,
  contacts: Array<{ id: string; name: string; firstName: string }>,
) {
  const queries: string[] = [];
  deps.searchContacts = (q) => {
    queries.push(q);
    return Promise.resolve(
      contacts.map((c) => ({ ...c, phone: "", email: "" })),
    );
  };
  return queries;
}

Deno.test("greeting: a linked payer is greeted by their GoHighLevel first name, not Xero's", async () => {
  const store = new FakeStore();
  store.settingsRow.agent_enabled = true;
  const { deps } = fakeDeps(store);
  ghlBook(deps, [
    { id: "ghlsomeoneelse000001", name: "Wrong Person", firstName: "Wrong" },
    { id: FENCE_GHL, name: "Vincent Sample", firstName: "Vincent" },
  ]);
  const b = (await call(deps, "debt_ws_job", STAFF, {
    xero_invoice_id: IDS.final,
  })).body as any;
  assertEquals(b.payer_contact.greeting_name, "Vincent");
  assertEquals(b.payer_contact.greeting_name_source, "ghl");
  assertEquals(b.payer_contact.ghl_name, "Vincent Sample");
  assert(b.suggestion.text.startsWith("Hi Vincent,"), b.suggestion.text);

  // The agent bundle carries the same first name, and its template draft uses it.
  const q = (await call(deps, "debt_ws_agent_queue", SERVER)).body as any;
  const item = q.items.find((i: any) => i.row.xero_invoice_id === IDS.final);
  assertEquals(item.payer_contact.first_name, "Vincent");
  assertEquals(item.payer_contact.greeting_name_source, "ghl");
  assert(item.template_draft.text.startsWith("Hi Vincent,"));
});

Deno.test("greeting: falls back to the Xero first name when unlinked, or when the contact is not found", async () => {
  // Unlinked neighbour: never searched for a greeting, Xero's first name.
  const store = sharedStore();
  const { deps } = fakeDeps(store);
  const queries = ghlBook(deps, [
    { id: SHARED.primaryGhl, name: "Jordan Primary", firstName: "Jordan" },
  ]);
  const b = (await call(deps, "debt_ws_job", STAFF, {
    xero_invoice_id: SHARED.bBal,
  })).body as any;
  assertEquals(b.payer_contact.greeting_name, "Riley");
  assertEquals(b.payer_contact.greeting_name_source, "xero");
  assertEquals(b.payer_contact.ghl_name, null);
  assert(b.suggestion.text.startsWith("Hi Riley,"), b.suggestion.text);
  // Only the link-candidate searches ran (the neighbour's phone and email).
  assertEquals(queries, [SHARED.neighbourPhone, SHARED.neighbourEmail]);

  // Linked, but the search does not return that contact: Xero's first name.
  const fence = new FakeStore();
  const other = fakeDeps(fence).deps;
  ghlBook(other, [
    { id: "ghlsomeoneelse000001", name: "Wrong Person", firstName: "Wrong" },
  ]);
  const f = (await call(other, "debt_ws_job", STAFF, {
    xero_invoice_id: IDS.final,
  })).body as any;
  assertEquals(f.payer_contact.greeting_name_source, "xero");
  assert(!f.suggestion.text.startsWith("Hi Wrong"));

  // A failed search falls back too, and never fails the job read.
  const broken = fakeDeps(new FakeStore()).deps;
  broken.searchContacts = () => Promise.reject(new Error("GHL down"));
  const r = await call(broken, "debt_ws_job", STAFF, {
    xero_invoice_id: IDS.final,
  });
  assertEquals(r.status, 200);
  assertEquals((r.body as any).payer_contact.greeting_name_source, "xero");
});

Deno.test("greeting: a shared-fence neighbour is greeted by their OWN contact's name", async () => {
  const store = sharedStore();
  linkNeighbour(store);
  const { deps } = fakeDeps(store);
  ghlBook(deps, [
    { id: SHARED.primaryGhl, name: "Jordan Primary", firstName: "Jordan" },
    { id: SHARED.neighbourGhl, name: "Rhiannon Neighbour", firstName: "Rhiannon" },
  ]);
  const b = (await call(deps, "debt_ws_job", STAFF, {
    xero_invoice_id: SHARED.bBal,
  })).body as any;
  assertEquals(b.payer_contact.greeting_name, "Rhiannon");
  assertEquals(b.payer_contact.greeting_name_source, "ghl");
  assert(b.suggestion.text.startsWith("Hi Rhiannon,"), b.suggestion.text);
});

Deno.test("greeting: the GoHighLevel name is read once per contact per Perth day", async () => {
  const store = new FakeStore();
  const { deps } = fakeDeps(store);
  const queries = ghlBook(deps, [
    { id: FENCE_GHL, name: "Vincent Sample", firstName: "Vincent" },
  ]);
  _resetDebtWsBankCacheForTest();
  const read = () =>
    runDebtWsAction(
      "debt_ws_job",
      "GET",
      new URLSearchParams({ xero_invoice_id: IDS.final }),
      {},
      STAFF,
      deps,
    );
  assertEquals(((await read()).body as any).payer_contact.greeting_name, "Vincent");
  const first = queries.length;
  assertEquals(first, 1);
  assertEquals(((await read()).body as any).payer_contact.greeting_name, "Vincent");
  assertEquals(queries.length, first);
  _resetDebtWsBankCacheForTest();
});

// ── Company payers (INV-1705, "Thomasz Group" paying a fencing final) ──
// A payer whose Xero name reads like a company is never greeted by the first word of
// that name: the linked GoHighLevel contact's first name when it is a person, else
// "Hi there," with greeting_name_source company_generic.

/** The fence final's store with the payer renamed and the job linked (or not). */
function greetingStore(payerName: string, ghl: string | null) {
  const store = new FakeStore();
  store.settingsRow.agent_enabled = true;
  store.invoices.find((i) => i.xero_invoice_id === IDS.final)!.contact_name =
    payerName;
  store.jobRows.find((j) => j.id === JOBS.fence)!.ghl_contact_id = ghl;
  return store;
}

async function greetingOf(deps: Deps) {
  const b = (await call(deps, "debt_ws_job", STAFF, {
    xero_invoice_id: IDS.final,
  })).body as any;
  const q = (await call(deps, "debt_ws_agent_queue", SERVER)).body as any;
  const item = q.items.find((i: any) => i.row.xero_invoice_id === IDS.final);
  return { b, item };
}

Deno.test("greeting: a company payer with no GoHighLevel contact is greeted Hi there", async () => {
  _resetDebtWsBankCacheForTest();
  const { deps } = fakeDeps(greetingStore("Thomasz Group", null));
  const { b, item } = await greetingOf(deps);
  assertEquals(b.payer_contact.greeting_name, "there");
  assertEquals(b.payer_contact.greeting_name_source, "company_generic");
  assert(b.suggestion.text.startsWith("Hi there,"), b.suggestion.text);
  assert(!b.suggestion.text.includes("Thomasz"), b.suggestion.text);
  // The agent bundle says the same.
  assertEquals(item.payer_contact.first_name, "there");
  assertEquals(item.payer_contact.greeting_name_source, "company_generic");
  assert(item.template_draft.text.startsWith("Hi there,"));
  _resetDebtWsBankCacheForTest();
});

Deno.test("greeting: a company payer linked to a GoHighLevel person is greeted by that person", async () => {
  _resetDebtWsBankCacheForTest();
  const { deps } = fakeDeps(greetingStore("Thomasz Group", FENCE_GHL));
  ghlBook(deps, [{ id: FENCE_GHL, name: "Jo Smith", firstName: "Jo" }]);
  const { b, item } = await greetingOf(deps);
  assertEquals(b.payer_contact.greeting_name, "Jo");
  assertEquals(b.payer_contact.greeting_name_source, "ghl");
  assert(b.suggestion.text.startsWith("Hi Jo,"), b.suggestion.text);
  assertEquals(item.payer_contact.first_name, "Jo");
  assert(item.template_draft.text.startsWith("Hi Jo,"));
  _resetDebtWsBankCacheForTest();
});

Deno.test("greeting: a company payer whose GoHighLevel contact is the company too is greeted Hi there", async () => {
  _resetDebtWsBankCacheForTest();
  const { deps } = fakeDeps(greetingStore("Thomasz Group", FENCE_GHL));
  ghlBook(deps, [{ id: FENCE_GHL, name: "Thomasz Group", firstName: "Thomasz" }]);
  const { b } = await greetingOf(deps);
  assertEquals(b.payer_contact.greeting_name, "there");
  assertEquals(b.payer_contact.greeting_name_source, "company_generic");
  assertEquals(b.payer_contact.ghl_name, "Thomasz Group");
  assert(b.suggestion.text.startsWith("Hi there,"), b.suggestion.text);
  _resetDebtWsBankCacheForTest();
});

Deno.test("greeting: a person payer is unchanged (GoHighLevel name when linked, else Xero's)", async () => {
  _resetDebtWsBankCacheForTest();
  const linked = fakeDeps(greetingStore("Tuan Tran", FENCE_GHL)).deps;
  ghlBook(linked, [{ id: FENCE_GHL, name: "Vincent Tran", firstName: "Vincent" }]);
  const l = await greetingOf(linked);
  assertEquals(l.b.payer_contact.greeting_name, "Vincent");
  assertEquals(l.b.payer_contact.greeting_name_source, "ghl");
  assert(l.b.suggestion.text.startsWith("Hi Vincent,"), l.b.suggestion.text);
  assert(l.item.template_draft.text.startsWith("Hi Vincent,"));
  _resetDebtWsBankCacheForTest();

  const unlinked = fakeDeps(greetingStore("Tuan Tran", null)).deps;
  const u = await greetingOf(unlinked);
  assertEquals(u.b.payer_contact.greeting_name, "Tuan");
  assertEquals(u.b.payer_contact.greeting_name_source, "xero");
  assert(u.b.suggestion.text.startsWith("Hi Tuan,"), u.b.suggestion.text);
  assert(u.item.template_draft.text.startsWith("Hi Tuan,"));
  _resetDebtWsBankCacheForTest();
});
