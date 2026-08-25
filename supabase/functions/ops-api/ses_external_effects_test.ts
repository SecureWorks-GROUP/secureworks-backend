// deno-lint-ignore-file no-import-prefix require-await
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildSesEffect,
  executeSesExternalEffect,
  recordSesObservedExternalEffect,
  SesDispatchGenerationLostError,
  type SesEffectClaim,
  type SesEffectState,
  type SesExternalContext,
  type SesExternalEffect,
  type SesExternalEffectStore,
} from "./ses_external_effects.ts";
import {
  createSupabaseSesEffectStore,
  type SesSupabaseClient,
} from "./ses_reporting_actions.ts";
import {
  createSesGraphMailGateway,
  SES_OPERATION_HEADER,
} from "./ses_graph_mail_gateway.ts";

Deno.test("a superseded dispatch worker cannot state-transition the newer generation", async () => {
  const store = new MemoryEffectStore();
  const effect = await buildSesEffect({
    org_id: "00000000-0000-4000-8000-000000000001",
    effect_kind: "route_send",
    release_revision_id: "40000000-0000-4000-8000-000000000099",
    route_kind: "invoice",
    payload: { subject: "generation fence" },
  });
  const result = await executeSesExternalEffect({
    store,
    effect,
    payload: { subject: "generation fence" },
    adapter: {
      dispatch: () =>
        Promise.reject(
          new SesDispatchGenerationLostError("superseded before Graph send"),
        ),
      reconcile: () => Promise.resolve([]),
      identify: (row: { message_id: string }) => row.message_id,
      digest: (row: { message_id: string }) => row,
    },
    actor: "old-worker",
  });

  assertEquals(result.state, "refused");
  assertEquals(result.dispatched, false);
  assertEquals(store.row?.state, "dispatching");
});

class MemoryEffectStore implements SesExternalEffectStore {
  row: SesExternalEffect | null = null;

  claim(
    effect: Omit<SesExternalEffect, "state">,
    _owner: string,
  ): Promise<SesEffectClaim> {
    if (!this.row) {
      this.row = { ...effect, state: "reserved" };
      return Promise.resolve({
        effect: { ...this.row },
        claim_mode: "dispatch",
        duplicate_refused: false,
      });
    }
    if (
      this.row.operation_key !== effect.operation_key ||
      this.row.payload_hash !== effect.payload_hash
    ) {
      return Promise.reject(new Error("immutable operation conflict"));
    }
    return Promise.resolve({
      effect: { ...this.row },
      claim_mode: this.row.state === "confirmed" ? "confirmed" : "reconcile",
      duplicate_refused: true,
    });
  }

  transition(
    operationKey: string,
    from: SesEffectState,
    to: SesEffectState,
    eventKind: string,
    detail: Record<string, unknown>,
    _actor: string,
  ): Promise<SesExternalEffect> {
    if (!this.row || this.row.operation_key !== operationKey) {
      return Promise.reject(new Error("missing effect"));
    }
    if (this.row.state !== from) {
      return Promise.reject(new Error(`stale state ${from}`));
    }
    // Keep the test ledger byte-for-byte aligned with
    // transition_ses_external_effect_v1. Tests must not invent transitions the
    // deployed SQL rejects.
    const allowed =
      (from === "reserved" && ["dispatching", "failed"].includes(to)) ||
      (from === "reserved" && to === "confirmed" &&
        eventKind === "provider_observed_without_dispatch" &&
        this.row.effect_kind === "invoice_authorise" &&
        String(detail.external_id || "").trim().length > 0) ||
      (from === "dispatching" &&
        ["unknown", "confirmed", "failed"].includes(to)) ||
      (from === "unknown" && ["confirmed", "failed"].includes(to)) ||
      (from === "failed" &&
        ["unknown", "confirmed", "compensated"].includes(to)) ||
      (from === "confirmed" && to === "compensated");
    if (!allowed) {
      return Promise.reject(
        new Error(`invalid external effect transition ${from} -> ${to}`),
      );
    }
    this.row = {
      ...this.row,
      state: to,
      external_id: String(detail.external_id || this.row.external_id || "") ||
        null,
      provider_digest: detail.provider_digest as Record<string, unknown> ||
        this.row.provider_digest,
      failure: "failure" in detail
        ? detail.failure as Record<string, unknown>
        : this.row.failure,
    };
    return Promise.resolve({ ...this.row });
  }

  claimRedispatch(
    effect: SesExternalEffect,
    leaseOwner: string,
    _actor: string,
  ): Promise<SesExternalEffect | null> {
    if (
      !this.row ||
      this.row.operation_key !== effect.operation_key ||
      this.row.state !== effect.state ||
      !["unknown", "failed"].includes(effect.state)
    ) {
      return Promise.resolve(null);
    }
    this.row = {
      ...this.row,
      state: "dispatching",
      lease_owner: leaseOwner,
      lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    };
    return Promise.resolve({ ...this.row });
  }
}

interface EffectTableBuilder {
  update(payload: Record<string, unknown>): EffectTableBuilder;
  eq(column: string, value: unknown): EffectTableBuilder;
  select(): EffectTableBuilder;
  maybeSingle(): Promise<{
    data: SesExternalEffect | null;
    error: { message: string } | null;
  }>;
  insert(payload: Record<string, unknown>): Promise<{
    data: Record<string, unknown> | null;
    error: { message: string } | null;
  }>;
}

function effectField(row: SesExternalEffect, column: string): unknown {
  return (row as unknown as Record<string, unknown>)[column];
}

function createRpcEffectHarness() {
  let row: SesExternalEffect | null = null;
  const transitions: Array<{
    from: SesEffectState;
    to: SesEffectState;
    event_kind: string;
  }> = [];

  const client = {
    from(table: string) {
      let updatePayload: Record<string, unknown> | null = null;
      const filters: Array<[string, unknown]> = [];
      const builder = {} as EffectTableBuilder;
      Object.assign(builder, {
        update(payload: Record<string, unknown>) {
          updatePayload = payload;
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        select() {
          return builder;
        },
        async maybeSingle() {
          if (table !== "ses_external_effects" || !row) {
            return { data: null, error: null };
          }
          const current = row;
          const matches = filters.every(([column, value]) =>
            String(effectField(current, column) ?? "") === String(value ?? "")
          );
          if (!matches) return { data: null, error: null };
          if (updatePayload) {
            row = { ...row, ...updatePayload } as SesExternalEffect;
          }
          return { data: { ...row }, error: null };
        },
        async insert(payload: Record<string, unknown>) {
          if (table !== "ses_external_effect_events") {
            return {
              data: null,
              error: { message: `unexpected insert ${table}` },
            };
          }
          transitions.push({
            from: String(payload.from_state || "") as SesEffectState,
            to: String(payload.to_state || "") as SesEffectState,
            event_kind: String(payload.event_kind || ""),
          });
          return { data: payload, error: null };
        },
      });
      return builder;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "claim_ses_external_effect_v1") {
        const effect = args.p_effect as Omit<SesExternalEffect, "state">;
        if (!row) {
          row = {
            ...effect,
            id: "effect-row-1",
            state: "reserved",
            lease_owner: String(args.p_lease_owner || ""),
            lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          } as SesExternalEffect;
          return {
            data: {
              effect: { ...row },
              claim_mode: "dispatch",
              duplicate_refused: false,
            },
            error: null,
          };
        }
        if (
          row.operation_key !== effect.operation_key ||
          row.payload_hash !== effect.payload_hash ||
          row.effect_kind !== effect.effect_kind ||
          row.external_token !== effect.external_token
        ) {
          return {
            data: null,
            error: {
              code: "23505",
              message:
                "operation_key already belongs to different immutable effect content",
            },
          };
        }
        return {
          data: {
            effect: { ...row },
            claim_mode: row.state === "confirmed" ? "confirmed" : "reconcile",
            duplicate_refused: true,
          },
          error: null,
        };
      }
      const expectationMatches = (
        expectation: Record<string, unknown>,
        expectedState?: string,
      ) => {
        if (!row) return false;
        const exact: Array<[keyof SesExternalEffect, string]> = [
          ["id", "effect_id"],
          ["release_revision_id", "release_revision_id"],
          ["operation_key", "operation_key"],
          ["route_kind", "route_kind"],
          ["external_token", "external_token"],
          ["payload_hash", "payload_hash"],
        ];
        return exact.every(([field, key]) =>
          String(row?.[field] ?? "") === String(expectation[key] ?? "")
        ) && (!expectedState || row.state === expectedState) &&
          (expectation.lease_owner === undefined ||
            String(row.lease_owner || "") ===
              String(expectation.lease_owner || "")) &&
          (expectation.lease_expires_at === undefined ||
            String(row.lease_expires_at || "") ===
              String(expectation.lease_expires_at || ""));
      };
      if (name === "inspect_stale_ses_route_dispatch_v1") {
        const expectation = args.p_expectation as Record<string, unknown>;
        const expired = expectationMatches(expectation, "dispatching") &&
          Date.parse(String(row?.lease_expires_at || "")) <= Date.now();
        return { data: expired && row ? { ...row } : null, error: null };
      }
      if (name === "settle_stale_ses_route_dispatch_v1") {
        const expectation = args.p_expectation as Record<string, unknown>;
        const expired = expectationMatches(expectation, "dispatching") &&
          Date.parse(String(row?.lease_expires_at || "")) <= Date.now();
        if (!expired || !row) return { data: null, error: null };
        const outcome = args.p_outcome as Record<string, unknown>;
        const from = row.state;
        if (outcome.kind === "sent" && outcome.match_count === 1) {
          row = {
            ...row,
            state: "confirmed",
            external_id: String(outcome.external_id || ""),
            provider_digest: outcome.provider_digest as Record<string, unknown>,
          };
          transitions.push({
            from,
            to: "confirmed",
            event_kind: "stale_dispatch_provider_confirmed",
          });
          return { data: { ...row }, error: null };
        }
        if (outcome.kind === "no_send" && outcome.match_count === 0) {
          row = {
            ...row,
            state: "failed",
            failure: { code: "dispatch_lease_timeout" },
          };
          transitions.push({
            from,
            to: "failed",
            event_kind: "dispatch_lease_timed_out_no_send",
          });
          return { data: { ...row }, error: null };
        }
        return {
          data: null,
          error: { code: "22023", message: "invalid stale outcome" },
        };
      }
      if (name === "claim_ses_route_redispatch_v1") {
        const expectation = args.p_expectation as Record<string, unknown>;
        const priorState = String(expectation.state || "");
        if (
          !["unknown", "failed"].includes(priorState) ||
          !expectationMatches(expectation, priorState) || !row
        ) return { data: null, error: null };
        row = {
          ...row,
          state: "dispatching",
          lease_owner: String(args.p_lease_owner || ""),
          lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
        };
        transitions.push({
          from: priorState as SesEffectState,
          to: "dispatching",
          event_kind: "exact_token_absent_redispatch_claimed",
        });
        return { data: { ...row }, error: null };
      }
      if (name === "renew_ses_route_dispatch_lease_v1") {
        const expectation = args.p_expectation as Record<string, unknown>;
        const live = expectationMatches(expectation, "dispatching") &&
          Date.parse(String(row?.lease_expires_at || "")) > Date.now();
        if (!live || !row) return { data: null, error: null };
        row = {
          ...row,
          lease_expires_at: new Date(Date.now() + 900_000).toISOString(),
        };
        return { data: { ...row }, error: null };
      }
      if (name === "transition_ses_external_effect_v1") {
        const operationKey = String(args.p_operation_key || "");
        const fromState = String(args.p_from_state || "") as SesEffectState;
        const toState = String(args.p_to_state || "") as SesEffectState;
        const detail = (args.p_detail || {}) as Record<string, unknown>;
        if (!row || row.operation_key !== operationKey) {
          return {
            data: null,
            error: { code: "P0002", message: "external effect does not exist" },
          };
        }
        if (row.state !== fromState) {
          return {
            data: null,
            error: {
              code: "40001",
              message:
                "external effect state changed; reconcile the existing operation",
            },
          };
        }
        const from = row.state;
        const to = toState;
        const eventKind = String(args.p_event_kind || "");
        const allowed =
          (from === "reserved" && ["dispatching", "failed"].includes(to)) ||
          (from === "reserved" && to === "confirmed" &&
            eventKind === "provider_observed_without_dispatch" &&
            row.effect_kind === "invoice_authorise" &&
            String(detail.external_id || "").trim().length > 0) ||
          (from === "dispatching" &&
            ["unknown", "confirmed", "failed"].includes(to)) ||
          (from === "unknown" && ["confirmed", "failed"].includes(to)) ||
          (from === "failed" &&
            ["unknown", "confirmed", "compensated"].includes(to)) ||
          (from === "confirmed" && to === "compensated");
        if (!allowed) {
          return {
            data: null,
            error: {
              code: "23514",
              message: `invalid external effect transition ${from} -> ${to}`,
            },
          };
        }
        transitions.push({
          from,
          to,
          event_kind: String(args.p_event_kind || ""),
        });
        row = {
          ...row,
          state: to,
          external_id: String(detail.external_id || row.external_id || "") ||
            null,
          provider_digest:
            (detail.provider_digest as Record<string, unknown> | undefined) ||
            row.provider_digest,
          failure: "failure" in detail
            ? detail.failure as Record<string, unknown>
            : row.failure,
        };
        return { data: { ...row }, error: null };
      }
      return {
        data: null,
        error: { message: `unexpected rpc ${name}` },
      };
    },
  };

  return {
    store: createSupabaseSesEffectStore(
      client as unknown as SesSupabaseClient,
    ),
    transitions,
    row: () => row ? { ...row } : null,
    seed(effect: SesExternalEffect) {
      row = { id: effect.id || "effect-row-1", ...effect };
    },
  };
}

Deno.test("second invoice attempt cannot dispatch a second Xero create", async () => {
  const store = new MemoryEffectStore();
  let dispatches = 0;
  let provider: Array<{ InvoiceID: string; Reference: string }> = [];
  const effect = await buildSesEffect({
    org_id: "00000000-0000-4000-8000-000000000001",
    job_id: "10000000-0000-4000-8000-000000000001",
    effect_kind: "invoice_create",
    invoice_obligation_revision_id: "20000000-0000-4000-8000-000000000001",
    payload: { total: 352 },
  });
  const adapter = {
    async dispatch(
      _payload: { total: number },
      context: { external_token: string },
    ) {
      dispatches++;
      provider = [{
        InvoiceID: "xero-invoice-1",
        Reference: context.external_token,
      }];
      return provider[0];
    },
    reconcile(context: { external_token: string }) {
      return Promise.resolve(
        provider.filter((row) => row.Reference === context.external_token),
      );
    },
    identify(result: { InvoiceID: string }) {
      return result.InvoiceID;
    },
    digest(result: { InvoiceID: string }) {
      return { invoice_id: result.InvoiceID };
    },
  };

  const first = await executeSesExternalEffect({
    store,
    effect,
    payload: { total: 352 },
    adapter,
    actor: "operator-1",
  });
  const second = await executeSesExternalEffect({
    store,
    effect,
    payload: { total: 352 },
    adapter,
    actor: "operator-1",
  });

  assertEquals(first.state, "confirmed");
  assertEquals(second.state, "confirmed");
  assertEquals(dispatches, 1, "the duplicate attempt must not call Xero");
  assertEquals(second.dispatched, false);
});

Deno.test(
  "legacy authorised invoice observation confirms its effect without dispatch",
  async () => {
    const store = new MemoryEffectStore();
    const effect = await buildSesEffect({
      org_id: "00000000-0000-4000-8000-000000000001",
      job_id: "10000000-0000-4000-8000-000000000001",
      effect_kind: "invoice_authorise",
      invoice_obligation_revision_id: "20000000-0000-4000-8000-000000000001",
      payload: {
        xero_invoice_id: "legacy-xero-invoice",
        expected_status: "AUTHORISED",
      },
    });
    const observed = await recordSesObservedExternalEffect({
      store,
      effect,
      external_id: "legacy-xero-invoice",
      provider_digest: { status: "AUTHORISED" },
      actor: "legacy-recovery",
    });
    const replay = await recordSesObservedExternalEffect({
      store,
      effect,
      external_id: "legacy-xero-invoice",
      provider_digest: { status: "AUTHORISED" },
      actor: "legacy-recovery",
    });

    assertEquals(observed.state, "confirmed");
    assertEquals(observed.external_id, "legacy-xero-invoice");
    assertEquals(replay.state, "confirmed");
    assertEquals(store.row?.state, "confirmed");
  },
);

Deno.test("unknown invoice outcome reconciles original token and never redispatches", async () => {
  const store = new MemoryEffectStore();
  let dispatches = 0;
  let reconcileMatches: Array<{ InvoiceID: string }> = [];
  const effect = await buildSesEffect({
    org_id: "00000000-0000-4000-8000-000000000001",
    effect_kind: "invoice_create",
    invoice_obligation_revision_id: "20000000-0000-4000-8000-000000000002",
    payload: { total: 100 },
  });
  const adapter = {
    async dispatch() {
      dispatches++;
      throw new Error("timeout after Xero may have committed");
    },
    reconcile() {
      return Promise.resolve(reconcileMatches);
    },
    identify(result: { InvoiceID: string }) {
      return result.InvoiceID;
    },
    digest(result: { InvoiceID: string }) {
      return result;
    },
  };
  const first = await executeSesExternalEffect({
    store,
    effect,
    payload: { total: 100 },
    adapter,
    actor: "operator-1",
  });
  assertEquals(first.state, "refused");
  assertEquals(first.effect.state, "unknown");
  assert(first.refusal?.fact.includes("Xero"));

  reconcileMatches = [{ InvoiceID: "xero-after-timeout" }];
  const resumed = await executeSesExternalEffect({
    store,
    effect,
    payload: { total: 100 },
    adapter,
    actor: "operator-1",
  });
  assertEquals(resumed.state, "confirmed");
  assertEquals(dispatches, 1);
  assertEquals(resumed.dispatched, false);
});

Deno.test(
  "unknown route_send reconciles then safely redispatches the missing exact token only",
  async () => {
    const store = new MemoryEffectStore();
    let dispatches = 0;
    let reconcileMatches: Array<{ message_id: string }> = [];
    const effect = await buildSesEffect({
      org_id: "00000000-0000-4000-8000-000000000001",
      effect_kind: "route_send",
      release_revision_id: "adbfa921-5c98-5dd4-8e36-b3aa6e6a9fff",
      route_kind: "report",
      payload: {
        subject: "MLB-26267 - physical makesafe",
        recipients: ["makesafes@mlbuilders.com.au"],
      },
    });
    const adapter = {
      async dispatch() {
        dispatches++;
        if (dispatches === 1) {
          throw new Error(
            "attachment read failed before Graph accepted a draft",
          );
        }
        reconcileMatches = [{ message_id: "sent-by-safe-retry" }];
        return reconcileMatches[0];
      },
      reconcile() {
        return Promise.resolve(reconcileMatches);
      },
      identify(result: { message_id: string }) {
        return result.message_id;
      },
      digest(result: { message_id: string }) {
        return result;
      },
    };

    const first = await executeSesExternalEffect({
      store,
      effect,
      payload: { subject: "MLB-26267 - physical makesafe" },
      adapter,
      actor: "operator-1",
    });
    assertEquals(first.state, "refused");
    assertEquals(first.effect.state, "unknown");
    assertEquals(first.dispatched, true);
    assertEquals(first.refusal?.code, "graph_outcome_unknown");
    assert(String(first.refusal?.fact || "").includes("attachment read"));

    // Reconcile finds no Draft or Sent Item for the immutable token. The
    // unknown -> failed CAS is legal in the real SQL state machine and gives
    // this retry exclusive permission to redispatch the missing route.
    const retried = await executeSesExternalEffect({
      store,
      effect,
      payload: { subject: "MLB-26267 - physical makesafe" },
      adapter,
      actor: "operator-1",
    });
    assertEquals(retried.state, "confirmed");
    assertEquals(retried.dispatched, true);
    assertEquals(dispatches, 2);
    assertEquals(store.row?.state, "confirmed");

    // Once confirmed, the same release+route operation can never dispatch a
    // third time, even though the caller retries the full release.
    const confirmed = await executeSesExternalEffect({
      store,
      effect,
      payload: { subject: "MLB-26267 - physical makesafe" },
      adapter,
      actor: "operator-1",
    });
    assertEquals(confirmed.state, "confirmed");
    assertEquals(confirmed.dispatched, false);
    assertEquals(dispatches, 2);
  },
);

Deno.test(
  "real RPC store hard-refuses changed payload bytes under an unknown route key",
  async () => {
    const harness = createRpcEffectHarness();
    const stored = await buildSesEffect({
      org_id: "00000000-0000-4000-8000-000000000001",
      effect_kind: "route_send",
      release_revision_id: "40000000-0000-4000-8000-000000000006",
      route_kind: "report",
      payload: {
        recipients: ["frozen@example.test"],
        subject: "Frozen subject A",
      },
    });
    const changed = await buildSesEffect({
      org_id: "00000000-0000-4000-8000-000000000001",
      effect_kind: "route_send",
      release_revision_id: "40000000-0000-4000-8000-000000000006",
      route_kind: "report",
      payload: {
        recipients: ["changed@example.test"],
        subject: "Changed subject B",
      },
    });
    assertEquals(changed.operation_key, stored.operation_key);
    assert(changed.payload_hash !== stored.payload_hash);
    harness.seed({
      ...stored,
      state: "unknown",
      lease_owner: "prior-worker",
      lease_expires_at: "2000-01-01T00:00:00.000Z",
    });
    let reconciles = 0;
    let dispatches = 0;

    const result = await executeSesExternalEffect({
      store: harness.store,
      effect: changed,
      payload: {
        recipients: ["changed@example.test"],
        subject: "Changed subject B",
      },
      adapter: {
        dispatch() {
          dispatches++;
          return Promise.resolve({ message_id: "must-not-send" });
        },
        reconcile() {
          reconciles++;
          return Promise.resolve([] as Array<{ message_id: string }>);
        },
        identify(result: { message_id: string }) {
          return result.message_id;
        },
        digest(result: { message_id: string }) {
          return result;
        },
      },
      actor: "retry-operator",
    });

    assertEquals(result.state, "refused");
    assertEquals(result.refusal?.code, "external_effect_payload_drift");
    assertEquals(result.dispatched, false);
    assertEquals(reconciles, 0);
    assertEquals(dispatches, 0);
    assertEquals(harness.row()?.state, "unknown");
    assertEquals(harness.transitions, []);
  },
);

Deno.test(
  "real RPC store leases Graph draft recovery, completes missing attachments, and confirms once",
  async () => {
    const harness = createRpcEffectHarness();
    const route = {
      subject: "Frozen pack",
      body: "Approved body",
      recipients: ["builder@example.test"],
      cc: ["ses@secureworkswa.com.au"],
      attachment_hashes: ["hash-report", "hash-invoice"],
    };
    const effect = await buildSesEffect({
      org_id: "00000000-0000-4000-8000-000000000001",
      effect_kind: "route_send",
      release_revision_id: "40000000-0000-4000-8000-000000000007",
      route_kind: "report_invoice",
      payload: route,
    });
    const frozen = [{
      hash: "hash-report",
      name: "report.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([1, 2, 3]),
    }, {
      hash: "hash-invoice",
      name: "invoice.pdf",
      contentType: "application/pdf",
      bytes: new Uint8Array([4, 5, 6, 7]),
    }];
    const uploaded: typeof frozen = [];
    let draftCreated = false;
    let failInvoiceOnce = true;
    let sent = false;
    let sends = 0;
    const graphJson = async (url: string, init: RequestInit) => {
      const method = String(init.method || "GET").toUpperCase();
      if (
        method === "POST" && url.endsWith("/messages") &&
        !url.endsWith("/send")
      ) {
        draftCreated = true;
        return { id: "draft-ledger-recovery" };
      }
      if (method === "GET" && url.includes("mailFolders/sentitems")) {
        return sent
          ? {
            value: [{
              id: "sent-ledger-recovery",
              subject: route.subject,
              internetMessageHeaders: [{
                name: SES_OPERATION_HEADER,
                value: effect.external_token,
              }],
            }],
          }
          : { value: [] };
      }
      if (method === "GET" && url.includes("mailFolders/drafts")) {
        return {
          value: draftCreated && !sent
            ? [{
              id: "draft-ledger-recovery",
              subject: route.subject,
              internetMessageHeaders: [{
                name: SES_OPERATION_HEADER,
                value: effect.external_token,
              }],
            }]
            : [],
        };
      }
      if (
        method === "GET" &&
        url.includes("/messages/draft-ledger-recovery/attachments?")
      ) {
        return {
          value: uploaded.map((attachment, index) => ({
            id: `attachment-${index}`,
            name: attachment.name,
            contentType: attachment.contentType,
            size: attachment.bytes.byteLength,
            isInline: false,
          })),
        };
      }
      if (
        method === "GET" &&
        url.includes("/draft-ledger-recovery/attachments/attachment-")
      ) {
        const index = Number(
          url.match(/attachments\/attachment-(\d+)/)?.[1] || "-1",
        );
        const attachment = uploaded[index];
        return {
          id: `attachment-${index}`,
          name: attachment.name,
          contentType: attachment.contentType,
          size: attachment.bytes.byteLength,
          isInline: false,
          contentBytes: btoa(String.fromCharCode(...attachment.bytes)),
        };
      }
      if (method === "POST" && url.endsWith("/send")) {
        sends++;
        sent = true;
        return null;
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const gateway = createSesGraphMailGateway({
      graphJson,
      loadAttachments: async (hashes) =>
        hashes.map((hash) => frozen.find((item) => item.hash === hash)!),
      checkpointDraft: async () => {},
      uploadAttachment: async (_mailbox, _draftId, attachment) => {
        const exact = frozen.find((item) => item.name === attachment.name)!;
        if (exact.hash === "hash-invoice" && failInvoiceOnce) {
          failInvoiceOnce = false;
          throw new Error("synthetic invoice attachment upload failure");
        }
        uploaded.push(exact);
      },
      sentPollAttempts: 1,
    });
    const adapter = {
      dispatch: (
        payload: typeof route,
        context: SesExternalContext,
      ) => gateway.createDraftAndSend(payload, context),
      reconcile: (context: { external_token: string }) =>
        gateway.reconcileSent(context.external_token, route),
      identify: (result: { message_id: string }) => result.message_id,
      digest: (result: { message_id: string }) => result,
    };

    const first = await executeSesExternalEffect({
      store: harness.store,
      effect,
      payload: route,
      adapter,
      actor: "operator-first",
    });
    assertEquals(first.state, "refused");
    assertEquals(first.effect.state, "unknown");
    assertEquals(uploaded.map((item) => item.hash), ["hash-report"]);
    assertEquals(sends, 0);

    const recovered = await executeSesExternalEffect({
      store: harness.store,
      effect,
      payload: route,
      adapter,
      actor: "operator-retry",
    });
    assertEquals(recovered.state, "confirmed");
    assertEquals(recovered.dispatched, false);
    assertEquals(uploaded.map((item) => item.hash), [
      "hash-report",
      "hash-invoice",
    ]);
    assertEquals(sends, 1);
    assertEquals(harness.row()?.state, "confirmed");
    assertEquals(
      harness.transitions.some((transition) =>
        transition.event_kind === "exact_token_absent_redispatch_claimed"
      ),
      true,
    );
  },
);

Deno.test(
  "real RPC store durably fences recovered-draft acknowledgement lag across retries",
  async () => {
    const harness = createRpcEffectHarness();
    const route = {
      subject: "Frozen recovered pack",
      body: "Approved body",
      recipients: ["builder@example.test"],
      cc: ["ses@secureworkswa.com.au"],
      attachment_hashes: [],
    };
    const effect = await buildSesEffect({
      org_id: "00000000-0000-4000-8000-000000000001",
      effect_kind: "route_send",
      release_revision_id: "40000000-0000-4000-8000-000000000008",
      route_kind: "report",
      payload: route,
    });
    harness.seed({
      ...effect,
      state: "unknown",
      lease_owner: "interrupted-worker",
      lease_expires_at: "2000-01-01T00:00:00.000Z",
    });
    let recoveredDraftSends = 0;
    let freshDispatches = 0;
    let draftVisible = true;
    const graphJson = async (url: string, init: RequestInit) => {
      const method = String(init.method || "GET").toUpperCase();
      if (method === "GET" && url.includes("mailFolders/sentitems")) {
        return { value: [] };
      }
      if (method === "GET" && url.includes("mailFolders/drafts")) {
        return {
          value: draftVisible
            ? [{
              id: "draft-accepted-unproven",
              subject: route.subject,
              internetMessageHeaders: [{
                name: SES_OPERATION_HEADER,
                value: effect.external_token,
              }],
            }]
            : [],
        };
      }
      if (
        method === "GET" &&
        url.includes("/messages/draft-accepted-unproven/attachments?")
      ) {
        return { value: [] };
      }
      if (method === "POST" && url.endsWith("/send")) {
        recoveredDraftSends++;
        draftVisible = false;
        return null;
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const gateway = createSesGraphMailGateway({
      graphJson,
      loadAttachments: async () => [],
      checkpointDraft: async () => {},
      uploadAttachment: async () => {},
      sentPollAttempts: 1,
    });
    const adapter = {
      async dispatch() {
        freshDispatches++;
        return {
          message_id: "fresh-send-must-not-run",
          state: "sent" as const,
          operation_token: effect.external_token,
        };
      },
      reconcile: (context: { external_token: string }) =>
        gateway.reconcileSent(context.external_token, route),
      identify: (sent: { message_id: string }) => sent.message_id,
      digest: (sent: { message_id: string }) => sent,
    };
    const first = await executeSesExternalEffect({
      store: harness.store,
      effect,
      payload: route,
      adapter,
      actor: "operator-retry",
    });
    const second = await executeSesExternalEffect({
      store: harness.store,
      effect,
      payload: route,
      adapter,
      actor: "operator-second-retry",
    });

    assertEquals(first.state, "refused");
    assertEquals(first.refusal?.code, "graph_outcome_unknown");
    assertEquals(first.dispatched, true);
    assertEquals(second.state, "refused");
    assertEquals(second.refusal?.code, "graph_outcome_unknown");
    assertEquals(second.dispatched, false);
    assertEquals(recoveredDraftSends, 1);
    assertEquals(freshDispatches, 0);
    assertEquals(harness.row()?.state, "dispatching");
    assertEquals(
      harness.transitions.map((transition) => transition.event_kind),
      ["exact_token_absent_redispatch_claimed"],
    );
  },
);

Deno.test(
  "real RPC store refuses a concurrent redispatch while the first route claim lease is live",
  async () => {
    const harness = createRpcEffectHarness();
    const effect = await buildSesEffect({
      org_id: "00000000-0000-4000-8000-000000000001",
      effect_kind: "route_send",
      release_revision_id: "40000000-0000-4000-8000-000000000001",
      route_kind: "report",
      payload: { subject: "MLB-26267 - physical makesafe" },
    });
    let dispatches = 0;
    let provider: Array<{ message_id: string }> = [];
    let markDispatchStarted!: () => void;
    let releaseDispatch!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      markDispatchStarted = resolve;
    });
    const dispatchRelease = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const adapter = {
      async dispatch(
        _payload: { subject: string },
        context: { external_token: string },
      ) {
        dispatches++;
        assertEquals(context.external_token, effect.external_token);
        markDispatchStarted();
        await dispatchRelease;
        provider = [{ message_id: "first-worker-sent" }];
        return provider[0];
      },
      reconcile() {
        return Promise.resolve(provider);
      },
      identify(result: { message_id: string }) {
        return result.message_id;
      },
      digest(result: { message_id: string }) {
        return result;
      },
    };

    const first = executeSesExternalEffect({
      store: harness.store,
      effect,
      payload: { subject: "MLB-26267 - physical makesafe" },
      adapter,
      actor: "operator-first",
    });
    await dispatchStarted;
    assertEquals(harness.row()?.state, "dispatching");
    assert(
      String(harness.row()?.lease_owner || "").startsWith("operator-first:"),
    );

    const concurrent = await executeSesExternalEffect({
      store: harness.store,
      effect,
      payload: { subject: "MLB-26267 - physical makesafe" },
      adapter,
      actor: "operator-second",
    });
    assertEquals(concurrent.state, "refused");
    assertEquals(concurrent.dispatched, false);
    assertEquals(concurrent.refusal?.code, "graph_outcome_unknown");
    assertEquals(dispatches, 1, "the live lease must fence a second send");

    releaseDispatch();
    const completed = await first;
    assertEquals(completed.state, "confirmed");
    assertEquals(harness.row()?.state, "confirmed");
    assertEquals(dispatches, 1);
  },
);

Deno.test(
  "two uncertainty retries can acquire only one redispatch lease",
  async () => {
    const store = new MemoryEffectStore();
    const effect = await buildSesEffect({
      org_id: "00000000-0000-4000-8000-000000000001",
      effect_kind: "route_send",
      release_revision_id: "40000000-0000-4000-8000-000000000005",
      route_kind: "report",
      payload: { subject: "same frozen route" },
    });
    store.row = {
      ...effect,
      state: "unknown",
      lease_owner: "failed-worker",
      lease_expires_at: "2000-01-01T00:00:00.000Z",
    };
    let reconciles = 0;
    let markFirstReconcileStarted!: () => void;
    let releaseFirstReconcile!: () => void;
    const firstReconcileStarted = new Promise<void>((resolve) => {
      markFirstReconcileStarted = resolve;
    });
    const firstReconcileRelease = new Promise<void>((resolve) => {
      releaseFirstReconcile = resolve;
    });
    let dispatches = 0;
    let provider: Array<{ message_id: string }> = [];
    const adapter = {
      async dispatch() {
        dispatches++;
        provider = [{ message_id: "one-send" }];
        return provider[0];
      },
      async reconcile() {
        reconciles++;
        if (provider.length === 0) {
          markFirstReconcileStarted();
          await firstReconcileRelease;
        }
        return provider;
      },
      identify(result: { message_id: string }) {
        return result.message_id;
      },
      digest(result: { message_id: string }) {
        return result;
      },
    };
    const first = executeSesExternalEffect({
      store,
      effect,
      payload: { subject: "same frozen route" },
      adapter,
      actor: "operator-a",
    });
    await firstReconcileStarted;
    assertEquals(store.row?.state, "dispatching");
    const concurrent = await executeSesExternalEffect({
      store,
      effect,
      payload: { subject: "same frozen route" },
      adapter,
      actor: "operator-b",
    });
    assertEquals(concurrent.state, "refused");
    assertEquals(concurrent.dispatched, false);
    assertEquals(reconciles, 1, "the lease loser makes no provider call");
    assertEquals(dispatches, 0);
    releaseFirstReconcile();
    const completed = await first;
    assertEquals(dispatches, 1);
    assertEquals(store.row?.state, "confirmed");
    assertEquals(completed.dispatched, true);
  },
);

Deno.test(
  "real RPC store exclusively leases unknown and failed routes for same-token redispatch",
  async () => {
    for (const initialState of ["unknown", "failed"] as const) {
      const harness = createRpcEffectHarness();
      const effect = await buildSesEffect({
        org_id: "00000000-0000-4000-8000-000000000001",
        effect_kind: "route_send",
        release_revision_id: initialState === "failed"
          ? "40000000-0000-4000-8000-000000000002"
          : "40000000-0000-4000-8000-000000000003",
        route_kind: "report",
        payload: { subject: `retry ${initialState}` },
      });
      harness.seed({
        ...effect,
        state: initialState,
        lease_owner: "dead-worker",
        lease_expires_at: "2000-01-01T00:00:00.000Z",
      });
      let dispatches = 0;
      let provider: Array<{ message_id: string }> = [];
      const dispatchedTokens: string[] = [];
      const adapter = {
        dispatch(
          _payload: { subject: string },
          context: { external_token: string },
        ) {
          dispatches++;
          dispatchedTokens.push(context.external_token);
          provider = [{ message_id: `retried-${initialState}` }];
          return Promise.resolve(provider[0]);
        },
        reconcile() {
          return Promise.resolve(provider);
        },
        identify(result: { message_id: string }) {
          return result.message_id;
        },
        digest(result: { message_id: string }) {
          return result;
        },
      };

      const retried = await executeSesExternalEffect({
        store: harness.store,
        effect,
        payload: { subject: `retry ${initialState}` },
        adapter,
        actor: "retry-operator",
      });
      assertEquals(retried.state, "confirmed");
      assertEquals(retried.dispatched, true);
      assertEquals(dispatchedTokens, [effect.external_token]);
      assertEquals(dispatches, 1);
      assertEquals(harness.transitions[0], {
        from: initialState,
        to: "dispatching",
        event_kind: "exact_token_absent_redispatch_claimed",
      });

      const confirmed = await executeSesExternalEffect({
        store: harness.store,
        effect,
        payload: { subject: `retry ${initialState}` },
        adapter,
        actor: "retry-operator",
      });
      assertEquals(confirmed.state, "confirmed");
      assertEquals(confirmed.dispatched, false);
      assertEquals(dispatches, 1, "confirmed route must never resend");
    }
  },
);

Deno.test(
  "real RPC store never steals an expired dispatching route lease",
  async () => {
    const harness = createRpcEffectHarness();
    const effect = await buildSesEffect({
      org_id: "00000000-0000-4000-8000-000000000001",
      effect_kind: "route_send",
      release_revision_id: "40000000-0000-4000-8000-000000000004",
      route_kind: "report",
      payload: { subject: "expired but possibly paused" },
    });
    harness.seed({
      ...effect,
      state: "dispatching",
      lease_owner: "paused-worker",
      lease_expires_at: "2000-01-01T00:00:00.000Z",
    });
    let dispatches = 0;
    const result = await executeSesExternalEffect({
      store: harness.store,
      effect,
      payload: { subject: "expired but possibly paused" },
      adapter: {
        dispatch() {
          dispatches++;
          return Promise.resolve({ message_id: "must-not-send" });
        },
        reconcile() {
          return Promise.resolve([] as Array<{ message_id: string }>);
        },
        identify(result: { message_id: string }) {
          return result.message_id;
        },
        digest(result: { message_id: string }) {
          return result;
        },
      },
      actor: "retry-operator",
    });
    assertEquals(result.state, "refused");
    assertEquals(result.dispatched, false);
    assertEquals(dispatches, 0);
    assertEquals(harness.transitions, []);
  },
);

Deno.test(
  "real RPC store times out an expired dispatch only after exhaustive no-send proof and retries through the existing lease path",
  async () => {
    const harness = createRpcEffectHarness();
    const effect = await buildSesEffect({
      org_id: "00000000-0000-4000-8000-000000000001",
      effect_kind: "route_send",
      release_revision_id: "40000000-0000-4000-8000-000000000014",
      route_kind: "invoice",
      payload: { subject: "expired invoice route" },
    });
    harness.seed({
      ...effect,
      state: "dispatching",
      lease_owner: "dead-worker",
      lease_expires_at: "2000-01-01T00:02:00.000Z",
      created_at: "2000-01-01T00:00:00.000Z",
      updated_at: "2000-01-01T00:00:01.000Z",
    });
    let dispatches = 0;
    let provider: Array<{ message_id: string }> = [];
    const result = await executeSesExternalEffect({
      store: harness.store,
      effect,
      payload: { subject: "expired invoice route" },
      adapter: {
        async dispatch() {
          dispatches++;
          provider = [{ message_id: "sent-on-supported-retry" }];
          return provider[0];
        },
        reconcile() {
          return Promise.resolve(provider);
        },
        reconcileStale() {
          return Promise.resolve([] as Array<{ message_id: string }>);
        },
        identify(row: { message_id: string }) {
          return row.message_id;
        },
        digest(row: { message_id: string }) {
          return row;
        },
      },
      actor: "recovery-operator",
    });

    assertEquals(result.state, "confirmed");
    assertEquals(result.dispatched, true);
    assertEquals(dispatches, 1);
    assertEquals(harness.row()?.state, "confirmed");
    assertEquals(harness.row()?.failure, {});
    assertEquals(harness.transitions.slice(0, 2), [
      {
        from: "dispatching",
        to: "failed",
        event_kind: "dispatch_lease_timed_out_no_send",
      },
      {
        from: "failed",
        to: "dispatching",
        event_kind: "exact_token_absent_redispatch_claimed",
      },
    ]);
  },
);

Deno.test(
  "real RPC store confirms a sent-found stale dispatch and never redispatches it",
  async () => {
    const harness = createRpcEffectHarness();
    const effect = await buildSesEffect({
      org_id: "00000000-0000-4000-8000-000000000001",
      effect_kind: "route_send",
      release_revision_id: "40000000-0000-4000-8000-000000000015",
      route_kind: "report",
      payload: { subject: "already sent report" },
    });
    harness.seed({
      ...effect,
      state: "dispatching",
      lease_owner: "dead-worker",
      lease_expires_at: "2000-01-01T00:02:00.000Z",
      created_at: "2000-01-01T00:00:00.000Z",
      updated_at: "2000-01-01T00:00:01.000Z",
    });
    let dispatches = 0;
    const result = await executeSesExternalEffect({
      store: harness.store,
      effect,
      payload: { subject: "already sent report" },
      adapter: {
        dispatch() {
          dispatches++;
          return Promise.resolve({ message_id: "must-not-send" });
        },
        reconcile() {
          return Promise.resolve([] as Array<{ message_id: string }>);
        },
        reconcileStale() {
          return Promise.resolve([{ message_id: "graph-existing-send" }]);
        },
        identify(row: { message_id: string }) {
          return row.message_id;
        },
        digest(row: { message_id: string }) {
          return row;
        },
      },
      actor: "recovery-operator",
    });

    assertEquals(result.state, "confirmed");
    assertEquals(result.dispatched, false);
    assertEquals(dispatches, 0);
    assertEquals(harness.row()?.external_id, "graph-existing-send");
    assertEquals(harness.transitions, [{
      from: "dispatching",
      to: "confirmed",
      event_kind: "stale_dispatch_provider_confirmed",
    }]);
  },
);

Deno.test(
  "real RPC store keeps the stale dispatch fence when provider reconciliation is inconclusive",
  async () => {
    const harness = createRpcEffectHarness();
    const effect = await buildSesEffect({
      org_id: "00000000-0000-4000-8000-000000000001",
      effect_kind: "route_send",
      release_revision_id: "40000000-0000-4000-8000-000000000016",
      route_kind: "photo",
      payload: { subject: "inconclusive photo route" },
    });
    harness.seed({
      ...effect,
      state: "dispatching",
      lease_owner: "dead-worker",
      lease_expires_at: "2000-01-01T00:02:00.000Z",
      created_at: "2000-01-01T00:00:00.000Z",
      updated_at: "2000-01-01T00:00:01.000Z",
    });
    let dispatches = 0;
    const result = await executeSesExternalEffect({
      store: harness.store,
      effect,
      payload: { subject: "inconclusive photo route" },
      adapter: {
        dispatch() {
          dispatches++;
          return Promise.resolve({ message_id: "must-not-send" });
        },
        reconcile() {
          return Promise.resolve([] as Array<{ message_id: string }>);
        },
        reconcileStale() {
          throw new Error("Graph page could not be hydrated");
        },
        identify(row: { message_id: string }) {
          return row.message_id;
        },
        digest(row: { message_id: string }) {
          return row;
        },
      },
      actor: "recovery-operator",
    });

    assertEquals(result.state, "refused");
    assertEquals(result.dispatched, false);
    assertEquals(dispatches, 0);
    assertEquals(harness.row()?.state, "dispatching");
    assertEquals(harness.transitions, []);
    assert(
      String(result.refusal?.fact || "").includes("inconclusive"),
    );
  },
);

Deno.test(
  "real RPC store keeps an unknown invoice effect reconcile-only",
  async () => {
    const harness = createRpcEffectHarness();
    const effect = await buildSesEffect({
      org_id: "00000000-0000-4000-8000-000000000001",
      effect_kind: "invoice_create",
      invoice_obligation_revision_id: "50000000-0000-4000-8000-000000000001",
      payload: { total: 352 },
    });
    harness.seed({
      ...effect,
      state: "unknown",
      lease_owner: "dead-worker",
      lease_expires_at: "2000-01-01T00:00:00.000Z",
    });
    let dispatches = 0;
    const result = await executeSesExternalEffect({
      store: harness.store,
      effect,
      payload: { total: 352 },
      adapter: {
        dispatch() {
          dispatches++;
          return Promise.resolve({ InvoiceID: "must-not-create" });
        },
        reconcile() {
          return Promise.resolve([] as Array<{ InvoiceID: string }>);
        },
        identify(invoice: { InvoiceID: string }) {
          return invoice.InvoiceID;
        },
        digest(invoice: { InvoiceID: string }) {
          return invoice;
        },
      },
      actor: "retry-operator",
    });
    assertEquals(result.state, "refused");
    assertEquals(result.dispatched, false);
    assertEquals(result.refusal?.code, "xero_outcome_unknown");
    assertEquals(dispatches, 0);
    assertEquals(harness.transitions, []);
  },
);

Deno.test(
  "a fresh release revision gets a new route_send operation_key (not the stuck token)",
  async () => {
    // Identity includes release_revision_id: re-preparing a new release is a
    // different exact-once coordinate. The stuck adbfa921 report token is never reused.
    const stuck = await buildSesEffect({
      org_id: "00000000-0000-4000-8000-000000000001",
      effect_kind: "route_send",
      release_revision_id: "adbfa921-5c98-5dd4-8e36-b3aa6e6a9fff",
      route_kind: "report",
      payload: { subject: "MLB-26267 - physical makesafe" },
    });
    const fresh = await buildSesEffect({
      org_id: "00000000-0000-4000-8000-000000000001",
      effect_kind: "route_send",
      release_revision_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      route_kind: "report",
      payload: { subject: "MLB-26267 - physical makesafe" },
    });
    assert(stuck.operation_key !== fresh.operation_key);
    assert(stuck.external_token !== fresh.external_token);
  },
);

Deno.test("direct token reconcile finds an existing Xero invoice before dispatch", async () => {
  const store = new MemoryEffectStore();
  let dispatches = 0;
  const effect = await buildSesEffect({
    org_id: "00000000-0000-4000-8000-000000000001",
    effect_kind: "invoice_create",
    invoice_obligation_revision_id: "20000000-0000-4000-8000-000000000003",
    payload: { total: 220 },
  });
  const adapter = {
    dispatch() {
      dispatches++;
      return Promise.resolve({ InvoiceID: "should-never-dispatch" });
    },
    reconcile() {
      return Promise.resolve([{ InvoiceID: "xero-existing-token-match" }]);
    },
    identify(result: { InvoiceID: string }) {
      return result.InvoiceID;
    },
    digest(result: { InvoiceID: string }) {
      return result;
    },
  };
  const result = await executeSesExternalEffect({
    store,
    effect,
    payload: { total: 220 },
    adapter,
    actor: "operator-1",
  });
  assertEquals(result.state, "confirmed");
  assertEquals(result.dispatched, false);
  assertEquals(dispatches, 0);
});

Deno.test("route effect key is release and route scoped", async () => {
  const report = await buildSesEffect({
    org_id: "00000000-0000-4000-8000-000000000001",
    effect_kind: "route_send",
    release_revision_id: "30000000-0000-4000-8000-000000000001",
    route_kind: "report",
    payload: { subject: "Report" },
  });
  const invoice = await buildSesEffect({
    org_id: "00000000-0000-4000-8000-000000000001",
    effect_kind: "route_send",
    release_revision_id: "30000000-0000-4000-8000-000000000001",
    route_kind: "invoice",
    payload: { subject: "Invoice" },
  });
  assert(report.operation_key !== invoice.operation_key);
});

Deno.test("SES-native invoice void is exact-once and content-addressed", async () => {
  const store = new MemoryEffectStore();
  let dispatches = 0;
  let status = "AUTHORISED";
  const effect = await buildSesEffect({
    org_id: "00000000-0000-4000-8000-000000000001",
    job_id: "10000000-0000-4000-8000-000000000001",
    effect_kind: "invoice_void",
    invoice_obligation_revision_id: "20000000-0000-4000-8000-000000000001",
    artifact_hash:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    payload: { xero_invoice_id: "xero-1", target_status: "VOIDED" },
  });
  const adapter = {
    async dispatch() {
      dispatches++;
      status = "VOIDED";
      return { xero_invoice_id: "xero-1", status };
    },
    reconcile() {
      return Promise.resolve(
        status === "VOIDED" ? [{ xero_invoice_id: "xero-1", status }] : [],
      );
    },
    identify(result: { xero_invoice_id: string; status: string }) {
      return result.xero_invoice_id;
    },
    digest(result: { status: string }) {
      return { status: result.status };
    },
  };
  const first = await executeSesExternalEffect({
    store,
    effect,
    payload: { xero_invoice_id: "xero-1", target_status: "VOIDED" },
    adapter,
    actor: "captain@example.com",
  });
  const retry = await executeSesExternalEffect({
    store,
    effect,
    payload: { xero_invoice_id: "xero-1", target_status: "VOIDED" },
    adapter,
    actor: "captain@example.com",
  });
  assertEquals(first.state, "confirmed");
  assertEquals(retry.state, "confirmed");
  assertEquals(dispatches, 1);
  assertEquals(retry.dispatched, false);
});
