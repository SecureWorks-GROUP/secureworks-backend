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
| `job.scope_json` | Narrative, run/material names, quantities, `notes.noteQuote`, labour `trades` / `days` / `labourers`. Inside `job.quote` / `quotes`: only the allowlist (`quote_number`, description/narrative/notes, name/label, qty/quantity, unit, materials/items/lines/kind). | Outer-blob money via the denylist (`unit_price`, `rate`, `total`, `dayRate`, `sell`, `_pricing_json`, `pricePerMetre`, `job_costs`, …). A numeric `quote` / `quotes` value is dropped. Nested quote objects are **allowlist-only** — unknown keys (`lineTotalEx`, `gstAmount`, `quotedTotal`, …) are dropped, never fail-open. |
| `quote_packs[]` | `quote_number`, `job_document_id`, status, descriptions, quantities, summary; items keep `kind` / `description` / `quantity` / `unit` | Pack reconstruction is allowlist-only. `items[].unit_price` and `items[].line_total` are `null`. Unknown money keys do not ride the spread. |
| `workOrder` / `workOrders[].scope_items` | Allowlist only: description, quantity/qty, unit, instructions/notes, name/label, kind. Scalars only. | Unknown keys (`unitPriceEx`, `lineTotalEx`, `gstAmount`, `quotedTotal`, `cost`, nested `pricing`/`amount`, …) are dropped, never copied. |
| `documents` | `visible_to_trades` rows except `quote` / `invoice` PDFs; `quote_number` on remaining rows | Quote and client-invoice files |

Do not render a price column from a leftover key. A new scoping-tool money key
on the **outer** blob still belongs on `TRADE_SCOPE_QUOTE_KEYS` /
`TRADE_SCOPE_MONEY_KEYS` (re-check the LOOP2 scope audit). A new key **inside**
`quote` / `quotes` is dropped unless it is added to
`TRADE_SCOPE_QUOTE_OBJECT_ALLOWLIST`.

## Videos

`media` and `currentCycleMedia` are the **same** list:

- current-cycle photos and other current-cycle rows
- **every** `type: 'video'` row on the job (walkthroughs + other videos), even
  when the make-safe reattend filter would drop an unbound / prior-cycle
  walkthrough

The paged `job_media` read (200 rows) is photos/other only. Every
`type: 'video'` row is fetched on a separate uncapped lane and merged into
`media` / `currentCycleMedia` so a photo-heavy job cannot hide the walkthrough.

Scope walkthroughs that live only in `scope_json` (`scopeMedia` or
`job.scopeMedia`: `video`, `videoWalkthrough`, URL aliases) are registered on
this read into `job_media` as `type: 'video', phase: 'scope', label:
'Walkthrough'` when a public **https** URL already exists. `http://` and
`data:video` candidates are ignored — this read does not upload video bytes or
invent a playback URL. Block-level `videoUrl` / `videoWalkthroughUrl` aliases
still run when the primary fields produced no playable https URL (an invalid
candidate must not suppress them) and dedupe only against an existing playable
URL. Idempotent. Filename/size-only metadata does **not** become a dead player
row. `data:image` photo upload-on-read (digest identity) stays intentional.

Play from `storage_url`. Do not invent signed URLs when a public URL already
works. `.mov` → `mp4` transcoding is out of scope (Safari/iOS may not play
`.mov`).

`currentCyclePhotoCount` stays photo-only (completion floor). It does not count
recovered videos.
