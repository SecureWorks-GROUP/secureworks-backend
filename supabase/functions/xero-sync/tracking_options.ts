import { DIVISION_CATEGORY_NAME } from '../_shared/xero_draft_standard.ts'

type TrackingOption = { TrackingOptionID: string; Name: string; Status?: string }
type TrackingCategory = {
  TrackingCategoryID: string
  Name: string
  Options?: TrackingOption[]
}

export function trackingOptionRows(
  response: { TrackingCategories?: TrackingCategory[] },
  orgId: string,
  categoryId: string,
  nowIso: string,
) {
  const categories = response?.TrackingCategories || []
  const category = categories.find((c) => c.TrackingCategoryID === categoryId) ||
    categories.find((c) => c.Name === DIVISION_CATEGORY_NAME)
  if (!category) return []
  return (category.Options || []).map((option) => ({
    org_id: orgId,
    category_id: category.TrackingCategoryID,
    category_name: category.Name,
    option_id: option.TrackingOptionID,
    option_name: option.Name,
    status: option.Status === 'ACTIVE' ? 'ACTIVE' : 'ARCHIVED',
    synced_at: nowIso,
  }))
}
