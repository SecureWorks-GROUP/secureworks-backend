// deno-lint-ignore-file no-import-prefix require-await
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildSesEffect,
  executeSesExternalEffect,
  type SesEffectClaim,
  type SesEffectState,
  type SesExternalEffect,
  type SesExternalEffectStore,
} from "./ses_external_effects.ts";
import {
  createSupabaseSesEffectStore,
  type SesSupabaseClient,
} from "./ses_reporting_actions.ts";

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
    _eventKind: string,
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
    };
    return Promise.resolve({ ...this.row });
  }
}

function createRpcEffectHarness() {
  let row: SesExternalEffect | null = null;
  const transitions: Array<{
    from: SesEffectState;
    to: SesEffectState;
    event_kind: string;
  }> = [];

  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "claim_ses_external_effect_v1") {
        const effect = args.p_effect as Omit<SesExternalEffect, "state">;
        if (!row) {
          row = {
            ...effect,
            state: "reserved",
            lease_owner: String(args.p_lease_owner || ""),
            lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
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
        const allowed =
          (from === "reserved" && ["dispatching", "failed"].includes(to)) ||
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
      row = { ...effect };
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
    assertEquals(harness.row()?.lease_owner, "operator-first");

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
  "real RPC store redispatches expired dispatching and unknown routes with the same token",
  async () => {
    for (const initialState of ["dispatching", "unknown"] as const) {
      const harness = createRpcEffectHarness();
      const effect = await buildSesEffect({
        org_id: "00000000-0000-4000-8000-000000000001",
        effect_kind: "route_send",
        release_revision_id: initialState === "dispatching"
          ? "40000000-0000-4000-8000-000000000002"
          : "40000000-0000-4000-8000-000000000003",
        route_kind: "report",
        payload: { subject: `retry ${initialState}` },
      });
      harness.seed({
        ...effect,
        state: initialState,
        lease_owner: "dead-worker",
        lease_expires_at: initialState === "dispatching"
          ? "2000-01-01T00:00:00.000Z"
          : new Date(Date.now() + 120_000).toISOString(),
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
        to: "failed",
        event_kind: "exact_token_absent_retry_started",
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
