-- Someone seeded the live T7 draft table before EM1 (production had it empty
-- on 24 Sep 2026). The deployed old monitor-inbox path would already be
-- polling that list, so EM1 must refuse rather than build on rows nobody read.
INSERT INTO public.monitored_mailboxes(email,scope_label) VALUES('finance@secureworkswa.com.au','finance');
