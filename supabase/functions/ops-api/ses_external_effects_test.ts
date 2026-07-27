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
