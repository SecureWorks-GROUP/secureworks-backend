// deno-lint-ignore-file no-explicit-any require-await
// ════════════════════════════════════════════════════════════
// U4 test support — an in-memory fake of the subset of the Supabase JS client
// that materials_recon.ts uses. Pure, no network. Shared by the test suite and
// the evidence script so both drive the SAME handlers verbatim.
//
// Supports exactly the chains materials_recon.ts issues:
//   .from(t).select(cols).eq(c,v).maybeSingle()
//   .from(t).select(cols).eq(c,v)                       (awaited → {data:[...]})
//   .from(t).select(cols).eq(c,v).eq(c,v).order(c,o).limit(n)  (awaited)
//   .from(t).select('id, job_number').ilike('job_number', v).limit(1)  (awaited)
//   .from(t).insert(row).select().single()
//   .from(t).update(patch).eq('id', v).select().single()
//   .from(t).insert(row)                                (thenable, for job_events)
// ════════════════════════════════════════════════════════════

export type Store = Record<string, Array<Record<string, any>>>;

type Filter = { kind: "eq" | "ilike"; col: string; val: any };

function rowMatches(row: Record<string, any>, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.kind === "eq") return row[f.col] === f.val;
    // ilike → case-insensitive full-string equality on trimmed values
    const a = String(row[f.col] ?? "").trim().toLowerCase();
    const b = String(f.val ?? "").trim().toLowerCase();
    return a === b;
  });
}

class Query {
  private op: "select" | "insert" | "update" | null = null;
  private filters: Filter[] = [];
  private insertRow: Record<string, any> | null = null;
  private updatePatch: Record<string, any> | null = null;
  private selectAfter = false;
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;

  constructor(private store: Store, private table: string) {}

  private rows(): Array<Record<string, any>> {
    if (!this.store[this.table]) this.store[this.table] = [];
    return this.store[this.table];
  }

  select(_cols?: string) {
    if (this.op === "insert" || this.op === "update") {
      this.selectAfter = true;
    } else {
      this.op = "select";
    }
    return this;
  }
  insert(row: Record<string, any>) {
    this.op = "insert";
    this.insertRow = row;
    return this;
  }
  update(patch: Record<string, any>) {
    this.op = "update";
    this.updatePatch = patch;
    return this;
  }
  eq(col: string, val: any) {
    this.filters.push({ kind: "eq", col, val });
    return this;
  }
  ilike(col: string, val: any) {
    this.filters.push({ kind: "ilike", col, val });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }

  private runSelect(): Array<Record<string, any>> {
    let out = this.rows().filter((r) => rowMatches(r, this.filters));
    if (this.orderCol) {
      const col = this.orderCol;
      out = out.slice().sort((a, b) => {
        const av = a[col] ?? "";
        const bv = b[col] ?? "";
        if (av < bv) return this.orderAsc ? -1 : 1;
        if (av > bv) return this.orderAsc ? 1 : -1;
        return 0;
      });
    }
    if (this.limitN != null) out = out.slice(0, this.limitN);
    // return clones so callers can't mutate the store by reference
    return out.map((r) => ({ ...r }));
  }

  private runInsert(): Record<string, any> {
    const row = {
      id: this.insertRow!.id || crypto.randomUUID(),
      created_at: this.insertRow!.created_at || new Date().toISOString(),
      ...this.insertRow,
    };
    this.rows().push(row);
    return { ...row };
  }

  private runUpdate(): Array<Record<string, any>> {
    const updated: Array<Record<string, any>> = [];
    for (const r of this.rows()) {
      if (rowMatches(r, this.filters)) {
        Object.assign(r, this.updatePatch);
        updated.push({ ...r });
      }
    }
    return updated;
  }

  async maybeSingle() {
    const rows = this.runSelect();
    return { data: rows[0] ?? null, error: null };
  }

  async single() {
    if (this.op === "insert") {
      const row = this.runInsert();
      return { data: row, error: null };
    }
    if (this.op === "update") {
      const rows = this.runUpdate();
      return { data: rows[0] ?? null, error: null };
    }
    const rows = this.runSelect();
    return { data: rows[0] ?? null, error: null };
  }

  // Thenable: awaiting the builder directly resolves the terminal result.
  then(resolve: (v: any) => void, reject?: (e: any) => void) {
    try {
      if (this.op === "insert") {
        const row = this.runInsert();
        resolve(this.selectAfter ? { data: [row], error: null } : { data: null, error: null });
        return;
      }
      if (this.op === "update") {
        const rows = this.runUpdate();
        resolve({ data: this.selectAfter ? rows : null, error: null });
        return;
      }
      resolve({ data: this.runSelect(), error: null });
    } catch (e) {
      if (reject) reject(e);
      else throw e;
    }
  }
  catch() {
    return this;
  }
}

export interface FakeClient {
  from(table: string): Query;
}

export function makeFakeClient(seed: Store = {}): { client: FakeClient; store: Store } {
  // deep-ish clone so each test is isolated
  const store: Store = {};
  for (const k of Object.keys(seed)) store[k] = (seed[k] || []).map((r) => ({ ...r }));
  const client: FakeClient = { from: (table: string) => new Query(store, table) };
  return { client, store };
}

export const ORG = "00000000-0000-0000-0000-000000000001";

// A ready-made seed: one job, and one open queue row per suggestion_reason class,
// plus one already-assigned and one already-dismissed row (for the stats/list test).
export function baseSeed(): Store {
  return {
    jobs: [
      { id: "job-fence-1", job_number: "SWF-25010", client_name: "Test Client A", type: "fencing" },
      { id: "job-patio-2", job_number: "SWP-25029", client_name: "Test Client B", type: "patio" },
    ],
    materials_reconciliation_queue: [
      {
        id: "q-open-noref", org_id: ORG, xero_invoice_id: "xinv-001",
        xero_contact_id: "c-fwwa", contact_name: "Fencing Warehouse WA",
        invoice_number: "12345678", sub_total: 1000, total: 1100,
        invoice_date: "2026-07-02", suggested_job_id: null, suggested_job_number: null,
        suggestion_confidence: "low", suggestion_reason: "no_ref_no_po",
        status: "open", assigned_job_id: null, assigned_by: null, assigned_at: null,
      },
      {
        id: "q-open-suggest", org_id: ORG, xero_invoice_id: "xinv-002",
        xero_contact_id: "c-rr", contact_name: "R&R Fencing",
        invoice_number: "RR-9001", sub_total: 500, total: 550,
        invoice_date: "2026-07-03",
        suggested_job_id: "job-patio-2", suggested_job_number: "SWP-25029",
        suggestion_confidence: "medium", suggestion_reason: "ambiguous_po_competitor",
        status: "open", assigned_job_id: null, assigned_by: null, assigned_at: null,
      },
      {
        id: "q-open-refnojob", org_id: ORG, xero_invoice_id: "xinv-003",
        xero_contact_id: "c-bd", contact_name: "B&D Metals",
        invoice_number: "BD-7777", sub_total: 250, total: 275,
        invoice_date: "2026-07-01", suggested_job_id: null, suggested_job_number: null,
        suggestion_confidence: "low", suggestion_reason: "ref_no_job",
        status: "open", assigned_job_id: null, assigned_by: null, assigned_at: null,
      },
      {
        id: "q-assigned", org_id: ORG, xero_invoice_id: "xinv-100",
        xero_contact_id: "c-bun", contact_name: "Bunnings",
        invoice_number: "2183/00894551", sub_total: 300, total: 330,
        invoice_date: "2026-06-28", suggested_job_id: null, suggested_job_number: null,
        suggestion_confidence: "low", suggestion_reason: "no_ref_no_po",
        status: "assigned", assigned_job_id: "job-fence-1", assigned_by: "prior@sec.au",
        assigned_at: "2026-06-29T02:00:00Z",
      },
      {
        id: "q-notjob", org_id: ORG, xero_invoice_id: "xinv-200",
        xero_contact_id: "c-tel", contact_name: "Telstra",
        invoice_number: "TEL-55", sub_total: 90, total: 99,
        invoice_date: "2026-06-25", suggested_job_id: null, suggested_job_number: null,
        suggestion_confidence: "low", suggestion_reason: "no_ref_no_po",
        status: "not_job_related", assigned_job_id: null, assigned_by: "prior@sec.au",
        assigned_at: "2026-06-26T02:00:00Z",
      },
    ],
    job_materials_facts: [],
    job_events: [],
  };
}
