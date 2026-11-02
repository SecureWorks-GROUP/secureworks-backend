-- Deliberately lose one kind of obligation from the returned reader input.
ALTER FUNCTION public.context_ledger_rebuild_packet(uuid,uuid) RENAME TO context_ledger_rebuild_packet_unbroken;
CREATE FUNCTION public.context_ledger_rebuild_packet(p_run_id uuid,p_lease_token uuid)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE packet jsonb; items jsonb;
BEGIN
 packet := public.context_ledger_rebuild_packet_unbroken(p_run_id,p_lease_token);
 SELECT coalesce(jsonb_agg(x),'[]') INTO items FROM jsonb_array_elements(packet->'open_items') x
 WHERE x->>'item_type' <> 'issue';
 RETURN packet || jsonb_build_object('open_items',items);
END $$;
