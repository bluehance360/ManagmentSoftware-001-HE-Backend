const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function toLocalDateOnly(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeDateOnly(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (DATE_ONLY_RE.test(trimmed)) return trimmed;
  }

  return null;
}

function isDateOnly(value) {
  return DATE_ONLY_RE.test(String(value || ''));
}

function formatDateOnly(dateOnly, options = { month: 'short', day: 'numeric', year: 'numeric' }) {
  const normalized = normalizeDateOnly(dateOnly);
  if (!normalized) return '';
  const [year, month, day] = normalized.split('-').map(Number);
  const localDate = new Date(year, month - 1, day);
  return localDate.toLocaleDateString('en-US', options);
}

module.exports = {
  DATE_ONLY_RE,
  normalizeDateOnly,
  isDateOnly,
  toLocalDateOnly,
  formatDateOnly,
};
