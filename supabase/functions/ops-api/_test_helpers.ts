// Test fixtures and stub factories for ops-api/index.ts.
// Pure helpers — no side effects, no network. Deno test imports these
// and feeds the resulting deps object to _verifyAndSendInvoiceEmail.

import { type FakeClaimStore, makeFakeClaimStore } from "../_shared/outbound_send_claim_fake.ts"

export type TableSeed = {
  xero_invoices?: Record<string, any>  // keyed by xero_invoice_id
  jobs?: Record<string, any>           // keyed by id
  makesafe_job_details?: Record<string, any> // keyed by job_id
  makesafe_companies?: Record<string, any> // keyed by id
  business_events?: any[]              // list reads (the invoice email resend gate)
  job_events?: any[]                   // list reads; inserts are appended here too
  read_errors?: Record<string, string> // table -> PostgREST error message on a list read
  claims?: FakeClaimStore              // outbound send claims (client.rpc); one is made when absent
}

export type StubClientCalls = {
  inserts: Array<{ table: string; row: any }>
}

function stubColumn(row: any, col: string): any {
  const path = col.split("->>")
  if (path.length === 2) return row?.[path[0]]?.[path[1]]
  return row?.[col]
}

// Minimal Supabase-client stand-in. .select(...).eq(col, val).maybeSingle() looks
// up a keyed seed by the first .eq() predicate; awaiting a select chain with
// .eq/.in/.order/.limit reads a list seed. .insert(row) is recorded, and a
// job_events insert is appended to that list so a later read sees it.
export function makeStubClient(seed: TableSeed = {}): { client: any; calls: StubClientCalls } {
  const calls: StubClientCalls = { inserts: [] }
  seed.claims = seed.claims || makeFakeClaimStore()
  const claims = seed.claims
  const client = {
    rpc(fn: string, args?: Record<string, unknown>) {
      return claims.rpc(fn, args)
    },
    from(table: string) {
      return {
        select(_cols: string) {
          const filters: Array<(row: any) => boolean> = []
          let firstEq: [string, any] | null = null
          let orderBy: { col: string; ascending: boolean } | null = null
          let limitTo: number | null = null
          const builder: any = {
            eq(col: string, val: any) {
              if (!firstEq) firstEq = [col, val]
              filters.push((row) => stubColumn(row, col) === val)
              return builder
            },
            in(col: string, vals: any[]) {
              filters.push((row) => vals.includes(stubColumn(row, col)))
              return builder
            },
            order(col: string, opts?: { ascending?: boolean }) {
              orderBy = { col, ascending: opts?.ascending !== false }
              return builder
            },
            limit(n: number) {
              limitTo = n
              return builder
            },
            async maybeSingle() {
              const tableData = (seed as any)[table] || {}
              const [col, val] = firstEq || ["", undefined]
              if (col === "xero_invoice_id" || col === "id") {
                return { data: tableData[val] || null, error: null }
              }
              for (const row of Object.values(tableData) as any[]) {
                if (row?.[col] === val) return { data: row, error: null }
              }
              return { data: null, error: null }
            },
            then(resolve: (v: any) => any, reject?: (e: any) => any) {
              const err = seed.read_errors?.[table]
              if (err) return Promise.resolve({ data: null, error: { message: err } }).then(resolve, reject)
              const raw = (seed as any)[table]
              let rows: any[] = Array.isArray(raw) ? raw.filter((r) => filters.every((f) => f(r))) : []
              if (orderBy) {
                const { col, ascending } = orderBy
                rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (ascending ? 1 : -1))
              }
              if (limitTo !== null) rows = rows.slice(0, limitTo)
              return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
            },
          }
          return builder
        },
        async insert(row: any) {
          calls.inserts.push({ table, row })
          if (table === "job_events") {
            seed.job_events = seed.job_events || []
            seed.job_events.push({ ...row, created_at: row.created_at || new Date().toISOString() })
          }
          return { error: null }
        },
      }
    },
  }
  return { client, calls }
}

// Stub xeroGet: routes by path → canned response, or throws if path is in 'throwOn'.
export function makeStubXeroGet(opts: {
  invoices?: Record<string, any>  // keyed by invoice id; full Xero invoice fixture
  throwOn?: string[]              // paths that should throw (simulate Xero failure)
}): { xeroGet: (path: string, at: string, ti: string) => Promise<any>; calls: string[] } {
  const calls: string[] = []
  const xeroGet = async (path: string, _at: string, _ti: string) => {
    calls.push(path)
    if (opts.throwOn?.some(p => path.startsWith(p))) {
      throw new Error("simulated Xero outage: " + path)
    }
    if (path.startsWith("/Invoices/")) {
      const id = path.replace("/Invoices/", "")
      const inv = opts.invoices?.[id]
      if (!inv) throw new Error("no fixture for " + path)
      return { Invoices: [inv] }
    }
    throw new Error("unhandled stub path: " + path)
  }
  return { xeroGet, calls }
}

// Stub fetch: routes by URL prefix → canned Response, records every call.
export type FetchSpy = {
  fetch: typeof globalThis.fetch
  calls: Array<{ url: string; init?: RequestInit }>
}
export function makeStubFetch(routes: Record<string, () => Response | Promise<Response>>): FetchSpy {
  const calls: FetchSpy["calls"] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.toString() : (input as Request).url)
    calls.push({ url, init })
    for (const prefix of Object.keys(routes)) {
      if (url.startsWith(prefix)) return await routes[prefix]()
    }
    throw new Error("unhandled stub fetch: " + url)
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

// Stub getToken: returns canned tokens by default; set `throws: true` to simulate
// a Xero token-endpoint outage. callCount() lets tests assert that getToken was (or
// was not) reached for a given input.
export function makeStubGetToken(opts: { throws?: boolean } = {}) {
  let calls = 0
  const getToken = async (_client: any) => {
    calls++
    if (opts.throws) throw new Error("simulated Xero token outage")
    return { accessToken: "stub-access-token", tenantId: "stub-tenant-id" }
  }
  return { getToken, callCount: () => calls }
}

// Stub logBusinessEvent: records calls, never inserts.
export function makeStubLogBusinessEvent() {
  const events: any[] = []
  const logBusinessEvent = async (_client: any, event: any) => {
    events.push(event)
  }
  return { logBusinessEvent, events }
}

// Default env with safe placeholders (never reached; we stub fetch).
export const STUB_ENV = {
  XERO_API_BASE: "https://stub-xero.invalid",
  SUPABASE_URL: "https://stub-supabase.invalid",
  SW_API_KEY: "stub-api-key",
}

// Read JSON body from a Response (helper).
export async function jsonBody(resp: Response): Promise<any> {
  return await resp.json()
}

// Build a default valid request body. Override fields per test.
export function makeBody(overrides: Record<string, any> = {}): any {
  return {
    xero_invoice_id: "inv-123",
    to_email: "client@example.com",
    job_id: "job-uuid-1",
    ...overrides,
  }
}

// Default fixture pair: invoice cached & linked, job has matching client_email,
// Xero contact has the same email. The "happy path" baseline.
export function happyFixture() {
  const xeroInvoice = {
    InvoiceID: "inv-123",
    Contact: {
      ContactID: "xero-contact-1",
      EmailAddress: "client@example.com",
      ContactPersons: [],
    },
  }
  const okPdf = () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 })
  const okOutlook = () =>
    new Response(JSON.stringify({ success: true, accepted: true, delivered: null, delivery_status: "unverified", retry_safe: false }), { status: 202 })
  return {
    seed: {
      xero_invoices: {
        "inv-123": { xero_invoice_id: "inv-123", invoice_number: "INV-001", job_id: "job-uuid-1", xero_contact_id: "xero-contact-1" },
      },
      jobs: {
        "job-uuid-1": { id: "job-uuid-1", client_email: "client@example.com" },
      },
    } satisfies TableSeed,
    xeroInvoice,
    fetchRoutes: {
      "https://stub-xero.invalid/Invoices/": okPdf,
      "https://stub-supabase.invalid/functions/v1/send-outlook-email": okOutlook,
    },
  }
}
