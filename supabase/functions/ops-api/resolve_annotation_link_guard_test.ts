// deno-lint-ignore-file no-explicit-any
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ApiError, resolveAnnotation } from "./index.ts";

const session = {
  authMode: "jwt",
  role: "admin",
  requestActor: { actor: "user:office", source: "jwt", missing: false },
};

function fixture(options: any = {}) {
  const multi = options.multi === true;
  const tables: Record<string, any[]> = {
    feature_flags: [{
      flag_name: "inbox_link_v1",
      enabled: options.enabled ?? true,
    }],
    ai_annotations: [{
      id: "annotation",
      status: "active",
      annotation_type: "unlinked_invoice",
      structured_data: multi ? { xero_invoice_id: "xero-invoice" } : {
        job_id: "new-job",
        candidate_invoices: [{ id: "invoice" }],
      },
    }],
    xero_invoices: options.missingInvoice ? [] : [{
      id: "invoice",
      xero_invoice_id: "xero-invoice",
      invoice_type: options.bill ? "ACCPAY" : "ACCREC",
      job_id: options.currentJob ?? null,
      ...(options.bound
        ? { invoice_obligation_revision_id: "obligation" }
        : {}),
    }],
    jobs: [
      {
        id: "old-job",
        job_number: "SWF-990001",
        status: "accepted",
        type: "fencing",
        metadata: {},
      },
      ...(options.missingJob ? [] : [{
        id: "new-job",
        job_number: "SWP-990002",
        status: options.jobStatus ?? "accepted",
        type: "patio",
        metadata: options.metadata ?? {},
      }]),
    ],
  };
  const updates: string[] = [];
  const client = {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from(table: string) {
      const predicates: ((row: any) => boolean)[] = [];
      let patch: any;
      const result = () => {
        const data = (tables[table] ?? []).filter((r) =>
          predicates.every((p) => p(r))
        );
        const error = options.readError === table && !patch
          ? { message: "read failed" }
          : options.updateError && table === "xero_invoices" && patch
          ? { message: "update failed" }
          : null;
        if (patch && !error) {
          updates.push(table);
          data.forEach((row) => Object.assign(row, patch));
        }
        return { data: error ? null : data, error };
      };
      const query: any = {
        select: () => query,
        eq: (key: string, value: any) => {
          predicates.push((r) => r[key] === value);
          return query;
        },
        is: (key: string, value: any) => {
          predicates.push((r) => (r[key] ?? null) === value);
          return query;
        },
        in: (key: string, values: any[]) => {
          predicates.push((r) => values.includes(r[key]));
          return query;
        },
        update: (value: any) => {
          patch = value;
          return query;
        },
        insert: () => query,
        maybeSingle: () => {
          const r = result();
          return Promise.resolve({ ...r, data: r.data?.[0] ?? null });
        },
        single: () => query.maybeSingle(),
        then: (resolve: any, reject: any) =>
          Promise.resolve(result()).then(resolve, reject),
      };
      return query;
    },
  };
  const body = {
    annotation_id: "annotation",
    response_value: multi ? "link:new-job" : "link",
    operator_email: "body-spoof",
    confirm_replace: options.confirm,
  };
  return {
    tables,
    updates,
    run: (actor: any = session) => resolveAnnotation(client, body, actor),
  };
}

async function refuses(
  f: ReturnType<typeof fixture>,
  status: number,
  code: string,
  actor?: any,
) {
  const error = await assertRejects(() => f.run(actor), ApiError);
  assertEquals(error.status, status);
  assertEquals((error.body as any)?.error ?? error.message, code);
  assertEquals(f.updates, []);
  assertEquals(f.tables.ai_annotations[0].status, "active");
  return error.body as any;
}

for (const multi of [false, true]) {
  const label = multi ? "selected job" : "candidate invoices";
  Deno.test(`Inbox Link ${label}: bill goes to Reconcile without a write`, async () => {
    const result = await refuses(
      fixture({ multi, bill: true }),
      409,
      "use_reconcile",
    );
    assertEquals(result.message, "Bills are placed in Reconcile.");
  });
  Deno.test(`Inbox Link ${label}: unlinked customer invoice and session actor are saved`, async () => {
    const f = fixture({ multi });
    assertEquals((await f.run()).success, true);
    assertEquals(f.tables.xero_invoices[0].job_id, "new-job");
    assertEquals(f.tables.ai_annotations[0].resolved_by, "user:office");
  });
  Deno.test(`Inbox Link ${label}: replacing a job needs explicit confirmation`, async () => {
    const result = await refuses(
      fixture({ multi, currentJob: "old-job" }),
      409,
      "link_would_replace",
    );
    assertEquals(result.current_job_number, "SWF-990001");
    assertEquals(result.new_job_number, "SWP-990002");
    assertEquals(
      result.message,
      "This invoice is on SWF-990001. Move it to SWP-990002?",
    );
    const f = fixture({ multi, currentJob: "old-job", confirm: true });
    assertEquals((await f.run()).success, true);
    assertEquals(f.tables.xero_invoices[0].job_id, "new-job");
  });
}

Deno.test("Inbox Link: missing invoice is 404 without a write", async () => {
  await refuses(fixture({ missingInvoice: true }), 404, "invoice_not_found");
});
Deno.test("Inbox Link: missing, cancelled and lost target jobs refuse", async () => {
  for (
    const options of [{ missingJob: true }, { jobStatus: "cancelled" }, {
      jobStatus: "lost",
    }]
  ) {
    await refuses(fixture(options), 409, "job_not_live");
  }
});
Deno.test("Inbox Link: only a signed-in staff session may resolve", async () => {
  for (
    const actor of [{ ...session, authMode: "api_key" }, {
      ...session,
      role: "trade",
    }, {
      ...session,
      requestActor: { actor: "office", source: "header", missing: false },
    }]
  ) {
    await refuses(fixture(), 403, "person_session_required", actor);
  }
});
Deno.test("Inbox Link: update failure leaves the annotation active", async () => {
  await refuses(fixture({ updateError: true }), 500, "update failed");
});
Deno.test("Inbox Link: invoice and job read errors fail closed", async () => {
  for (const table of ["xero_invoices", "jobs"]) {
    await refuses(fixture({ readError: table }), 500, "read failed");
  }
});
Deno.test("Inbox Link: explicit SES binding still refuses", async () => {
  const f = fixture({ bound: true });
  const error = await assertRejects(() => f.run());
  assertEquals((error as any).refusal?.code, "sealed_ses_release_required");
  assertEquals(f.updates, []);
});
Deno.test("Inbox Link: synthetic target still refuses", async () => {
  const f = fixture({
    metadata: {
      synthetic_livefire_marker:
        "SWG-SES-LIVEFIRE-TEST-ONLY-00000000-0000-4000-8000-000000000001",
    },
  });
  await assertRejects(() => f.run());
  assertEquals(f.updates, []);
});
