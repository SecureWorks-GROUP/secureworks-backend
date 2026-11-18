-- Re-applies, oldest first, the later trade_pay_run_check_v2 bodies that
-- roll_back_check_successors.sql took off, for a proof that committed the
-- rollback (20261118115852's concurrent.sh). A newer successor adds itself last.
\ir ../../../migrations/20261118999912_trade_pay_run_receipt_not_booked.sql
