# Fence entry integration: server-owned job mint

Status: implementation contract for the guarded `fence-entry-funnel-load-paths-e2` branch. Not deployed. Migration not applied.

## Command

`POST /functions/v1/ghl-proxy?action=mint_fence_job`

Authentication: Supabase user JWT only. Shared keys and service credentials are rejected by this command. Allowed roles are `admin`, `estimator`, `sales`, `ops_manager`, and `division_ops`. The body `organisationId` must exactly match the authenticated user's profile organisation.

This command owns the permanent Supabase job UUID, `SWF-` job number, GHL contact resolution, GHL fencing-opportunity mapping, and mapping reuse. It does not save scope, prepare/send a quote, send SMS/email, or perform any other outbound communication.

### Request

```json
{
  "requestId": "client-persisted-uuid",
  "organisationId": "authenticated-profile-org-uuid",
  "intent": "RESOLVED_NO_JOB",
  "contactId": "ghl-contact-id-or-null",
  "opportunityId": "existing-ghl-opportunity-id-or-null",
  "firstName": "Ada",
  "lastName": "Lovelace",
  "email": "ada@example.com",
  "phone": "0400000000",
  "address": "1 Example Street",
  "suburb": "Perth",
  "expectedExistingJobIds": [],
  "repeatReason": null
}
```

Rules:

- Generate `requestId` with `crypto.randomUUID()` and persist it in the job-keyed local identity record before the first call. Reuse it after a timeout, lost response, reload, repeated click, or offline retry. Never rotate it until a canonical result is stored locally.
- `intent` has no default.
  - `RESOLVED_NO_JOB`: reuse the verified active job for this contact/type rather than minting another.
  - `DELIBERATE_REPEAT`: a genuine additional job. Supply a human reason of at least three characters and the exact sorted `expectedExistingJobIds` shown when the operator confirmed. Changed evidence returns `stale_existing_job_evidence`, never a blind mint.
- An existing `opportunityId` requires `contactId`. The server fetches both from GHL and rejects contact or fencing-pipeline mismatch before mapping.
- A new contact requires email or phone. Email/phone duplicate checks run as one bounded batch. If they identify different contacts, the command stops with `contact_identity_conflict`.
- Do not include scope, pricing, PDF, quote, or communication fields. They are rejected and must remain on their existing guarded paths. The request is capped at 32 KB and `expectedExistingJobIds` at 100 IDs.

### Success response

```json
{
  "success": true,
  "requestId": "client-persisted-uuid",
  "jobId": "canonical-job-uuid",
  "jobNumber": "SWF-26001",
  "contactId": "canonical-ghl-contact-id",
  "opportunityId": "canonical-ghl-opportunity-id",
  "mapping": {
    "outcome": "created",
    "canonicalOutcome": "created"
  },
  "revision": {
    "scopeVersion": 1,
    "scopeHash": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    "updatedAt": "2026-07-21T00:00:00Z",
    "requiresLoad": false
  },
  "timingMs": {
    "reserve": 4.2,
    "contact": 120.5,
    "opportunity": 180.1,
    "complete": 7.4,
    "total": 320.3
  }
}
```

`mapping.outcome` is one of `created`, `deliberate_repeat_created`, `existing_opportunity_reused`, `existing_contact_job_reused`, `concurrent_request_reused`, or `idempotent_replay`. `canonicalOutcome` preserves the ledger's original outcome when the current transport is a replay/race join.

For a brand-new job that is still at its initial revision, `scopeHash` is the known empty-scope cursor and `requiresLoad` is false. Both are derived from the job's current `scope_version`, not from the stored mint outcome, so a replay of the same request after scope has been saved returns `requiresLoad: true` and a null `scopeHash` rather than a stale empty-scope cursor. The entry funnel can hydrate its existing local draft onto the canonical identity without a redundant `find_job`, `load_job`, or job-number request. For an existing cloud job, `scopeHash` is null and `requiresLoad` is true: checkpoint the local draft, then use the existing authenticated `load_job` path before any cloud write. The mint response never reads or transfers `jobs.scope_json`.

The response also exposes a `Server-Timing` header and `Timing-Allow-Origin: *`. Stage timings contain no client identity.

## Typed failures

All failures return `{ "error": "...", "code": "...", "details": ... }` and no quote/communication side effect.

| HTTP | Code | Entry behaviour |
|---|---|---|
| 400 | `invalid_request_id`, `invalid_mint_intent`, `contact_identity_required`, `repeat_reason_required` | Keep local draft open. Correct local identity/input. |
| 401 | `user_jwt_required`, `invalid_user_jwt` | Keep local/unlinked. Re-authenticate. Do not use the shared key. |
| 403 | `org_mismatch`, `role_not_allowed`, `caller_identity_mismatch` | Hard identity stop. Never retry under another tenant. |
| 409 | `mint_in_progress` | Retry the same `requestId`. Do not create a replacement request. |
| 409 | `idempotency_key_reused` | Hard stop: the same request ID was reused with different evidence. |
| 409 | `contact_identity_conflict`, `opportunity_contact_conflict`, `opportunity_pipeline_conflict`, `contact_opportunity_job_conflict`, `multiple_active_jobs`, `mapping_uniqueness_conflict` | Surface the conflict. No automatic mutation or mint. |
| 409 | `ambiguous_historical_mapping` | Ask for identity resolution. Historical NULL mappings are never treated as proof that no job exists. |
| 409 | `stale_existing_job_evidence` | Refresh the client's job list and ask again before a deliberate repeat. |
| 400 | `invalid_mint_request` | Reservation input was rejected by the ledger. Fix the input; retrying unchanged never resolves. |
| 500 | `mint_request_not_found`, `mint_owner_not_found`, `canonical_job_missing` | Ledger integrity failure, not a caller conflict. Escalate rather than loop. |
| 503 | `mint_reconciliation_unproven` | The contact-scoped stamp scan could not be completed, so a create was refused. Retry the same request ID. |
| 503 | `mint_persistence_failed` | Retain the local draft and retry the same request ID. No GHL create occurs before reservation. |
| 5xx | GHL/command typed failure | Retain the local draft and retry the same request ID. A stamped GHL opportunity is reconciled before replacement creation. |

## Idempotency and partial-failure model

1. `reserve_fence_job_mint` writes the request ledger before GHL IO.
2. A database lock row serializes `{org, fencing, contact identity}`. A second request joins the current owner and performs no external create. Callers that reserved under different identity keys (one by email, one by phone) converge only when the contact lock is taken at bind time; the caller that loses ownership there stops executing and polls the canonical owner exactly like a reserve-time joiner. Seven bounded status reads wait about 7.8 seconds for the canonical result; if still running, `mint_in_progress` tells the client to retry the same key.
3. The opportunity name carries `[SW-MINT:<owner-request-uuid>]`. Recovery never relies on GHL free-text `q` matching a bracketed stamp: it lists the resolved contact's fencing-pipeline opportunities and matches the stamp client side. The scan is bounded (10 pages of 100) and fails closed - if it could not reach the end of the listing, the command returns `mint_reconciliation_unproven` rather than creating a possible duplicate. This closes the lost-response/crash window without a browser-side mint.
4. Contact binding and historical ambiguity checks run before opportunity creation. `ambiguous_historical_mapping` is a deliberate hard blocker with no bypass parameter: a fencing job with no verified GHL contact mapping that matches on email, phone digits, or address blocks the mint even when it is `complete` or `invoiced`, and `DELIBERATE_REPEAT` does not exempt it. Resolution is an operator data-repair action (map the legacy job to its GHL contact), not a client-supplied acknowledgement.
5. `complete_fence_job_mint` atomically inserts/reuses the job, assigns `SWF-` number, binds contact/opportunity, completes the ledger, and logs a non-communication job event.
6. Existing `(org, type, opportunity)` mapping uniqueness and existing job-number uniqueness are database constraints.

A caught failure releases the execution lease for immediate same-key retry. A hard process loss leaves a 90-second lease so a concurrent worker cannot double-create; a later same-key retry takes over and reconciles the GHL stamp.

## Local draft and entry-funnel integration

- Local drafts remain usable before, during, and after a failed mint.
- Store the pending request ID with the local draft's job-keyed identity. Do not put permanent-looking job IDs/numbers into the browser before success.
- On success, atomically replace the local identity with returned `jobId`, `jobNumber`, `contactId`, and `opportunityId`, then read it back.
- `requiresLoad:false`: preserve the local draft payload, rewrite its ref to the returned job number, and save through the existing guarded `save_scope` cursor contract.
- `requiresLoad:true`: preserve/checkpoint local work and enter the existing cloud-job reconciliation/load flow. Do not overwrite an existing cloud scope from this response.
- Never restore calls from the fence client to `create_contact_and_opportunity`, `create_job`, or `assign_job_number` for production minting.

## Performance boundaries and existing PRs

The command uses explicit scalar projections. It has no `select('*')`, `RETURNING *`, list/feed `scope_json`, or quote/PDF body. Normal creation uses one reserve RPC, one bind RPC, one record-opportunity RPC, and one atomic complete RPC. Email/phone lookups are a maximum batch of two. GHL request-stamp reconciliation is contact scoped and capped at ten pages of 100 opportunities with per-page timeout; truncation is logged and fails closed. Race polling is capped at seven reads.

This work identifies and does not duplicate the open system-speed PRs:

- backend #334: `ops-api` calendar/pricing narrow projections;
- fence-designer #61: autosave dirty-check, hidden-tab pause, and in-flight guard;
- patio #123: the equivalent patio autosave controls.

Those PRs remain separate. This branch does not reproduce their ops-summary or autosave changes.

## Separately approved release procedure

Do not perform these steps from this task branch.

1. Merge approved backend PR to `main`. Confirm #334's disposition separately; do not copy or squash its changes into this release.
2. Before migration, run the read-only uniqueness proof:

   ```sql
   SELECT org_id, type, ghl_opportunity_id, count(*)
   FROM public.jobs
   WHERE ghl_opportunity_id IS NOT NULL
   GROUP BY 1,2,3
   HAVING count(*) > 1;
   ```

   Required result: zero rows. Any row stops release for a separately approved mapping decision.
3. Apply `20260721000001_fence_job_mint.sql` through the normal migration pipeline. Do not apply it manually from a feature worktree.
4. Deploy `ghl-proxy` from approved `main` CI using its existing `--no-verify-jwt` configuration. Do not manually deploy from this worktree.
5. Keep the entry-funnel branch's browser mint stop in place until the endpoint proof below is green and that branch integrates this exact contract.
6. Merge/deploy the fence entry integration separately. Do not merge fence #61 or patio #123 by implication; each keeps its own review/release decision.

### Exact production proof after approved release

Use approved non-client test identities only. No quote/send action is called.

- Wrong tenant JWT returns `403 org_mismatch`; installer/crew JWT returns `403 role_not_allowed`; shared key returns `401 user_jwt_required`.
- Two devices submit distinct request IDs simultaneously for the same contact/type/evidence. Both responses contain the same `jobId`, `jobNumber`, `contactId`, and `opportunityId`. Read-only proof shows one job mapping and one completed owner ledger.
- Repeat the winning request after discarding its first HTTP response. It returns `idempotent_replay` and the same canonical fields.
- Inject/observe a test GHL response loss after stamped opportunity create. Retry finds one stamped opportunity and creates no replacement.
- Existing opportunity and existing contact-job requests return the expected reuse outcome.
- `Server-Timing` is present. Capture p50/p95 stage and total timings for at least 20 approved test requests/replays. Record response bytes and prove `scope_json` is absent.
- Read-only SQL proves no incomplete invisible identity:

  ```sql
  SELECT state, count(*)
  FROM public.fence_job_mint_requests
  GROUP BY state;

  SELECT m.request_id, m.state, m.contact_id, m.opportunity_id, m.job_id,
         j.job_number, j.ghl_contact_id, j.ghl_opportunity_id
  FROM public.fence_job_mint_requests m
  LEFT JOIN public.jobs j ON j.id = m.job_id
  WHERE m.state = 'complete'
    AND (m.job_id IS NULL OR m.contact_id IS NULL OR m.opportunity_id IS NULL
         OR j.job_number IS NULL OR j.ghl_contact_id IS DISTINCT FROM m.contact_id
         OR j.ghl_opportunity_id IS DISTINCT FROM m.opportunity_id);
  ```

  Required second-query result: zero rows.
- Read-only `job_events` proof for test jobs shows `communication_sent:false` and no quote/email/SMS event caused by mint.

### Rollback

If the endpoint proof fails, stop fence entry integration and revert/disable the `mint_fence_job` Edge handler from approved `main`. Leave the additive ledger/lock tables and completed mappings in place: dropping them would destroy idempotency evidence and make retries unsafe. The legacy non-fence endpoints remain unchanged, while fence production creation stays fail-safe stopped.

Only if the migration applied but no mint request row exists, a separately approved DBA rollback may remove the new RPCs, tables, and opportunity unique index. Never drop `scope_version`/`scope_updated_at` in rollback because they may predate this migration in production. If any ledger row exists, rollback is forward-only: fix/redeploy the handler against the retained schema.
