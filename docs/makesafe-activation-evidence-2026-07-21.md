# Make-safe deterministic activation evidence

**Captain approval:** `captain-final-approval-2026-07-21.md`  
**Activation:** attempted 2026-07-21 05:53:46 UTC  
**Result:** post-cutover idempotency failed; one-switch rollback applied at 05:57:40 UTC

## Guarded activation

Preflight returned four passing checks. The authenticated alarm proof was refreshed and `alarm_readiness.ready` returned true. The atomic cutover updated exactly one settings row:

- mode: `legacy` to `deterministic`
- maximum cases per run: 1
- exact source allowlist: 1 reviewed source, MLB-26443
- instruction allowlist: empty
- operator: `captain-approved-cutover-2026-07-21`

The first live deterministic scan selected the reviewed case and its three correlated source posts. It used zero AI calls and persisted one authoritative `adapter_parse_failure` review exception, three source links and two deduplicated artifacts. It created no job, approval or outbound communication.

## Failed post-cutover verification

The mandatory immediate rerun was not inert. It returned:

- `cases_failed: 1`
- `write_failures: 1`
- `write_failure_reasons.lineage_parent_pending: 1`
- no new case, source, draft or job reported in that response

The following automatic scan also recorded `deterministic_write_failure`. A later in-flight scan expanded the persisted source links from three to four and created one unapproved deterministic `needs_review` draft. The draft has no approved job link. No deterministic job was created, but this proved that repeated runs over the same exact allowlist were not settled or idempotent as required by the runbook.

The first live response also carried `source_read_capped`, so the post-cutover whole-window `zero_unaccounted_proved=true` gate was not met before the idempotency failure stopped the verification chain.

The next new incoming make-safe email was therefore **not** admitted or claimed as verified end to end.

## Reversal

The runbook's one-switch reversal was applied without deleting evidence:

```sql
update public.makesafe_cron_settings
set intake_mode = 'legacy',
    intake_mode_changed_at = now(),
    intake_mode_changed_by = 'captain-approved-cutover-rollback-2026-07-21'
where id = true
  and intake_mode = 'deterministic';
```

Exactly one row changed. Post-rollback state:

- effective mode: `legacy`
- canonical cases: 1 append-only exception
- canonical source links: 4
- artifacts: 2
- deterministic drafts: 1, unapproved
- canonical cases with jobs: 0
- approved deterministic drafts: 0
- last deterministic model calls: 0
- alarm readiness: ready

The canonical case, source links, artifacts and review draft were preserved as required. No backfill, allocation, invoice, client communication or money action was performed. The deterministic draft must remain unapproved while the lineage/idempotency defect is investigated.

## Decision required

Activation is not complete. Before another attempt, the exact-source runtime must prove stable instruction/parent resolution across changing sweep windows and an immediate rerun must produce zero new business writes and zero write failures. A new Captain activation approval is required after remediation evidence.

## Evidence files

- `docs/evidence/makesafe-activation-switch-2026-07-21.json`
- `docs/evidence/makesafe-activation-first-scan-2026-07-21.json`
- `docs/evidence/makesafe-activation-idempotent-rerun-2026-07-21.json`
- `docs/evidence/makesafe-activation-post-scan-db-state-2026-07-21.json`
- `docs/evidence/makesafe-activation-rollback-2026-07-21.json`
- `docs/evidence/makesafe-activation-post-rollback-db-state-2026-07-21.json`
