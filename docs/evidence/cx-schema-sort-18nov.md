# cx-schema-sort: omitted schema and contract re-check map

Report only, 18 Nov 2026. No database was contacted and no migration, runtime, CI or switch changed.

The director supplied the task: sort the 13 migration-produced differences and 180 live-only coordinates from the merged [whole-schema comparison](https://github.com/SecureWorks-GROUP/secureworks-backend/pull/1552). Source catalog and transition trace are pinned to main `80e49e987f69bb616700b711cd41aa84aff1f82a`. This is a classification of that saved observation, not a new production measurement.

## What the numbers mean

The saved run has 856 equal, 52 different (39 fixture-produced, 13 migration-produced), 180 live-only and 6 CI-only coordinates. This report covers exactly 193: the 13 and the 180. It excludes the 39 fixture-produced differences and 6 CI-only coordinates.

The 368 number is registered case setup/migration pairs, not a count of every SQL file reached through setup imports. Main at that snapshot has 679 migration files. An unregistered filename alone does not prove omission. Here, “omitted” means absent from the statically resolved setup/migration input closure and the object never reached its live hash in the saved trace. No contract assertions or rollback proofs ran in the measured build. Registration and source dependency are not a passing execution receipt.

Areas use one owner per coordinate: Job Profit is finance/revenue/cost evidence; Pay is crew pay, group coverage and work-order approval; Context is notes/read cadence plus evidence-health views; Other includes SES, auth, shared utilities, sales, scheduling and dispatch. The six Context live-only views have no repository producer, so that area is descriptive, not an established owner.

| Area | Migration-produced difference | Live-only | Total |
| --- | ---: | ---: | ---: |
| Job Profit | 2 | 9 | 11 |
| Context | 7 | 6 | 13 |
| Pay | 3 | 3 | 6 |
| Other | 1 | 162 | 163 |
| Total | 13 | 180 | 193 |

## Director re-checks first

Contract paths below are relative to `supabase/tests/migration-contracts/`; migration filenames are relative to `supabase/migrations/`. “Build” means the Nov 17 contract folders present at the measured head, not all historical cases. References are source evidence; this task ran no SQL assertions.

| Object / path | Mark | Proof boundary and director action |
| --- | --- | --- |
| `v_job_revenue_events` | Direct real-engine dependency | `20261117220001_job_profit_refresh_batches/contract.sql:68` asserts the credit row; lines 96-100 instrument/count the real view. Its baseline and stored result can agree on the same CI definition while live differs. Re-check against live's view and the omitted `20261103200000_job_revenue_follows_ledger_evidence.sql`; live merge-order reproduction belongs to FU29. |
| `v_job_revenue_events` | Transactional stand-in after schema check | `20261117195801_job_profit_stored/contract.sql:61-70` replaces the views with tiny fixture views. This proves storage mechanics; it does not certify live revenue semantics. |
| `v_xero_lines`, `v_bookkeeping_line_evidence_current` | Indirect dependency satisfied by TABLE stand-ins | The refresh-batches contract line 70 calls `job_profit_line_evidence_many`. Its body reads both relations. `20261104093000_job_profit_evidence_parts_credits_zero_lines/setup.sql:16,34,51` provides/uses the Xero table; `20261104063000_job_cost_bill_line_job_number/setup.sql:19` provides the bookkeeping table. “Live-only VIEW” does not mean the relation is absent. Re-check view-derived evidence against live, beyond fixture values. |
| `context_cadence_policy()` | Direct dependency; timestamp difference expected | `20261117194402_context_worker_state_indexes/contract.sql:79,100` reads `live_since`; `20261117220401_context_worker_facts_due/contract.sql:17-22` reads and transactionally replaces the policy. Compare timestamp-normalised behaviour, not literal body hashes. |
| `context_job_record_legacy_mail(...)` | Indirect dependency; exercised branch unproven | `20261117215801_job_page_speed_and_retry/contract.sql:40,54` reads `context_job_record_messages`; its migration line 114 calls legacy mail. That contract inserts a business-event fixture, not a legacy-mail load fixture. Re-check the omitted key-lookup patch and legacy-mail population separately. |
| `gen_random_uuid()` public wrapper | Name reference, namespace exception | Numerous build contracts call it unqualified, including refresh-batches line 30. The public wrapper is absent; a `pg_catalog` function is outside this public-only catalog. Do not turn this row into a claim that UUID generation is missing. |

No other target has a direct, non-comment name reference in Nov 17 assertion SQL. That is a bounded source-search result, not proof of no indirect dependency. All historical assertion/setup hits, exact identities and line numbers are retained in the SSD inventory. In particular no new proof of the omitted agent work-order approval or old notes judge/due patches can be inferred from the new pay/worker contracts.

## The 13 migration-produced differences

“Migration-produced” identifies the last CI writer. It does not mean every difference is caused by an omitted migration. Two are first-apply literals, two are registered patches over reduced fixtures, and two coverage views ran their canonical CREATE but still differ. Those six must not be given an invented missing replacement.

| Area | Object | Missing producer or relevant migration | Interpretation |
| --- | --- | --- | --- |
| Context | `context_cadence_policy()` | `20260924030000_context_evidence_cadence.sql` [in walk]; `20261006060000_context_call_budget_1000.sql` [in walk] | Expected first-apply literal; no omitted migration established. CI last writer: `20261006060000_context_call_budget_1000.sql`. |
| Context | `context_coverage()` | `20261102200000_context_coverage_counts_ledger.sql` [omitted] | Omitted replacement; exact live body match. CI last writer: `20260917210000_context_pipeline_status.sql`. |
| Context | `context_job_record_legacy_mail(p_job_ids uuid[], p_as_of timestamp with time zone)` | `20261103150000_context_record_mail_copy_key_fast.sql` [omitted] | Omitted guarded key-lookup patch; live body attribution not reproduced. CI last writer: `20261006040000_context_story_safety.sql`. |
| Context | `context_ledger_due(p_limit integer)` | `20261102210000_context_ledger_due_reader_change_fast.sql` [omitted]; `20261104175000_context_ledger_finished_request.sql` [omitted] | Omitted replacement and finished-request patch; live body attribution not reproduced. CI last writer: `20261012164500_context_rebuild_order.sql`. |
| Context | `context_ledger_evidence_rows(p_job_ids uuid[], p_as_of timestamp with time zone)` | `20261103150000_context_record_mail_copy_key_fast.sql` [omitted] | Omitted guarded key-lookup patch; live body attribution not reproduced. CI last writer: `20261030154917_context_ledger_person_placement.sql`. |
| Context | `context_ledger_judge(p_job_ids uuid[])` | `20261103030000_context_ledger_judge_inbox_ref_fast.sql` [omitted]; `20261104175000_context_ledger_finished_request.sql` [omitted] | Omitted guarded key-lookup and finished-request patches; live body attribution not reproduced. CI last writer: `20261030161813_context_placement_freshness.sql`. |
| Context | `context_ledger_mail_rule_since()` | `20261006040000_context_story_safety.sql` [in walk] | Expected first-apply literal; no omitted migration established. CI last writer: `20261006040000_context_story_safety.sql`. |
| Job Profit | `job_financials` | `20260613000001_job_financials_views.sql` [omitted] | Omitted full producer; registered repair patch changed a reduced fixture view. CI last writer: `20260826000001_repair_job_type.sql`. |
| Job Profit | `v_job_revenue_events` | `20261103200000_job_revenue_follows_ledger_evidence.sql` [omitted] | Omitted ledger-evidence patch; final CI writer is office variations; live apply-order proof remains separate. CI last writer: `20261111100000_job_profit_office_variations.sql`. |
| Other | `enforce_makesafe_intake_case_write()` | `20260720000001_makesafe_intake_cases.sql` [omitted] | Omitted full producer; registered repair patch changed a reduced fixture, live body not reproduced. CI last writer: `20260826000001_repair_job_type.sql`. |
| Pay | `v_group_coverage` | `20261103100000_fence_auto_group_off.sql` [in walk] | Canonical CREATE ran; no omitted writer found; hash-only evidence cannot resolve underlying-type/deparser drift. CI last writer: `20261103100000_fence_auto_group_off.sql`. |
| Pay | `v_patio_group_coverage` | `20261102120000_patio_auto_group.sql` [in walk] | Canonical CREATE ran; no omitted writer found; hash-only evidence cannot resolve underlying-type/deparser drift. CI last writer: `20261102120000_patio_auto_group.sql`. |
| Pay | `work_orders_job_kind_guard()` | `20261117010000_job_work_order_agent_approval.sql` [omitted] | Omitted replacement; exact live body match. CI last writer: `20261109040000_scope_owner_approvals.sql`. |

The guarded Context patch filenames above are identified source changes, not reproduced live body attribution. `20261115092000_context_ledger_due_time.sql` changes a function setting, which this body-only comparison cannot measure. The coverage-view hashes need full view text plus dependency types/deparser settings before assigning a cause. For the repair-patched trigger, the reduced fixture similarly prevents an exact live body conclusion. No migration should be applied from this table alone.

## All 180 live-only coordinates, grouped by area and producer

120 have a direct function-body md5 match in migration text, 37 have declaration candidates only, and 23 have no direct declaration. A body match establishes body provenance, not signature/grants/settings equality. A candidate may name another overload. All exact signatures and both hashes are in the full SSD table. “Unknown” rows have no honestly identifiable omitted migration in the supplied evidence.

| Area | Migration attribution / confidence | Live-only objects |
| --- | --- | --- |
| Context | Unknown: no direct declaration in measured main; omitted migration cannot be named. | `v_evidence_health`, `v_evidence_health_mailbox`, `v_evidence_health_proposals`, `v_evidence_health_queue`, `v_evidence_health_stale`, `v_unresolved_evidence` |
| Job Profit | `20260613000001_job_financials_views.sql` [omitted] [candidate only] | `v_job_double_charge`, `v_makesafe_charge_ledger` |
| Job Profit | `20260705000005_job_expected_cost_baseline.sql` [omitted] [candidate only] | `v_job_expected_cost_facts` |
| Job Profit | `20261102070000_job_profit_line_evidence.sql` [body match; omitted] | `bookkeeping_evidence_add`, `bookkeeping_evidence_close`, `bookkeeping_evidence_open` |
| Job Profit | `20261102070000_job_profit_line_evidence.sql` [omitted] [candidate only] | `v_bookkeeping_line_evidence_current`, `v_xero_lines` |
| Job Profit | `20261102140000_job_profit_line_evidence_many.sql` [body match; omitted] | `job_profit_line_evidence` |
| Other | Unknown: no direct declaration in measured main; omitted migration cannot be named. | `_sw_api_key`, `dequeue_next_event`, `increment_observation_count`, `keep_human_parked_intake_case`, `match_observations`, `purge_synthetic_livefire_jobs_without_case_tombstones`, `rls_auto_enable`, `scan_jobs_touch`, `set_bookings_updated_at`, `staff_pings_claim`, `staff_pings_mark`, `staff_pulse_enqueue`, `staff_pulse_enqueue_manual`, `staff_pulse_ping_status`, `update_timestamp`, `v_sales_conversation`, `v_sales_priority` |
| Other | `20250301000001_schema.sql` [body match; omitted] | `auth_org_id`, `auth_role`, `update_updated_at` |
| Other | `20250301000001_schema.sql` [omitted] [candidate only] | `pipeline_summary`, `upcoming_schedule` |
| Other | `20250301000003_reporting_schema.sql` [omitted] [candidate only] | `monthly_costs`, `monthly_revenue`, `pipeline_metrics` |
| Other | `20250301000003_reporting_schema.sql` [omitted]; `20250302000007_ads_granular.sql` [omitted] [candidate only] | `google_ads_monthly` |
| Other | `20250301000003_reporting_schema.sql` [omitted]; `20250304000017_aged_receivables_division.sql` [omitted] [candidate only] | `aged_receivables` |
| Other | `20250303000010_ops_dashboard.sql` [omitted] [candidate only] | `gen_random_bytes`, `gen_random_uuid`, `jobs_needing_scheduling` |
| Other | `20260317000002_quote_invoicing.sql` [omitted] [candidate only] | `next_quote_number` |
| Other | `20260406000001_debt_automation.sql` [omitted] [candidate only] | `contact_enrichment_queue` |
| Other | `20260430160000_create_quote_revisions.sql` [body match; omitted] | `quote_revisions_no_delete` |
| Other | `20260430160000_create_quote_revisions.sql` [omitted]; `20260430170000_add_quote_revisions_manifest_canonical_text.sql` [omitted]; `20260502000000_quote_revisions_v2_columns_and_supersession.sql` [omitted] [candidate only] | `quote_revisions_controlled_immutable` |
| Other | `20260501100000_quote_revision_binding_and_read_shape.sql` [omitted] [candidate only] | `get_release_packet` |
| Other | `20260504090757_scope_revisions_and_artifacts.sql` [body match; omitted] | `scope_artifacts_append_only`, `scope_revisions_no_delete` |
| Other | `20260505010113_scoper_preferences.sql` [body match; omitted] | `set_scoper_preferences_updated_at` |
| Other | `20260614000002_makesafe_email_sync_cron.sql` [body match; omitted] | `trigger_makesafe_email_purge`, `trigger_monitor_ses_makesafes` |
| Other | `20260614000005_makesafe_backfill_commit.sql` [body match; omitted] | `commit_makesafe_backfill` |
| Other | `20260615000003_makesafe_sync_lock_lease.sql` [body match; omitted] | `try_lock_mailbox_sync`, `unlock_mailbox_sync` |
| Other | `20260703000001_makesafe_intake_health_and_autofile.sql` [body match; omitted] | `makesafe_auto_file_enabled` |
| Other | `20260720000001_makesafe_intake_cases.sql` [body match; omitted] | `enforce_makesafe_intake_case_source_insert`, `makesafe_intake_email_accounting`, `makesafe_intake_field_names_valid`, `makesafe_intake_provenance_valid`, `record_makesafe_intake_case_event`, `reject_makesafe_intake_append_only_mutation` |
| Other | `20260720000001_makesafe_intake_cases.sql` [omitted] [candidate only] | `makesafe_intake_case_divergence` |
| Other | `20260720235959_fence_opportunity_mapping_dedupe.sql` [body match; omitted] | `_fence_opportunity_mapping_job_scope_count`, `_fence_opportunity_mapping_rank` |
| Other | `20260721000001_makesafe_intake_production_controls.sql` [body match; omitted] | `makesafe_exact_allowlist_valid` |
| Other | `20260723000001_makesafe_board_truth_shadow.sql` [omitted] [candidate only] | `makesafe_status_disagreements` |
| Other | `20260724005540_makesafe_board_truth_cutover.sql` [body match; omitted] | `apply_makesafe_board_status`, `guard_makesafe_board_status_application_insert`, `reject_makesafe_board_status_application_mutation` |
| Other | `20260724005540_makesafe_board_truth_cutover.sql` [omitted]; `20260801045000_makesafe_duplicate_survivor_archive.sql` [omitted] [candidate only] | `makesafe_board_status_current` |
| Other | `20260724070000_makesafe_deterministic_standing_intake.sql` [body match; omitted] | `makesafe_deterministic_intake_preflight`, `makesafe_intake_mode` |
| Other | `20260727080821_makesafe_synthetic_livefire_infrastructure.sql` [body match; omitted] | `enforce_ses_synthetic_livefire_run_change`, `makesafe_intake_fresh_source_health`, `makesafe_synthetic_livefire_source_health`, `prevent_makesafe_attendance_cycle_identity_change`, `purge_synthetic_livefire_attendance_cycles`, `register_synthetic_livefire_job`, `ses_synthetic_livefire_marker_is_terminal`, `terminalize_synthetic_livefire_run` |
| Other | `20260728000001_makesafe_state_authority_u2.sql` [body match; omitted] | `commit_makesafe_readiness`, `invalidate_makesafe_authority_dependency`, `invalidate_makesafe_case_dependency`, `invalidate_makesafe_fact_dependency`, `makesafe_attendance_cycle_set_hash_v1`, `makesafe_canonical_json_v1`, `makesafe_readiness_revision_v1` |
| Other | `20260728000001_makesafe_state_authority_u2.sql` [omitted] [candidate only] | `makesafe_cancellation_current_v2`, `makesafe_family_rules_current_v2`, `makesafe_terminal_proofs_current_v2` |
| Other | `20260728000001_makesafe_state_authority_u2.sql` [omitted]; `20260728020000_makesafe_ses_invoice_release_u5_u6.sql` [omitted] [candidate only] | `makesafe_readiness_current_v2` |
| Other | `20260728000001_makesafe_state_authority_u2.sql` [omitted]; `20260728020000_makesafe_ses_invoice_release_u5_u6.sql` [omitted]; `20260803040000_ses_approval_visibility_decoupled_from_readiness.sql` [omitted] [candidate only] | `makesafe_revision_approvals_current_v2` |
| Other | `20260728010000_makesafe_docket_revisions_u4.sql` [body match; omitted] | `commit_makesafe_docket_revision_v1`, `reject_makesafe_docket_append_only_change` |
| Other | `20260728010000_makesafe_docket_revisions_u4.sql` [omitted]; `20260728020000_makesafe_ses_invoice_release_u5_u6.sql` [omitted] [candidate only] | `makesafe_docket_revisions_current` |
| Other | `20260728020000_makesafe_ses_invoice_release_u5_u6.sql` [body match; omitted] | `begin_ses_invoice_execution_v1`, `claim_ses_external_effect_v1`, `confirm_ses_release_route_v1`, `record_ses_review_feedback_v1`, `reject_makesafe_invoice_revision_content_change`, `reject_makesafe_release_revision_content_change`, `reject_ses_append_only_change` |
| Other | `20260728020000_makesafe_ses_invoice_release_u5_u6.sql` [omitted] [candidate only] | `makesafe_invoice_obligation_revisions_current`, `ses_release_proof_ledger` |
| Other | `20260728030000_synthetic_livefire_readiness_cleanup.sql` [body match; omitted] | `assert_synthetic_livefire_purge_job`, `invalidate_makesafe_readiness`, `reject_makesafe_state_audit_mutation` |
| Other | `20260728040000_synthetic_livefire_case_tombstone_cleanup.sql` [body match; omitted] | `makesafe_intake_case_transition_allowed`, `purge_synthetic_livefire_jobs` |
| Other | `20260728050000_makesafe_ses_fence_hardening.sql` [body match; omitted] | `guard_jobs_ses_money_seal_v1`, `guard_makesafe_invoice_void_content_v1` |
| Other | `20260728060000_makesafe_board_reconcile_truth_u2.sql` [body match; omitted] | `apply_makesafe_board_reconciliation`, `discard_makesafe_board_reconciliation`, `finalize_makesafe_board_reconciliation`, `guard_makesafe_board_attention_mark_insert`, `refresh_makesafe_case_lineage_identity_v1`, `reject_makesafe_board_attention_mark_mutation`, `reject_makesafe_state_seed_audit_mutation`, `stage_makesafe_board_reconciliation`, `stamp_makesafe_intake_case_identity_v1` |
| Other | `20260728060000_makesafe_board_reconcile_truth_u2.sql` [omitted] [candidate only] | `seed_makesafe_state_authority_v1`, `stamp_makesafe_fact_identity_v1`, `makesafe_board_attention_current`, `makesafe_state_identity_current_v2` |
| Other | `20260728060000_makesafe_board_reconcile_truth_u2.sql` [omitted]; `20260728060000_makesafe_board_reconcile_truth_u2.sql` [omitted] [candidate only] | `validate_makesafe_board_reconciliation_state_tokens` |
| Other | `20260728210000_makesafe_ses_docs_ready_signoff.sql` [body match; omitted] | `assert_ses_dockets_signed_off_v1`, `record_ses_docket_review_state_v1`, `reject_ses_docket_review_event_change` |
| Other | `20260728210000_makesafe_ses_docs_ready_signoff.sql` [omitted]; `20260803050000_ses_docket_review_retire.sql` [omitted] [candidate only] | `ses_docket_review_current` |
| Other | `20260728500000_makesafe_portal_capture_bridge_u4.sql` [body match; omitted] | `commit_makesafe_portal_capture_v1` |
| Other | `20260728730000_makesafe_sibling_evidence_bundle_u7.sql` [body match; omitted] | `reject_makesafe_sibling_evidence_mutation`, `validate_makesafe_sibling_bundle_binding`, `validate_makesafe_sibling_evidence_claim` |
| Other | `20260729000000_makesafe_state_seed_scope_accounting.sql` [body match; omitted] | `seed_makesafe_state_authority_scoped_v2` |
| Other | `20260729020000_makesafe_family_pointer_safeupdate_guard.sql` [body match; omitted] | `invalidate_makesafe_family_pointer` |
| Other | `20260729030000_makesafe_decimal_fact_canonicalization.sql` [body match; omitted] | `makesafe_fact_canonical_json_v1`, `makesafe_fact_hash_v1`, `makesafe_reconciliation_state_token_v1` |
| Other | `20260731000001_makesafe_pdf_extraction_belt.sql` [body match; omitted] | `purge_makesafe_email_pii` |
| Other | `20260731000001_makesafe_pdf_extraction_belt.sql` [omitted]; `20260731081410_fix_makesafe_pdf_drain_auth_and_response_check.sql` [omitted] [candidate only] | `trigger_makesafe_pdf_extraction_drain` |
| Other | `20260731000002_makesafe_intake_settlement_closure.sql` [body match; omitted] | `claim_makesafe_pdf_extraction`, `complete_makesafe_intake_job_mint`, `complete_makesafe_pdf_extraction`, `enqueue_makesafe_pdf_extraction`, `makesafe_pdf_extraction_backlog_estimate`, `purge_makesafe_pdf_extraction_coordinate_text`, `reserve_makesafe_intake_job_mint` |
| Other | `20260731081410_fix_makesafe_pdf_drain_auth_and_response_check.sql` [body match; omitted] | `check_makesafe_pdf_extraction_drain_response` |
| Other | `20260731085928_board_v2_seed_preview.sql` [body match; omitted] | `preview_makesafe_state_authority_v2` |
| Other | `20260731152254_vault_sync_sw_api_key.sql` [body match; omitted] | `vault_upsert_sw_api_key` |
| Other | `20260801045000_makesafe_duplicate_survivor_archive.sql` [body match; omitted] | `apply_makesafe_duplicate_survivor_archive` |
| Other | `20260801062000_ses_adjudicated_job_recovery.sql` [body match; omitted] | `bind_adjudicated_ses_existing_job` |
| Other | `20260802020000_makesafe_instruction_identity_atomicity.sql` [body match; omitted] | `apply_makesafe_work_order_identity_correction`, `release_makesafe_instruction_key_mint`, `reserve_makesafe_instruction_key_mint` |
| Other | `20260803010000_ses_drop_unsatisfiable_readiness_precondition.sql` [body match; omitted] | `commit_ses_invoice_obligation_revision_v1` |
| Other | `20260803020000_ses_drop_approval_readiness_precondition.sql` [body match; omitted] | `record_ses_revision_approval_v1` |
| Other | `20260803030000_ses_drop_release_execution_readiness_precondition.sql` [body match; omitted] | `begin_ses_release_execution_v1` |
| Other | `20260803050000_ses_docket_review_retire.sql` [body match; omitted] | `retire_ses_docket_revision_v1` |
| Other | `20260803080000_makesafe_roof_initial_cycle_binding.sql` [body match; omitted] | `bind_makesafe_roof_initial_cycle_v1` |
| Other | `20260804010000_ses_invoice_bound_docket_idempotent_adopt.sql` [body match; omitted] | `commit_ses_invoice_bound_docket_v1` |
| Other | `20260805010000_ses_closeout_proof_hash_set_compare.sql` [body match; omitted] | `commit_ses_release_closeout_v1` |
| Other | `20260808010000_ses_echo_code_approval.sql` [body match; omitted] | `consume_ses_channel_approval_code`, `issue_ses_channel_approval_request` |
| Other | `20260826090000_ses_release_own_letterhead_report_invoice_shape.sql` [body match; omitted] | `commit_ses_release_revision_v1` |
| Other | `20260911000001_sales_performance_weeks.sql` [body match; omitted] | `sales_performance_note_v1`, `sales_performance_write_v1` |
| Other | `20261023083000_catalogue_prices_staff_load.sql` [body match; omitted] | `catalogue_prices_staff_load` |
| Other | `20261023230100_dispatch_v2_replies_schedule.sql` [body match; omitted] | `trigger_dispatch_v2_replies_scan` |
| Other | `20261101010000_flashing_library_staff_only.sql` [body match; omitted] | `flashing_library_author`, `flashing_library_touch` |
| Other | `20261102010000_users_self_update_guard.sql` [body match; omitted] | `users_guard_self_update` |
| Other | `20261105010000_job_auto_start.sql` [body match; omitted] | `trigger_job_auto_start` |
| Pay | `20261024120000_trade_invoice_running_draft.sql` [body match; omitted] | `persist_running_trade_invoice_draft_v1` |
| Pay | `20261103160000_crew_pay_lands_as_labour.sql` [body match; omitted] | `job_profit_crew_pay_landing` |
| Pay | `20261117010000_job_work_order_agent_approval.sql` [body match; omitted] | `approve_job_work_order_by_agent` |

## Evidence and limits

The full 193-row table is `/Volumes/SSD/agent-scratch/cx-schema-sort/report.md`; structured rows, every historical contract/setup reference and static walk inputs are in `inventory.json` beside it. Source inputs are the prior task's `difference-attribution.json`, `catalog-changes.jsonl`, `build-meta.json` and both public-object TSVs under `/Volumes/SSD/agent-scratch/cx-schema-diff/`. The merged offline script is `scripts/compare-public-object-md5.ts`.

Offline validation: `python3 /Volumes/SSD/agent-scratch/cx-schema-sort/validate.py`, 8 checks passed, 0 failed. The main comparison CLI independently regenerated its 238 unequal rows with expected exit 1; the selected inventory reconciles to 193 exactly. No local contract suite, database migration, live read or entry-point change was needed. No new test replaces any named proof.

Body/view-definition hashes do not compare tables, grants, RLS, triggers, indexes, schedules, function settings or data. A table fixture can satisfy a view name. Exact function coordinates include argument names. The director still owns production/body provenance for the guarded patches, the 23 unattributed objects, the two coverage views and the contract re-checks above. This report supplies no release verdict or authority to apply anything.

Run record: 18 Nov | Codex | cx-schema-sort | classified 13 differences and 180 live-only coordinates from retained catalog evidence | offline inventory checks and main comparison | report only; director re-checks live definitions and affected proofs.
