// Shared claim projection. A lease is shown only while active.
export const CLAIM_COLS = `
  c.id, c.program, c.status, c.text, c.refutes_if, c.date_label as date, c.source,
  c.created_by, c.updated_at,
  case when c.lease_until > now() then c.lease_agent end as lease_agent,
  case when c.lease_until > now() then c.lease_until end as lease_until`;

export const monthLabel = (d = new Date()) =>
  d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) + ' ' + d.getUTCFullYear();
