-- Let a bill be answered job with no job, an unsure stand without a reason, and a message be wrong naming the job it
-- sat on: the contract's answer-rule checks must catch it.
ALTER TABLE public.context_truth_set_grades DROP CONSTRAINT context_truth_set_grades_answer;
