-- Prerequisites for 20261012100000_context_held_messages: none of its own. It reads business_events,
-- jobs and staff_ghl_users, which the earlier registered setups and migrations create, with every
-- function its bodies call.
SELECT 1;
