# TRD-4 trade quote + video contract (2026-09-06)

API contract for `ops-api?action=trade_job_detail`. UX tab layout is TRD-5 and
must consume this payload — do not re-derive prices or invent a second media
list in the client.

Office and division manager (`quote_visible: true`) are unchanged: full quote
including money, full document set, installer rates on `quote_packs`.

Allocated trade and `makesafe_open` (`quote_visible: false`):

## Quote writing stays; money does not

| Surface | Kept | Stripped |
|---|---|---|
| `job.scope_json` | Narrative, run/material names, quantities, `job.quote` / `quotes` objects, `notes.noteQuote`, quote numbers, labour `trades` / `days` / `labourers` | Every money key (`unit_price`, `rate`, `total`, `dayRate`, `sell`, `_pricing_json`, `pricePerMetre`, `job_costs`, …). A numeric `quote` / `quotes` value is dropped; an object is walked. |
| `quote_packs[]` | `quote_number`, `job_document_id`, status, descriptions, quantities, summary | `items[].unit_price` and `items[].line_total` are `null` |
| `workOrder` / `workOrders[].scope_items` | description, quantity, unit, instructions | `rate`, `total`, `unit_price`, `price`, `amount`, `gst` |
| `documents` | `visible_to_trades` rows except `quote` / `invoice` PDFs; `quote_number` on remaining rows | Quote and client-invoice files |

Do not render a price column from a leftover key. If a new scoping-tool money
key appears, add it to `TRADE_SCOPE_QUOTE_KEYS` or `TRADE_SCOPE_MONEY_KEYS` in
`ops-api/index.ts` and re-check the LOOP2 scope audit.

## Videos

`media` and `currentCycleMedia` are the **same** list:

- current-cycle photos and other current-cycle rows
- **every** `type: 'video'` row on the job (walkthroughs + other videos), even
  when the make-safe reattend filter would drop an unbound / prior-cycle
  walkthrough

Scope walkthroughs that live only in `scope_json` (`scopeMedia` or
`job.scopeMedia`: `video`, `videoWalkthrough`, URL aliases) are registered on
this read into `job_media` as `type: 'video', phase: 'scope', label:
'Walkthrough'` when a public `https` URL exists. Idempotent. Filename/size-only
metadata does **not** become a dead player row.

Play from `storage_url`. Do not invent signed URLs when a public URL already
works. `.mov` → `mp4` transcoding is out of scope (Safari/iOS may not play
`.mov`).

`currentCyclePhotoCount` stays photo-only (completion floor). It does not count
recovered videos.
