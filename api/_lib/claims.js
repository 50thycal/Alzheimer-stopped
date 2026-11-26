// Shared claim projection. A lease is shown only while active.
export const CLAIM_COLS = `
  c.id, c.program, c.status, c.level, c.text, c.refutes_if, c.date_label as date, c.source,
  c.created_by, c.updated_at,
  'C-' || c.program || '-' || c.id as unit,
  case when c.lease_until > now() then c.lease_handle end as lease_handle,
  case when c.lease_until > now() then c.lease_until end as lease_until`;

export const monthLabel = (d = new Date()) =>
  d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) + ' ' + d.getUTCFullYear();
