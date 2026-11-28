# Work order room v1: bill up to what is left

Owner's ruling, 28 Nov 2026, in his words: "it should still be limited by the
at most the amount that the work order allows ... and if other trades also
take that money somehow ... come up with a creative solution of like how it
all works with the group work orders and all that."

This replaces the 12 Nov 2026 rule that a work order is billed at exactly its
agreed amount, once. Restoration work orders keep the exact rule (a setting,
below).

## The rule

A work order is one pot of money. Everything that pays a trade on the job
draws on the same pot, whoever draws it and however.

- **What the work order allows** (`allowed_ex`): its agreed labour, plus the
  trade allocation of every approved customer variation on it, plus every
  office amount change on it (which also carries every approved additional
  work order on the job). This is the figure the cap already refused by
  (`readWorkOrderCapFacts`, `work_order_total_cap.ts`).
- **What is drawn** (`billed_ex`): every line on the job on a live invoice
  (`JOB_WORK_ORDER_BILLED_INVOICE_STATUSES`; a draft, a rejected or a voided
  invoice holds nothing), by anyone: work order bills, hours, travel, group
  shares, deductions. Commission and reimbursements are not drawn on it. With
  `trade_line_hold_v1` on, the database's own sum (`work_order_backed_billed`)
  is used, so a held line waits with the office and draws nothing.
- **What is left** (`left_ex`): allowed less drawn.
- **The most this trade may bill now** (`most_now_ex`): what is left, never
  below $0. On a job with a work order named for another trade, no more than
  this trade's own room (`ownWorkOrderRoomEx`), so nobody bills into another
  trade's named work order. The named orders are read from the job's own
  approved additional work orders every time, never from the trade's own
  options (a trade offered only the main order still cannot bill into
  another trade's named one).

On a work order billed this way (`work_order_amount_rule: "up_to_left"`) the
trade types what they bill this time. The work order line's amount
(`wo_allocated`: this bill's part of the work order, the crew it names
included) must be more than $0.00 and at most `most_now_ex`. A work order may
be billed in as many bills as it takes (progress billing), each within what
is left. One work order line per job on one invoice.

The amount checked is the larger of the line's work order amount
(`wo_allocated`) and what the line itself bills (quantity times rate), so a
line typed "Work Order" with no work order amount is held by what it bills.

Nothing new is counted: the per-line check reads the cap's own figures
(`readWorkOrderBilledViews`), and the job-level cap
(`_assertWithinWorkOrderTotal`) still holds the invoice's whole total on the
job (hours and travel included) to what is left.

### Refusals (409, nothing saved)

| Code | When | Words |
| --- | --- | --- |
| `work_order_amount_over_left` | more than is left | `Job SWF-1: up to $1,800.00 is left on its work order. Bill at most that this time, or ask the office.` |
| `work_order_amount_over_left` | nothing is left | `Job SWF-1: its work order has been billed in full. Ask the office if it needs changing.` |
| `work_order_amount_required` | nothing typed, $0 or less | `Job SWF-1: type the amount you are billing on its work order this time. It must be more than $0.00 and at most $1,800.00.` |
| `work_order_line_twice` | two work order lines on one job | `Job SWF-1: put its work order on one line on this invoice.` |
| `work_order_amount_not_agreed` | restoration, not the agreed amount | unchanged |

Each refused job in `jobs` carries `code` and `most_now_ex`. What is left that
cannot be read answers 503 `work_order_cap_unavailable`, never a guess.

### What the apps read

Added fields only; nothing renamed.

- `work_order_amount_rule` (`"up_to_left"` or `"agreed"`) on each job of
  `trade_invoice_job_modes` and each `my_hours` card, beside
  `work_order_agreed_ex`. Absent when there is no agreed amount.
- `work_order_billed` (from 23 Nov: `allowed_ex`, `billed_ex`, `left_ex`,
  `billed_by`) now also carries `most_now_ex` and `amount_rule`. `billed_ex`
  and `left_ex` are the cap's own count, the same count as `most_now_ex`
  (the database sum with `trade_line_hold_v1` on). `billed_by` stays per
  trade; with held lines on it can add up to more than `billed_ex`, because
  a held line is listed but not counted.
- `work_order_billed_unavailable: true` when that read failed, on a job
  billed up to what is left. The field `work_order_billed` is then absent.
  The apps say what is left could not be read and send nothing for that job;
  they never fall back to the locked agreed amount.

An app that sees no `work_order_amount_rule` keeps the agreed amount locked,
so a front end deployed before the back end, or the other way round, never
offers an amount the server would refuse.

### Held lines

With `trade_line_hold_v1` on and the hold mode in force, the server accepts a
line over what is left and holds the extra for the office: the per-line check
and the job cap do not run in that mode (`index.ts`, inside `!lineHoldMode`).
So there the apps alone refuse anything over `most_now_ex` before sending; a
call straight to the API is held for the office, not refused. The apps' refusal
matches the owner's ruling (at most what the work order allows). If the server
itself should refuse in that mode too, the check has to move out of the
`!lineHoldMode` branch: a separate change.

## Groups: the same pot

The group work order's pot is the job work order's money (group_work_order.ts).
Three rules that already stand make the two ways of drawing it unable to go
over the work order together:

1. **They never run side by side.** The database refuses a work order or hours
   claim on a job with a group that is not void
   (`work_order_claim_blocked_by_group_share`), and refuses opening a group
   while a live work order claim is on the job
   (`group_open_blocked_by_work_order_claim`, 22 Oct 2026).
2. **Hours paid before a group opens come off its pot** (6 Nov 2026,
   `group_work_order_hours_paid_total`); that person is left out of the split.
3. **Shares are drawn lines.** A billed share is a line on the job, so it
   counts in what is drawn. If a group is voided, or later money lands on the
   work order, an individual bill sees only what the shares left.

So whichever draws first takes the money first, and the other sees only what
is left. The screens for a work order show who has drawn what and what is
left (`billed_by`, `most_now_ex`). The group screens keep the 21 Oct privacy
rule (the pot and your own share only); see the owner questions.

A variation raise after a group's split is frozen is left on the work order:
nobody can bill it while the group is live (rule 1). The office either
unfreezes and splits again (before freezing, the pot follows the work order's
amount changes) or voids the group, after which it is ordinary room on the
work order.

## Worked examples (each is a test)

All figures ex GST and made up.

1. **One trade alone, two progress bills.** Work order 1,850.50. First bill
   1,000: saved. Left 850.50. Second bill 850.50: saved. 850.51 instead:
   refused, "up to $850.50 is left". After both, any amount: refused, billed
   in full. (`trade_invoice_agreed_work_order_test.ts`,
   `work_order_total_cap_test.ts` "room: one trade, two progress bills")
2. **Lead plus helper.** Work order 1,850.50. The helper billed 400 of hours
   on their own invoice. The lead may bill up to 1,450.50; 1,850.50 is refused
   naming $1,450.50. If the helper has not billed yet, the lead may bill
   1,850.50 and list the helper as crew (280), sending 1,570.50 for
   themselves; the helper's 280 then fits in what is left.
   (`trade_invoice_agreed_work_order_test.ts`)
3. **A group of three with shares.** Work order 2,000. Shares of 600, 500 and
   400 billed: 1,500 drawn, 500 left, each person shown by name. An individual
   bill of 500.01 on the job is refused by the cap with the most of 500.
   (`work_order_total_cap_test.ts` "room: group shares draw on the same pot")
4. **A group plus a variation raise.** Work order 2,000, shares 1,000 and
   1,000 billed. An approved customer variation gives the trades 300: allowed
   2,300, left 300. An office amount change of 150 instead: left 150.
   (`work_order_total_cap_test.ts` "room: a variation raise")
5. **A work order named for another trade.** Main 2,000 plus 500 named for
   trade B. Trade A may bill up to 2,000; trade B up to 2,500.
   (`work_order_total_cap_test.ts` "room: a work order named for another trade")

## Settings (marked defaults)

- `RESTORATION_WORK_ORDER_BILLED_EXACTLY = true` (`trade_invoice_mode.ts`):
  a restoration work order is still billed at exactly its agreed labour.
  Default true, owner to confirm. Set to false, restoration jobs answer
  `work_order_amount_rule: "up_to_left"`, get their `work_order_billed`
  view and are checked the same way (tested both ways).
- One work order line per job on one invoice: kept from 12 Nov.
- A group cannot open on a job that already has a live work order bill (the
  22 Oct database rule): kept. See question 2.

## Owner questions

1. Restoration work orders: bill up to what is left too, or keep the exact
   agreed amount? (default: exact)
2. A trade progress-bills part of a work order, then the office wants a group
   for the rest. Today the group cannot open until the office settles the
   claim. Should the group open on what is left, with the earlier biller left
   out of the split (as paid hours are), or keep the office step? (default:
   office step)
3. Group screens show the pot and your own share only (21 Oct). Should group
   members also see what is left on the work order and who drew it, as the
   work order screens now do? (default: no change)

## Known limits

- The read and the save are not one transaction. Two trades sending at the
  same moment can both pass the per-line check; with `trade_line_hold_v1` on
  the database guard holds the job's total.
- `wo_allocated` counts the crew the line names. A crew member who already
  billed and is also listed on the line is counted twice, so the line can
  under-bill, never over-bill; the screens say to list only crew who have not
  billed yet.
