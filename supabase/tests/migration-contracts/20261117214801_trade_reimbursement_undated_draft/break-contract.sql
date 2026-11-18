-- P1-05.8 replaced persist_weekly_trade_invoice_v1 later; unwind it first so
-- this down meets the body it was written against.
\ir ../../../rollbacks/20261118122209_trade_line_hold_work_order_split_down.sql
\ir ../../../rollbacks/20261118122208_trade_line_hold_weekly_split_down.sql
\ir ../../../rollbacks/20261117214801_trade_reimbursement_undated_draft_down.sql
