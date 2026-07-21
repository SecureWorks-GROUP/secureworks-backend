# Make-safe authenticated alarm drill evidence

**Drill time:** 2026-07-21 05:28:24 UTC  
**Authority:** Captain GO recorded in `captain-final-rulings-2026-07-21.md`  
**Activation:** unchanged at `legacy`

## Result

The privileged operator invoked `ops-api?action=makesafe_email_canary` once with the production API credential.

The authenticated route recorded its readiness proof and ran the D4 canary, draft heartbeat, and B1 extraction-health checks:

- authenticated proof recorded: true
- outstanding synthetic D4 expectations: 0
- draft heartbeat: healthy, no alert
- extraction-health alarm: true
- alarm reason: `degraded` from the existing `usage_cap` health state
- `shouldAlert`: true
- `alerted`: true

The alert path produced both durable and delivery-submission evidence:

- canonical `makesafe.reconcile.extraction_degraded` ERROR business event recorded at `2026-07-21 05:28:24.998591+00`
- GHL `client.sms_out` evidence recorded with a non-empty message ID at `2026-07-21 05:28:26.423+00`
- alarm rate-limit timestamp recorded
- `alarm_auth_action = makesafe_email_canary`
- fresh `intake_health.alarm_readiness.ready = true`, with one configured recipient

The GHL event proves the SMS was accepted and assigned a message ID. It is submission evidence, not a handset delivery receipt.

No intake activation, backfill, deterministic live scan, or N=1 comparison was performed. The lane is holding for the Captain's one real email selection and comparison instruction.

## Evidence files

- `docs/evidence/makesafe-alarm-drill-response-2026-07-21.json`
- `docs/evidence/makesafe-alarm-drill-delivery-2026-07-21.json`
- `docs/evidence/makesafe-alarm-drill-readiness-2026-07-21.json`
