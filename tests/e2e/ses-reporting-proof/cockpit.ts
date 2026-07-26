import type { RunSummary, StageCopy, StageResult } from './types'

export const STAGE_COPY: StageCopy[] = [
  {
    title: 'Intake',
    whatWeDid: 'We introduced five marked synthetic builder messages, each with a deterministic PDF, and followed every source to its declared fate.',
    correctMeans: 'Five sources in, five accounted outcomes out: one live job, one visible blocked job, one reason-coded exception, one revision on the existing lineage, and one accounted non-work item.',
    whatYouSee: 'The fate ledger shows the source identity, resulting card or case, reason code and Hugo visibility for every message.',
    howWeKnow: 'The source IDs are unique, the outcome set is exact, revision count is two, and the accounted total remains five.',
  },
  {
    title: 'Latency',
    whatWeDid: 'We measured from the transport-recorded arrival timestamp to the first Hugo-visible timestamp. No internal processing midpoint is used.',
    correctMeans: 'Every eligible instruction is visible within 300 seconds. One unexplained result above 300 seconds fails the stage.',
    whatYouSee: 'The maximum and P95 elapsed time, plus the law line at five minutes.',
    howWeKnow: 'Both timestamps come back from the proof control plane and the harness rejects missing, reversed or over-limit intervals.',
  },
  {
    title: 'Board truth',
    whatWeDid: 'We read the canonical make-safe board, checked stage, blocker and person, then moved the clean job through the operating stages.',
    correctMeans: 'The card is visible to Hugo, the blocked card names its blocker, the exception keeps its reason, and one lineage reaches each required stage without disappearing.',
    whatYouSee: 'The observed stage sequence and the people or blockers responsible at each stop.',
    howWeKnow: 'Each transition is read back from the canonical board source, not inferred from a client-side status.',
  },
  {
    title: 'Pack',
    whatWeDid: 'We requested a family-correct document pack for one complete job and deliberately withheld required evidence from a second job.',
    correctMeans: 'The complete job produces its pack. The incomplete job produces nothing and names every missing item precisely.',
    whatYouSee: 'The produced artifact list beside the refusal reason and missing evidence list.',
    howWeKnow: 'The ready result has a persistent pack identity. The blocked result has no pack identity and returns a typed reason code.',
  },
  {
    title: 'Money',
    whatWeDid: 'We planned and created one marked draft invoice, approved the exact docket revision internally, changed the report, proved that approval expired, then approved the new revision.',
    correctMeans: 'The accounting object remains DRAFT throughout. A material report change invalidates the old internal release approval and the new revision requires a fresh approval.',
    whatYouSee: 'Draft status, confirmed-rate line count, old and new revision numbers, and the invalidation result.',
    howWeKnow: 'The harness checks DRAFT before creation and after every money response. Any other accounting status stops the run before the next effect.',
  },
  {
    title: 'Send',
    whatWeDid: 'We preflighted and delivered one Shaun safe-today release and one Marnin run-with-care release, both carrying the approved pack and draft invoice.',
    correctMeans: 'Exactly two messages arrive in the Captain inbox. To is marninms98@gmail.com. Cc and Bcc are empty. No other address is accepted.',
    whatYouSee: 'The two operator bands, recipient envelope, message identity and delivery verification.',
    howWeKnow: 'The route is inspected before transport. A second inbox read proves the exact message identity and marker arrived.',
  },
  {
    title: 'Cleanup',
    whatWeDid: 'We reconciled the creation ledger, removed every synthetic source, case, job, document, approval and message, voided every test invoice, then read the board again.',
    correctMeans: 'Created and cleaned totals match, invoice final state is VOIDED, survivor count is zero, and the board contains zero rows with the marker.',
    whatYouSee: 'The created-versus-cleaned ledger, void count, survivor count and final board count.',
    howWeKnow: 'Cleanup is checked against the harness registry by artifact ID. Missing, unknown or surviving artifacts fail the entire run.',
  },
]

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function statusClass(status: StageResult['status']): string {
  if (status === 'PASS') return 'pass'
  if (status === 'SIMULATED') return 'simulated'
  if (status === 'NOT BUILT YET') return 'not-built'
  if (status === 'FAIL') return 'fail'
  if (status === 'RUNNING') return 'running'
  return 'pending'
}

function visibleStatus(status: StageResult['status']): string {
  return status === 'SIMULATED' ? 'SIMULATED, NOT PROOF' : status
}

const CSS = `
:root {
  --blue-950: #1A272E;
  --blue-800: #293C46;
  --blue-600: #4C6A7C;
  --blue-200: #D4DEE4;
  --blue-100: #EDF1F4;
  --orange-700: #F15A29;
  --orange-100: #FDF2EE;
  --warm-50: #FCFBFA;
  --warm-100: #F8F6F3;
  --green: #13795B;
  --red: #A53324;
  --amber: #8B5A00;
}
* { box-sizing: border-box; }
html { background: var(--blue-950); }
body { margin: 0; color: var(--blue-800); background: var(--warm-50); font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; }
body::before { content: ""; position: fixed; inset: 0; pointer-events: none; opacity: 0.03; mix-blend-mode: multiply; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.7'/%3E%3C/svg%3E"); }
.shell { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
.topbar { min-height: 150px; background: linear-gradient(135deg, var(--blue-950), var(--blue-800)); color: white; padding: 28px 44px 24px; display: grid; grid-template-areas: "eyebrow verdict" "title verdict" "meta verdict"; grid-template-columns: minmax(0, 1fr) 300px; column-gap: 64px; border-bottom: 5px solid var(--orange-700); }
.eyebrow { grid-area: eyebrow; color: rgba(255,255,255,.55); text-transform: uppercase; letter-spacing: .2em; font-size: 11px; font-weight: 800; }
h1 { grid-area: title; margin: 4px 0; font-size: 42px; line-height: .98; letter-spacing: -.04em; }
.meta { grid-area: meta; color: rgba(255,255,255,.85); font-size: 12px; }
.verdict { grid-area: verdict; align-self: stretch; border-left: 1px solid rgba(255,255,255,.25); padding-left: 28px; display: grid; align-content: center; }
.verdict strong { font-size: 22px; line-height: 1.05; }
.verdict span { color: rgba(255,255,255,.55); text-transform: uppercase; letter-spacing: .15em; font-size: 10px; margin-bottom: 7px; }
.workspace { display: grid; grid-template-areas: "rail main ledger"; grid-template-columns: 250px minmax(0, 1fr) 300px; min-height: 800px; }
.rail { grid-area: rail; padding: 30px 20px 36px 32px; background: var(--blue-100); border-right: 1px solid var(--blue-200); }
.rail-item { display: grid; grid-template-columns: 28px 1fr; gap: 10px; padding: 13px 0; border-bottom: 1px solid var(--blue-200); }
.rail-item.focus { border-bottom-color: var(--orange-700); }
.rail-no { font-size: 26px; font-weight: 900; line-height: 1; color: var(--blue-600); }
.rail-title { font-size: 13px; font-weight: 800; }
.chip { display: inline-block; margin-top: 6px; padding: 4px 7px; border-radius: 100px; font-size: 9px; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; background: var(--blue-200); }
.chip.pass { color: var(--green); background: #E2F4EE; }
.chip.fail { color: var(--red); background: #F9E5E1; }
.chip.running { color: var(--blue-950); background: #FADDD2; }
.chip.not-built { color: var(--amber); background: #FFF0CF; }
.chip.simulated { color: var(--blue-600); background: white; border: 1px solid var(--blue-200); }
.main { grid-area: main; padding: 42px 46px 56px; }
.stage-kicker { text-transform: uppercase; letter-spacing: .18em; font-size: 10px; font-weight: 900; color: var(--orange-700); }
h2 { margin: 8px 0 24px; font-size: 56px; line-height: .92; letter-spacing: -.055em; color: var(--blue-950); }
.detail { border-left: 5px solid var(--orange-700); padding: 17px 20px; background: var(--orange-100); font-size: 16px; line-height: 1.45; margin-bottom: 30px; }
.questions { display: grid; grid-template-areas: "did correct" "see know"; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--blue-200); border: 1px solid var(--blue-200); }
.question { background: var(--warm-50); padding: 20px; min-height: 132px; }
.question label { display: block; color: var(--blue-600); text-transform: uppercase; letter-spacing: .14em; font-size: 9px; font-weight: 900; margin-bottom: 9px; }
.question p { margin: 0; font-size: 13px; line-height: 1.5; }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-top: 26px; border-top: 1px solid var(--blue-200); border-bottom: 1px solid var(--blue-200); }
.metric { padding: 20px 18px 18px 0; }
.metric strong { display: block; font-size: 28px; line-height: 1; color: var(--blue-950); }
.metric span { display: block; margin-top: 7px; text-transform: uppercase; letter-spacing: .12em; font-size: 9px; font-weight: 800; color: var(--blue-600); }
.metric small { display: block; margin-top: 5px; color: var(--blue-600); }
.ledger { grid-area: ledger; padding: 34px 30px; color: white; background: var(--blue-950); }
.ledger h3 { margin: 0 0 22px; text-transform: uppercase; letter-spacing: .15em; font-size: 11px; }
.ledger-row { padding: 13px 0; border-bottom: 1px solid rgba(255,255,255,.08); }
.ledger-row label { display: block; color: rgba(255,255,255,.55); text-transform: uppercase; letter-spacing: .12em; font-size: 9px; }
.ledger-row strong { display: block; margin-top: 6px; font-size: 13px; overflow-wrap: anywhere; }
.summary-page { background: var(--warm-50); }
.summary-hero { padding: 65px max(6vw, 40px); background: linear-gradient(135deg, var(--blue-950), var(--blue-800)); color: white; border-bottom: 7px solid var(--orange-700); display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(280px, .6fr); gap: 70px; }
.summary-hero h1 { font-size: clamp(48px, 7vw, 92px); margin: 12px 0 22px; }
.summary-hero p { max-width: 760px; font-size: 17px; line-height: 1.5; color: rgba(255,255,255,.85); }
.summary-verdict { align-self: end; border-left: 1px solid rgba(255,255,255,.25); padding-left: 30px; }
.summary-verdict .big { font-size: 36px; font-weight: 900; line-height: 1; }
.safety-bar { display: grid; grid-template-columns: repeat(4, 1fr); background: var(--blue-100); border-bottom: 1px solid var(--blue-200); padding: 0 max(6vw, 40px); }
.safety-item { padding: 22px 20px 22px 0; }
.safety-item label { display: block; text-transform: uppercase; letter-spacing: .12em; font-size: 9px; font-weight: 900; color: var(--blue-600); }
.safety-item strong { display: block; margin-top: 6px; font-size: 14px; overflow-wrap: anywhere; }
.stage-section { padding: 70px max(6vw, 40px); display: grid; grid-template-areas: "number head" "number content" "number evidence"; grid-template-columns: 150px minmax(0, 1fr); border-bottom: 1px solid var(--blue-200); }
.stage-section:nth-child(even) { background: var(--warm-100); }
.stage-number { grid-area: number; font-size: 110px; font-weight: 900; line-height: .8; color: var(--blue-200); }
.stage-head { grid-area: head; display: flex; align-items: end; justify-content: space-between; gap: 30px; }
.stage-head h2 { font-size: 54px; margin: 0 0 26px; }
.stage-content { grid-area: content; }
.stage-evidence { grid-area: evidence; margin-top: 30px; }
.evidence-image { width: 100%; border: 1px solid var(--blue-200); box-shadow: 0 4px 12px rgba(41,60,70,.10); }
.footer { padding: 40px max(6vw, 40px); background: var(--blue-950); color: rgba(255,255,255,.85); }
.footer a { color: white; }
@media (max-width: 1000px) { .workspace { grid-template-areas: "rail" "main" "ledger"; grid-template-columns: 1fr; } .rail { display: grid; grid-template-columns: repeat(4,1fr); } .topbar { grid-template-columns: 1fr; grid-template-areas: "eyebrow" "title" "meta" "verdict"; } .verdict { border-left: 0; padding: 18px 0 0; } }
`

function metricHtml(stage: StageResult): string {
  if (stage.metrics.length === 0) return '<div class="metric"><strong>Waiting</strong><span>No measured result yet</span></div>'
  return stage.metrics.map((metric) => `<div class="metric"><strong>${escapeHtml(metric.value)}</strong><span>${escapeHtml(metric.label)}</span>${metric.threshold ? `<small>${escapeHtml(metric.threshold)}</small>` : ''}</div>`).join('')
}

function questionHtml(copy: StageCopy): string {
  return `<div class="questions">
    <div class="question"><label>What we did</label><p>${escapeHtml(copy.whatWeDid)}</p></div>
    <div class="question"><label>What correct means</label><p>${escapeHtml(copy.correctMeans)}</p></div>
    <div class="question"><label>What you are looking at</label><p>${escapeHtml(copy.whatYouSee)}</p></div>
    <div class="question"><label>How we know it is good</label><p>${escapeHtml(copy.howWeKnow)}</p></div>
  </div>`
}

export function renderCockpit(summary: RunSummary, focusNumber: number): string {
  const focus = summary.stages.find((stage) => stage.number === focusNumber) || summary.stages[0]
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SES proof ${escapeHtml(summary.runId)}</title><style>${CSS}</style></head>
  <body><div class="shell">
    <header class="topbar"><div class="eyebrow">SecureWorks Group / SES Reporting / Whole-flow proof</div><h1>Captain watch surface</h1><div class="meta">Run ${escapeHtml(summary.runId)} · Marker ${escapeHtml(summary.marker)}</div><div class="verdict"><span>Current truth</span><strong>${escapeHtml(summary.overall)}</strong></div></header>
    <div class="workspace">
      <nav class="rail">${summary.stages.map((stage) => `<div class="rail-item ${stage.number === focus.number ? 'focus' : ''}"><div class="rail-no">${stage.number}</div><div><div class="rail-title">${escapeHtml(stage.copy.title)}</div><span class="chip ${statusClass(stage.status)}">${escapeHtml(visibleStatus(stage.status))}</span></div></div>`).join('')}</nav>
      <main class="main"><div class="stage-kicker">Stage ${focus.number} of 7</div><h2>${escapeHtml(focus.copy.title)}</h2><div class="detail">${escapeHtml(focus.detail || 'This stage has not run yet.')}</div>${questionHtml(focus.copy)}<div class="metrics">${metricHtml(focus)}</div></main>
      <aside class="ledger"><h3>Non-negotiable controls</h3><div class="ledger-row"><label>Allowed recipient</label><strong>${escapeHtml(summary.captainRecipient)}</strong></div><div class="ledger-row"><label>Accounting</label><strong>DRAFT only, then VOIDED</strong></div><div class="ledger-row"><label>Run mode</label><strong>${escapeHtml(summary.mode === 'fixture' ? 'Fixture self-test, not proof' : 'Live synthetic proof')}</strong></div><div class="ledger-row"><label>Created</label><strong>${summary.artifacts.created.length} registered artifacts</strong></div><div class="ledger-row"><label>Cleaned</label><strong>${summary.artifacts.cleaned.length} reconciled artifacts</strong></div><div class="ledger-row"><label>Survivors</label><strong>${summary.artifacts.survivors.length}</strong></div></aside>
    </div>
  </div></body></html>`
}

export function renderFinalSummary(summary: RunSummary): string {
  const stageSections = summary.stages.map((stage) => {
    const image = stage.screenshot ? `<div class="stage-evidence"><img class="evidence-image" src="${escapeHtml(stage.screenshot)}" alt="Stage ${stage.number} ${escapeHtml(stage.copy.title)} evidence screenshot"></div>` : ''
    return `<section class="stage-section"><div class="stage-number">${stage.number}</div><div class="stage-head"><h2>${escapeHtml(stage.copy.title)}</h2><span class="chip ${statusClass(stage.status)}">${escapeHtml(visibleStatus(stage.status))}</span></div><div class="stage-content"><div class="detail">${escapeHtml(stage.detail)}</div>${questionHtml(stage.copy)}<div class="metrics">${metricHtml(stage)}</div>${stage.error ? `<div class="detail">Failure: ${escapeHtml(stage.error)}</div>` : ''}</div>${image}</section>`
  }).join('')

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SES Reporting proof summary ${escapeHtml(summary.runId)}</title><style>${CSS}</style></head><body class="summary-page">
  <header class="summary-hero"><div><div class="eyebrow">SecureWorks Group / Captain acceptance artifact</div><h1>SES Reporting<br>whole-flow proof</h1><p>We followed one marked synthetic voyage from builder email and PDF through Hugo, the board, pack, draft money, approval invalidation, delivery and cleanup. This page tells the truth stage by stage. A missing product leg is shown as NOT BUILT YET, never as a pass.</p></div><div class="summary-verdict"><div class="eyebrow">Final verdict</div><div class="big">${escapeHtml(summary.overall)}</div><p>${escapeHtml(summary.overallDetail)}</p></div></header>
  <div class="safety-bar"><div class="safety-item"><label>Recipient lock</label><strong>${escapeHtml(summary.captainRecipient)} only</strong></div><div class="safety-item"><label>Accounting lock</label><strong>DRAFT only, then VOIDED</strong></div><div class="safety-item"><label>Marker</label><strong>${escapeHtml(summary.marker)}</strong></div><div class="safety-item"><label>Cleanup</label><strong>${summary.artifacts.survivors.length} survivors</strong></div></div>
  ${stageSections}
  <footer class="footer"><strong>Evidence bundle</strong><p>Run JSON: <a href="run-summary.json">run-summary.json</a> · Video: <a href="video/whole-flow.webm">video/whole-flow.webm</a> · Playwright trace: <a href="trace/whole-flow.zip">trace/whole-flow.zip</a></p><p>Run ${escapeHtml(summary.runId)} · Started ${escapeHtml(summary.startedAt)} · Finished ${escapeHtml(summary.finishedAt)}</p></footer>
  </body></html>`
}
