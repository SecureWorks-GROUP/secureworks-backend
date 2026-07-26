# SES Reporting whole-flow proof harness

This is the Captain acceptance harness for the seven-stage SES Reporting voyage. It uses Playwright to drive the run, record a video, capture one screenshot per stage, and write a single visual summary.

The harness is deliberately stricter than a normal test. A product capability that does not exist is shown as **NOT BUILT YET**. It is never skipped and never converted into a pass.

## Where the harness lives

The harness owns its own npm project at `tests/e2e/`. `package.json`, `package-lock.json`, `playwright.config.ts`, `tsconfig.json` and `node_modules/` all live there, never at the repository root.

That placement is deliberate. This repository is Deno-rooted: `deno.jsonc` sits at the root and Deno 2 auto-discovers a root `package.json`, defaulting `nodeModulesDir` to `auto` and installing npm dependencies before it resolves anything. That would pull the Playwright toolchain into `deno check`, the hard-blocking `deno cache` step in CI and `deno task test:ops-api`. Keeping the npm project under `tests/e2e/` leaves root Deno resolution untouched.

Every command below is run from the repository root and passes `--prefix tests/e2e`. Evidence still lands under `<repo-root>/artifacts/ses-reporting-proof/`.

## Install once

```bash
npm --prefix tests/e2e ci && npm --prefix tests/e2e exec playwright install chromium
```

## Run the Captain proof

```bash
SES_PROOF_CONTROL_URL="https://<proof-control-endpoint>" SES_PROOF_API_KEY="<privileged-proof-key>" npm --prefix tests/e2e run proof:ses
```

That is the one proof command. It writes a unique run folder under:

```text
artifacts/ses-reporting-proof/<run-id>/
├── fixtures/                 deterministic EML files, PDFs and hashes
├── screenshots/              one watchable image per stage
├── video/whole-flow.webm     the whole Playwright voyage
├── trace/whole-flow.zip      Playwright trace
├── run-summary.json          machine-readable result and artifact ledger
└── summary.html              Captain review surface
```

Set `SES_PROOF_RUN_ID` to repeat the exact marker and fixture identities. Set `SES_PROOF_SEED` to change the deterministic fixture corpus.

If `SES_PROOF_CONTROL_URL` is absent, the proof command still writes an honest summary. Product stages report NOT BUILT YET and the command exits non-zero.

## Harness self-test

```bash
npm --prefix tests/e2e run proof:ses:fixture
```

Fixture mode proves orchestration, screenshots, video, the summary renderer and safety gates, and exercises the canonical authorised Board route seam against deterministic rows (including an observable `jobs` read). Every stage is labelled **SIMULATED, NOT PROOF** and the final verdict is **HARNESS SELF-TEST ONLY**. The route seam check is not product acceptance evidence or live five-minute email-to-Board SLA evidence.

Run the focused safety contract with:

```bash
npm --prefix tests/e2e run test:ses-proof-safety
```

## What CI runs

The `ses-proof-harness` job in `.github/workflows/pr-check.yml` runs on any pull request that touches the harness, works from `tests/e2e`, installs only Chromium, and runs three things:

1. `npm run typecheck:ses-proof`
2. `npm run test:ses-proof-safety`
3. `npm run proof:ses:fixture`

CI never runs the live credentialed proof. It writes real product artifacts and sends real email, so it stays the deliberate one-command manual run documented above.

## The five deterministic intake fates

Every live proof submits exactly five marked EML messages with rendered PDF attachments:

1. confirmed live job
2. visible blocked live job with `missing_required_identity`
3. visible reason-coded exception with `ambiguous_work_order`
4. revision two attached to an existing job, with no sibling job minted
5. accounted non-work with `own_domain_copy`

The generated MIME `To` header is the Captain address. The files enter through the synthetic intake control action, not through an SES mailbox. This matters because test delivery to an SES address is forbidden. The arrival timestamp used for the five-minute law must be recorded by the proof control plane when it accepts the synthetic message, never at a later internal midpoint. That start point is control-plane policy. The harness checks what it can see: it rejects a missing, unparseable or reversed interval and any interval above 300 seconds.

## Hard safety gates

### Recipient

The only allowed transport envelope is:

```json
{
  "to": ["marninms98@gmail.com"],
  "cc": [],
  "bcc": []
}
```

The envelope is checked three times per send:

1. `proof_plan_send` resolves the full route without sending. The harness checks it before calling `proof_execute_send`. Any other address, any extra To address, or any Cc or Bcc stops the run before transport.
2. `proof_execute_send` must echo the envelope it actually handed to transport as `executedRoute` with explicit `to`, `cc` and `bcc` lists. The same lock is applied to it, so a control plane that resolves a clean plan and then adds a Cc or Bcc at transport time is caught.
3. `proof_verify_delivery` must return the recipient headers observed on the delivered message as `observedRecipients` with explicit `to`, `cc` and `bcc` lists. The same lock is applied a third time.

A missing, non-object or partially declared envelope is a refusal, not a pass. Silence is never treated as an empty Cc.

### Accounting

`proof_plan_draft_invoice` must return `plannedStatus: "DRAFT"` before any accounting write. Its contact, reference and every line description must carry the exact run marker. Every line must return `rateConfirmed: true` and a non-empty `rateSource`. Every later money or send response must still report `xeroStatus: "DRAFT"`.

The approval shown in stage 5 is an internal approval of the exact docket release revision. It is not Xero authorisation. The harness rejects AUTHORISED, SUBMITTED, PAID, VOIDED or missing status on an accounting creation response.

### Marker and creation ledger

Every created product artifact must carry the exact run marker:

```text
SWG-SES-E2E-TEST-ONLY-<RUN-ID>
```

Every mutating action must return `createdArtifacts`, even when it is an empty array. The harness registers each ID, kind and marker. An invoice artifact must additionally declare `accountingStatus: "DRAFT"`.

The split is enforced in both directions. `proof_capabilities`, `proof_read_board`, `proof_plan_draft_invoice`, `proof_plan_send`, `proof_verify_delivery`, `proof_plan_cleanup` and `proof_verify_cleanup` are read-only actions and go through a wrapper that refuses the run if any of them declares a non-empty `createdArtifacts`. A capability check, board read, preflight, plan or verification must never create product state: anything created there escapes the registry, and the failure would otherwise surface much later as a confusing `cleanup claimed unknown artifacts` error instead of naming the action that actually wrote the row.

### Cleanup

Cleanup capability comes first. `synthetic_cleanup_v1` is checked in stage 1, before the first product write, and every mutating call is refused while it is unavailable. If the control plane cannot remove synthetic artifacts, the run creates nothing at all: no synthetic sources, no board jobs, no draft invoice and no email. The whole voyage reports NOT BUILT YET instead of stranding artifacts it has no way to clear.

Cleanup then runs in a final stage even after an earlier failure. It compares the server plan with the local creation ledger, executes marker-scoped cleanup, then independently reads back:

- zero surviving artifacts
- zero marked board rows
- every test invoice in `VOIDED`
- every other registered artifact in `REMOVED`

Any omitted ID, unknown cleanup ID, live synthetic job, non-void test invoice, retained synthetic inbox message or board survivor fails the whole run.

## Proof control contract

The configured control URL accepts POST JSON with:

```json
{
  "action": "proof_capabilities",
  "proofRun": {
    "runId": "...",
    "marker": "SWG-SES-E2E-TEST-ONLY-...",
    "seed": "captain-watch-v1",
    "allowedRecipient": "marninms98@gmail.com",
    "accountingMode": "DRAFT_ONLY"
  },
  "payload": {}
}
```

It must expose these capabilities and actions:

| Capability | Required actions | Purpose |
|---|---|---|
| `synthetic_intake_v1` | `proof_synthetic_intake` | Accept the five synthetic EML/PDF fixtures and return authoritative arrival and Hugo-visible timestamps plus all five fates. |
| `makesafe_board_proof_v1` | `proof_read_board`, `proof_advance_board` | Read `makesafe_board`, prove Hugo visibility and read back stage transitions. |
| `ses_pack_v3` | `proof_build_pack` | Produce one complete family pack and refuse one incomplete pack with exact missing items. |
| `ses_draft_invoice_revision_v1` | `proof_plan_draft_invoice`, `proof_create_draft_invoice`, `proof_create_internal_approval`, `proof_revise_report` | Create only a marked DRAFT invoice and prove material report revision invalidates internal approval. |
| `ses_captain_delivery_v1` | `proof_plan_send`, `proof_execute_send`, `proof_verify_delivery` | Deliver Shaun safe-today and Marnin run-with-care evidence only to the Captain inbox. `proof_execute_send` returns `executedRoute`, `proof_verify_delivery` returns `observedRecipients`, and both carry explicit `to`, `cc` and `bcc`. The read-back proves the exact message marker plus `approved_pack` and `draft_invoice` attachments. |
| `synthetic_cleanup_v1` | `proof_plan_cleanup`, `proof_execute_cleanup`, `proof_verify_cleanup` | Remove all synthetic artifacts, void draft invoices and prove the board is clean. |

A response may include HTTPS `evidenceUrls`. Playwright visits and captures those product surfaces in addition to the stage cockpit. Credential-like URL query parameters are refused.

The endpoint must treat the marker, recipient and DRAFT status as server-side policy too. Harness checks are defence in depth, not permission to place these controls only in the browser worker.

## Pass law

A live run passes only when all seven stages are `PASS`. NOT BUILT YET, a safety refusal, a missing credential, a missing evidence timestamp, a stage mismatch, a failed inbox read or incomplete cleanup makes the command exit non-zero after writing the summary.

Board truth needs the full `New / Unallocated` through `Archive` sequence. When a later leg is unavailable, the transitions it owns are never observed, so Board truth reports NOT BUILT YET naming the exact missing transitions rather than claiming a pass it cannot show or a failure it did not cause. Each unavailable later stage separately reports what is missing, in the console and in the summary page, and the stage screenshot is recaptured after the final verdict so the image and the chip agree.

The fixture command can never produce a live PASS verdict.
