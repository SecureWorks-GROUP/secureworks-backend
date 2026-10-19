-- Remove the atomic hold: two unresolved attempts may then claim one item.
DROP INDEX public.outbound_send_claims_one_unresolved;
