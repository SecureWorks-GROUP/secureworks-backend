-- Exact standalone prerequisite copied from 20261115143000, not a reduced stand-in.
CREATE OR REPLACE FUNCTION public.job_cost_close_policy()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $policy$
  SELECT jsonb_build_object(
    'version', 'cost-close-v1',
    'quiet_days', 30,
    'finished_statuses', jsonb_build_array('complete', 'invoiced', 'final_payment', 'get_review', 'archived'),
    'did_not_go_ahead_statuses', jsonb_build_array('cancelled', 'lost'),
    'reopened_statuses', jsonb_build_array('rectification'),
    'invoice_marks_finished_types', jsonb_build_array('makesafe'),
    'invoice_finish_statuses', jsonb_build_array('accepted', 'scheduled', 'processing'),
    'invoice_never_finishes_subtypes', jsonb_build_array('restoration'),
    'repair_finished_stages', jsonb_build_array('complete'),
    'closed_statuses', jsonb_build_array('archived'),
    'status_events', jsonb_build_object('status_changed', NULL, 'status_change', NULL,
                                        'restoration_stage_changed', NULL, 'quote_accepted', 'accepted',
                                        'quote_run_declined', 'partially_accepted',
                                        'callback_opened', 'in_progress', 'callback_resolved', 'complete'),
    'reopen_event_types', jsonb_build_array('makesafe_reattend', 'quote_accepted', 'quote_run_declined',
                                            'callback_opened'),
    'reopen_note_prefix', 'Job reopened',
    'callback_opened_event', 'callback_opened',
    'callback_resolved_event', 'callback_resolved',
    'not_cost_reasons', jsonb_build_array('missing_client_invoice', 'draft_revenue', 'holding_job',
                                          'variation_not_invoiced', 'variation_invoice_unchecked',
                                          'expected_cost_lane_missing', 'xero_project_linked_by_contact_only'),
    'pending_cost_reasons', jsonb_build_array('open_purchase_orders', 'ordered_not_billed',
                                              'ordered_not_billed_over_30_days', 'po_no_bill_overdue',
                                              'invoice_emailed_bill_not_placed', 'installer_bill_unconfirmed',
                                              'unapproved_trade_charges', 'dispatch_order_not_billed',
                                              'work_order_not_billed', 'variation_cost_not_in', 'draft_bill_on_job'),
    'restoration_open_quote_statuses', jsonb_build_array('draft', 'sent'),
    'variation_open_statuses', jsonb_build_array('pending_approval', 'sent'),
    'variation_dead_statuses', jsonb_build_array('declined', 'cancelled', 'rejected', 'void', 'voided', 'withdrawn'),
    'work_order_dead_statuses', jsonb_build_array('draft', 'cancelled', 'void', 'voided', 'declined', 'rejected'),
    'work_order_tolerance_ex', 1,
    'variation_cost_cover_share', 0.5,
    'draft_bill_statuses', jsonb_build_array('DRAFT', 'SUBMITTED')
  );
$policy$;
