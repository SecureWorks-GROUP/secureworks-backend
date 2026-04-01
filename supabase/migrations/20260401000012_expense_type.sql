-- Add expense type to distinguish company expenses vs reimbursements
ALTER TABLE quick_expenses ADD COLUMN IF NOT EXISTS expense_type text DEFAULT 'company_expense';
