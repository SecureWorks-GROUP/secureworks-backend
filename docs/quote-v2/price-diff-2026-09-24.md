# Price book import: diff report (quote v2, stage 1)

Generated 2026-09-24 by `scripts/quote-v2/price_book_import.ts` (quote-v2-price-book-import/v1), dry run.
Sources read at: fence-designer `1e25f0b`, patio-tool `884a208`, secureworks-wiki `79ad2247`, secureworks-backend `1c6690d7`.

All loaded rows are **cost to us, ex GST, provisional**. Sell rates are listed separately and never loaded as costs; no cost is back-computed from a sell rate.

## Counts

| Measure | Count |
|---|---:|
| Price book items | 178 |
| Items with prices from more than one store | 75 |
| Items where a tool constant can be compared with invoice or supplier evidence | 21 |
| ...of those, tool differs from latest evidence by more than 5% | 11 |
| Items priced only by a tool constant (no invoice evidence) | 71 |
| Items priced only by invoice or supplier evidence | 59 |
| Items with no cost at all (read as unpriced) | 25 |
| $0 sentinel values found (never loaded) | 70 |
| Legacy sell rates (reported, not loaded) | 49 |
| Rows excluded (dead store, compound line, one-off, not a price) | 41 |
| Cost rows to load | 319 |
| Stock length rows to load | 22 |
| Cut rule rows to load | 24 |
| Allowance rows to load | 11 |
| Values a tool comment calls blessed (loaded provisional) | 7 |

## Stores not observed

- 6 patio per-device cache: lives in each iPad's browser storage; no server copy exists.
- 8 scope_tool_defaults (live table): current rows need a production read; only the repo seed and the fence parity seed (store 4) were read.
- 9 material_price_ledger (live): needs a production read; pass an operator export with --ledger-json.

## Tool constant vs wiki CSV vs latest invoice evidence

Sorted by the size of the gap. Delta is (tool minus latest evidence) / latest evidence, where tool is the value the live fence or patio tool uses today (store 1 or 5), else the newest seed or engine value. Store numbers: 1 fence COST_PRICES, 4 parity seed, 5 patio tables, 7 patio engine, 8 repo seed.

| Item | Unit | Tool constants | Wiki CSV rows | Latest evidence | Delta |
|---|---|---|---|---|---:|
| `downpipe-95x45` | lm | 4: $22.22<br>5: $22.22<br>7: $22.22 | 3 rows, $8.51 to $9.16 | $9.16 2026-05-22 CMI (Combined Metal Industries) ($16.49 per 1.8 m length = $9.16/LM) | +142.5% |
| `downpipe-clip-95x45` | each | 5: $2.50 | 2 rows, $1.22 to $1.22 | $1.22 2026-05-22 CMI (Combined Metal Industries) | +104.9% |
| `infill-twinwall-10mm-700` | lm | 4: $38.08<br>5: $38.08 | 1 rows, $31.22 to $31.22 | $31.22 2026-06-09 Ampelite | +22% |
| `steel-rhs-100x50x2` | lm | 4: $30.00<br>5: $30.00<br>5: $30.00<br>7: $30.00 | 4 rows, $25.87 to $29.22 | $25.87 2026-03-09 BD Metals ($168.18 per 6.5 m length = $25.87/LM) | +15.9% |
| `steel-rhs-76x38x1.6` | lm | 4: $15.50<br>5: $15.50<br>5: $15.50<br>7: $15.50 | 3 rows, $13.56 to $13.64 | $13.56 2026-03-16 BD Metals ($82.73 per 6.1 m length = $13.56/LM) | +14.3% |
| `steel-shs-90x90x2` | lm | 4: $35.50<br>5: $35.50<br>5: $35.50<br>7: $35.50 | 2 rows, $31.82 to $33.72 | $31.82 2026-03-09 BD Metals ($127.27 per 4.0 m length = $31.82/LM) | +11.6% |
| `steel-rhs-150x50x2` | lm | 4: $39.05<br>5: $39.05<br>5: $39.05<br>7: $39.05 | 1 rows, $35.35 to $35.35 | $35.35 2026-03-09 BD Metals ($127.27 per 3.6 m length = $35.35/LM) | +10.5% |
| `fence-delivery-rr` | delivery | 1: $95.00<br>4: $200.00 | 16 rows, $86.36 to $181.82 | $104.55 2026-06-05 R&R Fencing | -9.1% |
| `concrete-kwikset-20kg` | bag | 1: $8.00<br>4: $10.00<br>4: $9.50<br>5: $8.00<br>7: $10.00 | 2 rows, $7.27 to $7.36 | $7.36 2026-05-04 R&R Fencing | +8.6% |
| `gutter-patio` | lm | 4: $22.00<br>5: $10.00<br>7: $15.00 | 1 rows, $10.94 to $10.94 | $10.94 2026-05-22 CMI (Combined Metal Industries) | -8.6% |
| `fence-panel-kit-h1800-w3150-post3000` | each | 1: $124.00<br>4: $124.00 | 1 rows, $117.27 to $117.27 | $117.27 2026-04-08 R&R Fencing | +5.7% |
| `steel-shs-50x50x1.6` | lm | 5: $14.00<br>5: $14.00 | 1 rows, $13.64 to $13.64 | $13.64 2026-03-13 BD Metals ($40.91 per 3.0 m length = $13.64/LM) | +2.7% |
| `fence-plinth-long-w3150` | each | 1: $48.00 | 10 rows, $48.18 to $48.18 | $48.18 2026-05-05 R&R Fencing | -0.4% |
| `fence-panel-kit-h1800-w2380-post2400` | each | 1: $88.00<br>4: $97.00 | 1 rows, $88.18 to $88.18 | $88.18 2026-05-19 R&R Fencing | -0.2% |
| `fence-plinth-std-w2380` | each | 1: $41.00<br>4: $55.00 | 15 rows, $40.91 to $40.91 | $40.91 2026-06-05 R&R Fencing | +0.2% |
| `fence-post-shs-50x50x1.6-l2400` | each | 1: $39.00 | 1 rows, $39.09 to $39.09 | $39.09 2026-01-09 R&R Fencing | -0.2% |
| `fence-post-shs-50x50x1.6-l2700` | each | 1: $44.50 | 1 rows, $44.55 to $44.55 | $44.55 2026-04-08 R&R Fencing | -0.1% |
| `fence-post-shs-90x90x3.0-l1800` | each | 1: $79.00 | 1 rows, $79.09 to $79.09 | $79.09 2026-02-09 R&R Fencing | -0.1% |
| `downpipe-outlet-95x45` | each | 5: $5.82<br>5: $5.82 | 2 rows, $4.41 to $5.82 | $5.82 2026-05-22 CMI (Combined Metal Industries) | 0% |
| `gutter-clip-universal` | each | 5: $1.58 | 1 rows, $1.58 to $1.58 | $1.58 2026-05-22 CMI (Combined Metal Industries) | 0% |
| `gutter-stop-end-patio` | each | 5: $4.21 | 2 rows, $4.21 to $4.21 | $4.21 2026-05-22 CMI (Combined Metal Industries) | 0% |

## Priced only by a tool constant (no invoice evidence on file)

| Item | Unit | Tool values | Note |
|---|---|---|---|
| `bracket-rafter` | each | 4: $20.00<br>5: $20.00<br>7: $20.00 |  |
| `bracket-tubing` | each | 7: $5.00 |  |
| `fence-gate-kit-double` | each | 1: $500.00<br>4: $500.00 |  |
| `fence-gate-kit-pedestrian` | each | 1: $320.00<br>4: $320.00 |  |
| `fence-gate-labour-double` | each | 1: $500.00<br>4: $500.00 |  |
| `fence-gate-labour-pedestrian` | each | 1: $250.00<br>4: $250.00 |  |
| `fence-gate-post-90x90` | each | 1: $85.00<br>4: $85.00 |  |
| `fence-labour-per-metre` | lm | 1: $35.00<br>4: $35.00 |  |
| `fence-patio-tube-76x38-l3000` | each | 1: $45.00<br>4: $45.00 |  |
| `fence-plinth-install` | each | 1: $10.00<br>4: $10.00 |  |
| `fence-remove-asbestos` | lm | 1: $65.00 |  |
| `fence-remove-asbestos-per-sheet` | sheet | 4: $60.00 |  |
| `fence-remove-colorbond` | lm | 1: $15.00<br>4: $15.00 |  |
| `fence-remove-hardie` | lm | 1: $12.50 |  |
| `fence-remove-hardie-per-sheet` | sheet | 4: $12.50 |  |
| `fence-remove-timber-lap` | lm | 1: $20.00<br>4: $20.00 |  |
| `fence-tek-screws-box` | box | 1: $18.00<br>4: $18.00 |  |
| `fence-veg-clear` | job | 1: $150.00<br>4: $100.00 | tools disagree |
| `fencing-addl-labour-cost` | hour | 4: $45.00 |  |
| `fencing-cb-1800-cost` | lm | 4: $97.00 |  |
| `fencing-cb-2100-cost` | lm | 4: $109.00 |  |
| `fencing-dbl-swing-gate-cost` | each | 4: $1830.00 |  |
| `fencing-ground-mulch` | lm | 1: $12.00 |  |
| `fencing-ground-stones` | lm | 1: $18.00 |  |
| `fencing-ground-turf` | lm | 1: $22.00 |  |
| `fencing-mulch-cost` | m2 | 4: $5.00 |  |
| `fencing-panel-kit-1200-2400` | each | 1: $75.00<br>4: $75.00 |  |
| `fencing-panel-kit-1500-2400` | each | 1: $85.00<br>4: $85.00 |  |
| `fencing-panel-kit-1800-2700` | each | 1: $113.00<br>4: $109.00 | tools disagree; comment says blessed 2026-06-12 |
| `fencing-panel-kit-2100-2700` | each | 1: $99.00<br>4: $109.00 | tools disagree; comment says blessed 2026-06-12 |
| `fencing-panel-kit-2100-3000` | each | 1: $126.50<br>4: $130.00 | tools disagree; comment says blessed 2026-06-12 |
| `fencing-ped-gate-bundled-cost` | each | 4: $835.00 |  |
| `fencing-ped-gate-standalone-cost` | each | 4: $835.00 |  |
| `fencing-remove-asbestos-fee` | job | 4: $300.00 |  |
| `fencing-rock-excavation` | each | 4: $45.00 |  |
| `fencing-solid-fill-150-cost` | lm | 4: $73.00 |  |
| `fencing-turf-prep-cost` | m2 | 4: $7.00 |  |
| `fencing-white-stones-cost` | m2 | 4: $10.00 |  |
| `flashing-back` | lm | 4: $20.00<br>5: $10.50<br>7: $15.00 | tools disagree |
| `flashing-barge` | lm | 4: $20.00<br>5: $10.50<br>7: $15.00 | tools disagree |
| `flashing-gutter` | lm | 4: $20.00<br>5: $10.50<br>7: $20.00 | tools disagree |
| `flashing-hip` | lm | 5: $10.50 |  |
| `flashing-ridge-cap` | lm | 4: $20.00<br>5: $10.50<br>7: $20.00 | tools disagree |
| `gable-truss-average` | each | 5: $627.00 |  |
| `gutter-box` | lm | 4: $30.00<br>5: $30.00<br>7: $30.00 |  |
| `infill-twinwall-10mm-1050` | lm | 4: $43.01<br>5: $43.01 |  |
| `labour-labourer` | hour | 7: $45.00 |  |
| `labour-roof-plumber` | day | 7: $1100.00 |  |
| `labour-trade` | hour | 7: $65.00 |  |
| `patio-delivery` | job | 4: $250.00 |  |
| `patio-skip-bin` | job | 4: $350.00 |  |
| `riser-100x50` | each | 4: $60.00<br>5: $60.00<br>7: $65.00 | tools disagree |
| `riser-75x50` | each | 7: $60.00 |  |
| `riser-76x38` | each | 7: $55.00 |  |
| `roof-corrugated` | lm | 4: $22.00<br>4: $12.04<br>5: $22.00<br>7: $22.00<br>8: $12.04 | tools disagree |
| `roof-polycarbcorrugated` | lm | 4: $35.00 |  |
| `roof-polycarbtrimdek` | lm | 4: $38.00 |  |
| `roof-solarspan100` | lm | 4: $110.00<br>4: $130.00<br>5: $120.00<br>7: $120.00<br>8: $130.00 | tools disagree |
| `roof-solarspan150` | lm | 4: $165.00 |  |
| `roof-solarspan200` | lm | 4: $200.00 |  |
| `roof-solarspan75` | lm | 4: $110.00<br>5: $120.00<br>7: $120.00<br>8: $110.00 | tools disagree |
| `roof-spandek` | lm | 4: $14.50<br>8: $14.50 |  |
| `roof-spanplus330` | lm | 4: $12.04<br>5: $12.04<br>7: $12.04<br>8: $12.04 |  |
| `roof-stratcocgi100` | lm | 4: $110.00<br>4: $130.00<br>5: $120.00<br>7: $110.00 | tools disagree |
| `roof-stratcocgi100760` | lm | 4: $105.00 |  |
| `roof-stratcocgi75` | lm | 4: $110.00<br>5: $120.00<br>7: $110.00 | tools disagree |
| `roof-stratcocgi75760` | lm | 4: $90.00 |  |
| `roof-trimdek` | lm | 4: $22.00<br>4: $15.00<br>5: $22.00<br>7: $22.00<br>8: $15.00 | tools disagree |
| `steel-rhs-75x50x2` | lm | 4: $26.00<br>5: $26.00<br>7: $26.00 |  |
| `truss-fabrication` | lm | 4: $93.00<br>7: $95.00 | tools disagree |
| `truss-steel-76x38` | lm | 4: $15.50<br>7: $15.50 |  |

## Held mappings: fence panel kits with no stated width

The fence tool keys panel kits by height and post length only. R&R sells 2380 and 3150 wide panels at different prices, so these are not merged until the width is confirmed.

| Tool item | Tool values | R&R candidates (latest) |
|---|---|---|
| `fencing-panel-kit-1200-2400` | $75.00, $75.00 | none on file |
| `fencing-panel-kit-1500-2400` | $85.00, $85.00 | none on file |
| `fencing-panel-kit-1800-2700` | $113.00, $109.00 | W2380: $90.91, W3150: $115.45 |
| `fencing-panel-kit-2100-2700` | $99.00, $109.00 | W2380: $99.09, W3150: $126.36 |
| `fencing-panel-kit-2100-3000` | $126.50, $130.00 | W2380: $100.91, W3150: $128.18 |

## Priced only by invoice or supplier evidence

| Item | Unit | Latest | Rows |
|---|---|---|---:|
| `fence-panel-kit-h1200-w2380-post1800` | each | $66.18 2026-03-10 R&R Fencing | 1 |
| `fence-panel-kit-h1500-w2380-post2100` | each | $78.18 2026-03-10 R&R Fencing | 1 |
| `fence-panel-kit-h1800-w2380-post1800` | each | $83.64 2026-02-11 R&R Fencing | 1 |
| `fence-panel-kit-h1800-w2380-post2700` | each | $90.91 2026-05-29 R&R Fencing | 1 |
| `fence-panel-kit-h1800-w2380-post3000` | each | $92.73 2026-06-05 R&R Fencing | 1 |
| `fence-panel-kit-h1800-w3150-post2400` | each | $112.73 2026-04-08 R&R Fencing | 1 |
| `fence-panel-kit-h1800-w3150-post2700` | each | $115.45 2026-05-05 R&R Fencing | 1 |
| `fence-panel-kit-h2100-w2380-post2700` | each | $99.09 2026-05-15 R&R Fencing | 1 |
| `fence-panel-kit-h2100-w2380-post3000` | each | $100.91 2026-05-15 R&R Fencing | 1 |
| `fence-panel-kit-h2100-w3150-post2700` | each | $126.36 2026-05-15 R&R Fencing | 1 |
| `fence-panel-kit-h2100-w3150-post3000` | each | $128.18 2025-11-26 R&R Fencing | 1 |
| `fencing-cement-delivered-20kg-bag-only-rainproof-kwikset` | each | $10.00 2026-01-27 R&R Fencing | 1 |
| `fencing-colorbond-post-only-1800mm` | each | $6.82 2026-05-15 R&R Fencing | 1 |
| `fencing-colorbond-post-only-2700mm` | each | $10.45 2026-04-07 R&R Fencing | 1 |
| `fencing-colorbond-post-only-3000mm` | each | $11.36 2026-04-15 R&R Fencing | 1 |
| `fencing-colorbond-post-only-standard-2380mm` | each | $9.09 2026-04-15 R&R Fencing | 1 |
| `fencing-colorbond-rail-only-long-3150mm` | each | $12.73 2026-04-21 R&R Fencing | 1 |
| `fencing-colorbond-rail-only-standard-2380mm` | each | $9.09 2026-04-15 R&R Fencing | 1 |
| `fencing-colorbond-sheet-only-1800mm` | each | $17.27 2026-05-27 R&R Fencing | 1 |
| `fencing-colorbond-sheet-only-2100mm` | each | $20.00 2026-04-02 R&R Fencing | 1 |
| `fencing-dandd-heavy-duty-true-close-hinge-pair-tcs3-tchd1a` | each | $60.91 2026-04-16 R&R Fencing | 1 |
| `fencing-dandd-pro-lokk-latch-delux-keyed-different-lldabs` | each | $80.91 2026-04-16 R&R Fencing | 1 |
| `fencing-panel-lattice-extension-kit-length-w2380mm-h300mm` | each | $67.27 2026-02-11 R&R Fencing | 1 |
| `fencing-post-cap-pvc-to-suit-colorbond-post` | each | $0.45 2026-05-29 R&R Fencing | 1 |
| `fencing-tek-screws-pack-100` | each | $6.36 2026-04-15 R&R Fencing | 1 |
| `fencing-touch-up-paint-can-surfmist` | each | $10.91 2026-02-18 R&R Fencing | 1 |
| `flashing-girth-100-1-bend` | lm | $4.76 2026-06-05 CMI (Combined Metal Industries) | 3 |
| `flashing-girth-100-3-bend` | lm | $6.18 2025-09-05 Metroll Perth (staged for blessing) | 1 |
| `flashing-girth-150-1-bend` | lm | $6.48 2026-06-05 CMI (Combined Metal Industries) | 1 |
| `flashing-girth-150-2-bend` | lm | $7.80 2026-06-05 CMI (Combined Metal Industries) | 1 |
| `flashing-girth-200-3-bend` | lm | $10.84 2026-05-22 CMI (Combined Metal Industries) | 1 |
| `flashing-girth-300-2-bend` | lm | $12.40 2026-05-22 CMI (Combined Metal Industries) | 2 |
| `flashing-girth-400-2-bend` | lm | $14.83 2026-05-21 CMI (Combined Metal Industries) | 1 |
| `flashing-girth-400-4-bend` | lm | $18.28 2026-05-22 CMI (Combined Metal Industries) | 1 |
| `patio-0.42mm-trimdeck-roof-sheeting-night-sky-colourtop-side-3000mm-sheet` | length | $50.73 2025-11-28 BD Metals (staged for blessing) | 1 |
| `patio-42-monument-corodek-sheeting-42mtcorodhtv` | m2 | $18.96 2025-11-18 Metroll Perth (staged for blessing) | 1 |
| `patio-51mm-roof-zips-screws-surfmist` | each | $0.27 2026-03-09 BD Metals (staged for blessing) | 1 |
| `patio-bd-metals-delivery-address-withheld` | delivery | $172.73 2026-03-09 BD Metals (staged for blessing) | 2 |
| `patio-colonial-gutter-night-sky-6200mm-x2-1-lh-1-rh-stop-ends-20-gutter-clips` | kit | $204.55 2025-11-28 BD Metals (staged for blessing) | 1 |
| `patio-f-02155-custom-bottom-chord-truss-paperbark` | each | $626.68 2026-05-04 CMI (Combined Metal Industries) | 1 |
| `patio-fascia-monument-metfasciamtv` | lm | $12.16 2025-11-18 Metroll Perth (staged for blessing) | 1 |
| `patio-flat-ridge-cap-monument-55-to-suit-corodek-55mtfltrotpv` | lm | $15.43 2025-11-18 Metroll Perth (staged for blessing) | 1 |
| `patio-general-purpose-concrete` | bag | $7.27 2025-11-28 BD Metals (staged for blessing) | 1 |
| `patio-greca-sheet-grey-polycarb-3010mm` | length | $43.64 2026-03-09 BD Metals (staged for blessing) | 1 |
| `patio-monument-downpipe-strap-95x45-strap95-45mt` | each | $0.74 2025-11-18 Metroll Perth (staged for blessing) | 1 |
| `patio-quickfix-patio-gutter-kit-3800mm-surfmist-lh-rh-stop-ends-1-pop-2x-1800mm-95x45` | kit | $103.64 2026-03-09 BD Metals (staged for blessing) | 1 |
| `patio-quickfix-patio-gutter-kit-6500mm-surfmist-2-pops-lh-rh-stop-ends-7-universal-cli` | kit | $106.36 2026-03-09 BD Metals (staged for blessing) | 1 |
| `patio-quickset-concrete` | bag | $7.27 2025-11-28 BD Metals (staged for blessing) | 1 |
| `patio-r-l-col-mitre-ext-monument-90-rlmemt` | each | $33.55 2025-11-18 Metroll Perth (staged for blessing) | 1 |
| `patio-r-l-colonial-clip-f-type-rlcf` | each | $1.21 2025-11-18 Metroll Perth (staged for blessing) | 1 |
| `patio-r-l-colonial-slotted-gutter-monument-40mtrlcolslv` | lm | $8.49 2025-11-18 Metroll Perth (staged for blessing) | 1 |
| `patio-r-l-colonial-stopend-left-monument-rlselmt` | each | $1.32 2025-11-18 Metroll Perth (staged for blessing) | 1 |
| `patio-r-l-colonial-stopend-right-monument-rlsermt` | each | $1.32 2025-11-18 Metroll Perth (staged for blessing) | 1 |
| `stratco-qs-csr-stock` | each | $53.62 2026-09-16 Stratco (staged for blessing) | 1 |
| `stratco-qs-f-section-stock` | each | $46.36 2026-09-16 Stratco (staged for blessing) | 1 |
| `stratco-qs-side-frame-lm` | lm | $13.81 2026-09-16 Stratco (staged for blessing) | 1 |
| `stratco-qs-slat-65-col-lm` | lm | $13.08 2026-09-16 Stratco (staged for blessing) | 1 |
| `stratco-qs-slat-90-col-lm` | lm | $17.28 2026-09-16 Stratco (staged for blessing) | 1 |
| `stratco-qsg-gate-frame-lm` | lm | $47.73 2026-09-16 Stratco (staged for blessing) | 1 |

## Unpriced items ($0 sentinels, never loaded as a price)

`bracket-riser`, `labour-electrician-day`, `labour-labourer-day`, `labour-trade-day`, `patio-aluminium-slat-walling-sqm`, `patio-council-permit`, `patio-gable-infill-sqm`, `patio-shadecloth-batten-lm`, `patio-shadecloth-purlin-lm`, `patio-shadecloth-sqm`, `patio-shadecloth-tensioning-wire-lm`, `patio-site-establishment`, `purlin-c150`, `purlin-c200`, `roof-ampelitesolasafecorrugated`, `roof-laserlite20005rib`, `steel-rhs-125x50x2`, `steel-rhs-50x25x1.6`, `steel-rhs-65x35x2`, `steel-rhs-75x35x2`, `steel-shs-100x100x2`, `steel-shs-125x125x3`, `steel-shs-150x150x3`, `steel-shs-65x65x2`, `steel-shs-75x75x2`

## Legacy sell rates (reported only, missing cost flagged)

The owner ruled cost is the primary value. These are what the tools charge the customer today; each needs a real cost before a markup can replace it.

| Store | Key | Sell | Unit |
|---|---|---:|---|
| 2 fence sell defaults | pricePerMetre | $125.00 | lm |
| 2 fence sell defaults | plinthPrice | $80.00 | each |
| 2 fence sell defaults | hardiePrice | $30.00 | lm |
| 2 fence sell defaults | timberPrice | $45.00 | lm |
| 2 fence sell defaults | colorbondRemovalPrice | $30.00 | lm |
| 2 fence sell defaults | asbestosPrice | $90.00 | lm |
| 2 fence sell defaults | pedestrianGatePrice | $1100.00 | each |
| 2 fence sell defaults | doubleGatePrice | $2400.00 | each |
| 2 fence sell defaults | patioTubePrice | $75.00 | each |
| 2 fence sell defaults | asbestosCertFee | $300.00 | job |
| 2 fence sell defaults | vegClearPrice | $215.00 | job |
| 2 fence sell defaults | slidingGatePrice | $0.00 | each |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.fencing_1800_per_m | $120.00 | lm |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.fencing_2100_per_m | $128.00 | lm |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.extension_150_per_m | $110.00 | lm |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.plinth_each | $80.00 | each |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.pedestrian_gate | $1100.00 | each |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.pedestrian_gate_standalone | $1175.00 | each |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.double_gate | $2400.00 | each |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.remove_hardie_per_sheet | $30.00 | each |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.remove_timber_per_m | $40.00 | lm |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.remove_asbestos_per_sheet | $90.00 | each |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.asbestos_removal_fee | $300.00 | each |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.delivery | $250.00 | each |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.vegetation_clear | $150.00 | each |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.additional_labour_per_hr | $85.00 | each |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.mulch_per_m2 | $8.00 | m2 |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.white_stones_per_m2 | $15.00 | m2 |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.turf_prep_per_m2 | $12.00 | m2 |
| 3 fence business_rules.js (dead) | DEFAULT_RATES.rock_per_hole | $45.00 | each |
| 4 fence parity seed SQL | fence-designer:fencing_install:cb-1800-sell | $120.00 | m |
| 4 fence parity seed SQL | fence-designer:fencing_install:cb-2100-sell | $128.00 | m |
| 4 fence parity seed SQL | fence-designer:fencing_extensions:solid-fill-150-sell | $110.00 | m |
| 4 fence parity seed SQL | fence-designer:fencing_extensions:plinth-sell | $80.00 | ea |
| 4 fence parity seed SQL | fence-designer:fencing_gates:ped-gate-standalone-sell | $1175.00 | ea |
| 4 fence parity seed SQL | fence-designer:fencing_gates:ped-gate-bundled-sell | $1100.00 | ea |
| 4 fence parity seed SQL | fence-designer:fencing_gates:dbl-swing-gate-sell | $2400.00 | ea |
| 4 fence parity seed SQL | fence-designer:fencing_install:price-per-metre-default | $125.00 | m |
| 4 fence parity seed SQL | fence-designer:fencing_removal:remove-hardie-sell | $30.00 | sheet |
| 4 fence parity seed SQL | fence-designer:fencing_removal:remove-timber-sell | $40.00 | m |
| 4 fence parity seed SQL | fence-designer:fencing_removal:remove-asbestos-sell | $90.00 | sheet |
| 4 fence parity seed SQL | fence-designer:fencing_services:delivery-sell | $250.00 | job |
| 4 fence parity seed SQL | fence-designer:fencing_services:veg-clear-sell | $150.00 | job |
| 4 fence parity seed SQL | fence-designer:fencing_services:addl-labour-sell | $85.00 | hr |
| 4 fence parity seed SQL | fence-designer:fencing_ground:mulch-sell | $8.00 | m2 |
| 4 fence parity seed SQL | fence-designer:fencing_ground:white-stones-sell | $15.00 | m2 |
| 4 fence parity seed SQL | fence-designer:fencing_ground:turf-prep-sell | $12.00 | m2 |
| 7 patio engine snapshot (unused) | labour-trade-sell | $110.00 | hour |
| 7 patio engine snapshot (unused) | labour-labourer-sell | $90.00 | hour |

## Markup found in the stores

| Store | Key | Value |
|---|---|---:|
| 4 fence parity seed SQL | patio-tool:markup:default-sell-markup | 1.35 |
| 5 patio hardcoded tables | DEFAULT_SELL_MARKUP | 1.35 |
| 7 patio engine snapshot (unused) | materialMarkup | 1.5 |

Loaded by the migration as family defaults: patio 1.35 provisional (for the patio lead to set), Stratco 1.4 provisional, fencing and misc not set.

## Allowances loaded

| Allowance | Basis | Band | Cost ex GST | Evidence |
|---|---|---|---:|---|
| flashing-standard | per_m2_of_girth |  | $20.00 | seed-from-tool-hardcoded 2026-06-11; FLASHING_RATES.standard global |
| flashing-solarspan | per_m2_of_girth |  | $25.00 | seed-from-tool-hardcoded 2026-06-11; FLASHING_RATES.solarspan global |
| flashing-standard | per_m2_of_girth |  | $15.00 | owner-confirmed 2026-08-10; the live patio tool does not read this engine |
| flashing-solarspan | per_m2_of_girth |  | $25.00 | owner-confirmed 2026-08-10; the live patio tool does not read this engine |
| fixings | per_m2 |  | $50.00 | owner-confirmed 2026-08-10; the live patio tool does not read this engine |
| flashing | per_lm_by_girth_band | 0 to 100 mm | $5.41 | flashing-girth-100-1-bend CMI (Combined Metal Industries) $4.76; flashing-girth-100-3-bend Metroll Perth $6.18; flashing-girth-100-1-bend Metroll Perth $5.30 |
| flashing | per_lm_by_girth_band | 101 to 150 mm | $7.14 | flashing-girth-150-1-bend CMI (Combined Metal Industries) $6.48; flashing-girth-150-2-bend CMI (Combined Metal Industries) $7.80 |
| flashing | per_lm_by_girth_band | 151 to 200 mm | $10.84 | flashing-girth-200-3-bend CMI (Combined Metal Industries) $10.84 |
| flashing | per_lm_by_girth_band | 201 to 300 mm | $12.40 | flashing-girth-300-2-bend CMI (Combined Metal Industries) $12.40 |
| flashing | per_lm_by_girth_band | 301 to 400 mm | $16.55 | flashing-girth-400-2-bend CMI (Combined Metal Industries) $14.83; flashing-girth-400-4-bend CMI (Combined Metal Industries) $18.28 |
| flashing-unknown-girth | per_lm |  | $10.50 | family average of 13 invoice lines across 3 suppliers (patio PR 102, 13 Jun) |

## Excluded rows

| Reason | Rows |
|---|---:|
| 3 fence business_rules.js (dead): dead store: business_rules.js is not loaded by the fence tool | 19 |
| 4 fence parity seed SQL: not a price (a count, percentage or dimension) | 11 |
| 10 wiki supplier CSVs: compound invoice line (several items in one amount) | 8 |
| 10 wiki supplier CSVs: one-off job line, not a catalogue item | 2 |
| 10 wiki supplier CSVs: the source says never price from this form rate | 1 |

## Not loaded: could not be placed

- 4 fence parity seed SQL `scope_tool:category:item_key`: unit unit is not a price book unit
- 5 patio hardcoded tables `STOCK_LENGTH_WASTE_CONFIG.flashing-generic`: unit mm is not a price book unit
- 5 patio hardcoded tables `STOCK_LENGTH_WASTE_CONFIG.solarspan`: unit mm is not a price book unit
- 5 patio hardcoded tables `STOCK_LENGTH_WASTE_CONFIG.colorbond-sheet`: unit mm is not a price book unit
- 5 patio hardcoded tables `STOCK_LENGTH_WASTE_CONFIG.polycarb-sheet`: unit mm is not a price book unit
