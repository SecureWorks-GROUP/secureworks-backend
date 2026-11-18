import { DIVISION_CATEGORY_NAME, type DraftStandard } from '../_shared/xero_draft_standard.ts'

type DivisionProblem = 'division_not_known' | 'division_option_not_active' | 'options_not_loaded'

export function invoiceDivisionTag(
  option: string,
  standard: Pick<DraftStandard, 'activeOptions' | 'optionsLoaded'>,
): { tracking: { Name: string; Option: string }[]; problem: DivisionProblem | null } {
  if (!option) return { tracking: [], problem: 'division_not_known' }
  if (!standard.optionsLoaded) return { tracking: [], problem: 'options_not_loaded' }
  if (!standard.activeOptions.has(option)) return { tracking: [], problem: 'division_option_not_active' }
  return { tracking: [{ Name: DIVISION_CATEGORY_NAME, Option: option }], problem: null }
}
