const BUSINESS_OFFSET_MS = 8 * 60 * 60 * 1000

export function businessDateParts(offsetDays = 0) {
  const shifted = new Date(Date.now() + BUSINESS_OFFSET_MS + offsetDays * 86400000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay() || 7
  }
}

export function businessDateString(offsetDays = 0) {
  const p = businessDateParts(offsetDays)
  const m = String(p.month).padStart(2, '0')
  const d = String(p.day).padStart(2, '0')
  return `${p.year}-${m}-${d}`
}

export function businessWeekRange() {
  const p = businessDateParts(0)
  const todayUtc = Date.UTC(p.year, p.month - 1, p.day)
  const monday = new Date(todayUtc - (p.weekday - 1) * 86400000)
  const sunday = new Date(todayUtc + (7 - p.weekday) * 86400000)
  const fmt = date => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
  return { start: fmt(monday), end: fmt(sunday) }
}

export function parseAppointmentDate(text, defaultYear = businessDateParts().year) {
  if (!text) return ''
  const str = String(text).trim()

  const standardMatch = str.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  if (standardMatch) {
    return `${standardMatch[1]}-${String(standardMatch[2]).padStart(2, '0')}-${String(standardMatch[3]).padStart(2, '0')}`
  }

  const cnMatch = str.match(/(\d{1,2})月(\d{1,2})日?/)
  if (cnMatch) {
    return `${defaultYear}-${String(cnMatch[1]).padStart(2, '0')}-${String(cnMatch[2]).padStart(2, '0')}`
  }

  const dotMatch = str.match(/(?:^|[^\d])(\d{1,2})\.(\d{1,2})(?:[^\d]|$)/)
  if (dotMatch) {
    return `${defaultYear}-${String(dotMatch[1]).padStart(2, '0')}-${String(dotMatch[2]).padStart(2, '0')}`
  }

  return ''
}

export function quickAppointment(dayOffset, period) {
  return `${businessDateString(dayOffset)} ${period}`
}

export function formatBusinessDateTime(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const shifted = new Date(date.getTime() + BUSINESS_OFFSET_MS)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  const hh = String(shifted.getUTCHours()).padStart(2, '0')
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0')
  return `${y}-${m}-${d} ${hh}:${mm}`
}
