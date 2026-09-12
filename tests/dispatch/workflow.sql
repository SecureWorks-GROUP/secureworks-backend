\set ON_ERROR_STOP on
set role service_role;
-- Native lease generation, dedup per plan revision, and retry durability.
insert into dispatch_tasks(org_id,job_id,source_version,plan_version) values('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','fixture',1);
select count(*) from dispatch_claim_tasks('00000000-0000-4000-8000-000000000001',10);
do $$ declare token uuid; begin
 select lease_token into token from dispatch_tasks where source_version='fixture';
 if token is null then raise exception 'missing lease token';end if;
 update dispatch_tasks set lease_until=now()-interval '1 second' where source_version='fixture';
 perform dispatch_claim_tasks('00000000-0000-4000-8000-000000000001',10);
 if (select lease_token from dispatch_tasks where source_version='fixture')=token then raise exception 'lease token reused';end if;
 if (select attempts from dispatch_tasks where source_version='fixture')<>2 then raise exception 'retry not durable';end if;
end $$;
insert into dispatch_tasks(org_id,job_id,source_version,plan_version) values('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','fixture',2);
do $$ begin if (select count(*) from dispatch_tasks)<>2 then raise exception 'manual revision dedup loss';end if;end $$;
-- Current source changes invalidate revisions, including supplier replies.
do $$ declare prior text; begin
 prior=dispatch_source_version('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001');
 insert into po_communications values('50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001');
 if prior=dispatch_source_version('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001') then raise exception 'reply failed to invalidate';end if;
end $$;
-- Preparation writes the incumbent PO owner once, retaining unknown financials.
select dispatch_commit('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',0,'20000000-0000-4000-8000-000000000010','order-hash','fixture','order_prepare',dispatch_source_version('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'),'{"allocations":[],"prepared_order_id":"60000000-0000-4000-8000-000000000001","order_drafts":[{"id":"60000000-0000-4000-8000-000000000001","supplier_name":"Fixture supplier","line_items":[{"quantity":2,"unit_price":null}],"delivery_address":"Fixture site"}]}');
do $$ begin
 if (select count(*) from purchase_orders where id='60000000-0000-4000-8000-000000000001' and status='draft' and total is null)<>1 then raise exception 'actual PO draft absent or falsely priced';end if;
end $$;
reset role;
