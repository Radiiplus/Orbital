export function formatCkbBalance(
  value?: number | string | null,
  pendingLabel = 'Checking...',
) {
  if (value === null || value === undefined || value === '') return pendingLabel

  const amount = Number(value)
  if (!Number.isFinite(amount)) return pendingLabel

  return `${amount.toLocaleString(undefined, {
    maximumFractionDigits: 8,
  })} CKB`
}
