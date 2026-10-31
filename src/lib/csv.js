'use strict';
// Minimal RFC 4180 CSV parse/serialise used for the admin import/export boundary.

function parse(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!nonEmpty.length) return { header: [], records: [] };
  const header = nonEmpty[0].map((h) => h.trim().toLowerCase());
  const records = nonEmpty.slice(1).map((r, idx) => ({ line: idx + 2, ...Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])) }));
  return { header, records };
}

// Quotes fields as needed and neutralises spreadsheet formula injection.
function cell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function stringify(header, rows) {
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { parse, stringify };
