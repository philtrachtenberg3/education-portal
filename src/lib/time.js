'use strict';
// Time-zone-safe formatting and recurrence expansion.
// Deadlines are stored as UTC instants and never shifted; class meetings are
// stored as local wall-clock time in the course's zone and expanded per date.

const { DateTime, Interval } = require('luxon');

function dt(iso, tz) {
  return DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz);
}

// "Tue 4 Nov, 11:59 PM EST"
function fmtDateTime(iso, tz) {
  if (!iso) return '';
  return dt(iso, tz).toFormat("ccc d LLL yyyy, h:mm a ZZZZ");
}

function fmtDate(iso, tz) {
  if (!iso) return '';
  return dt(iso, tz).toFormat('ccc d LLL yyyy');
}

function fmtTime(iso, tz) {
  return dt(iso, tz).toFormat('h:mm a');
}

function fmtTimeRange(startIso, endIso, tz) {
  return `${fmtTime(startIso, tz)}–${dt(endIso, tz).toFormat('h:mm a ZZZZ')}`;
}

// Human relative phrase for deadlines, e.g. "in 2 days", "3 hours ago".
function relative(iso, now = DateTime.utc()) {
  return DateTime.fromISO(iso, { zone: 'utc' }).toRelative({ base: now });
}

// Value for <input type="datetime-local"> in the given zone.
function toLocalInput(iso, tz) {
  if (!iso) return '';
  return dt(iso, tz).toFormat("yyyy-LL-dd'T'HH:mm");
}

// Parse a datetime-local value entered in `tz` into a UTC ISO string.
function fromLocalInput(value, tz) {
  if (!value) return null;
  const d = DateTime.fromISO(value, { zone: tz });
  if (!d.isValid) return null;
  return d.toUTC().toISO();
}

function isValidZone(tz) {
  return DateTime.local().setZone(tz).isValid;
}

/**
 * Expand recurring class meetings into concrete occurrences between two UTC instants.
 * Each occurrence is computed from the meeting's own local time and zone, so a
 * 10:00 lecture stays at 10:00 local time across daylight-saving changes.
 */
function expandMeetings(meetings, exceptions, fromIso, toIso) {
  const from = DateTime.fromISO(fromIso, { zone: 'utc' });
  const to = DateTime.fromISO(toIso, { zone: 'utc' });
  const exByKey = new Map(exceptions.map((e) => [`${e.meeting_id}|${e.date}`, e]));
  const out = [];
  for (const m of meetings) {
    const first = DateTime.fromISO(m.first_date, { zone: m.timezone });
    const last = DateTime.fromISO(m.last_date, { zone: m.timezone }).endOf('day');
    const startDay = DateTime.max(first, from.setZone(m.timezone).startOf('day').minus({ days: 1 }));
    const endDay = DateTime.min(last, to.setZone(m.timezone).endOf('day'));
    if (startDay > endDay) continue;
    let day = startDay.startOf('day');
    // advance to the first matching weekday
    while (day.weekday !== m.weekday) day = day.plus({ days: 1 });
    for (; day <= endDay; day = day.plus({ weeks: 1 })) {
      const [sh, sm] = m.start_time.split(':').map(Number);
      const [eh, em] = m.end_time.split(':').map(Number);
      const start = day.set({ hour: sh, minute: sm });
      const end = day.set({ hour: eh, minute: em });
      if (end.toUTC() < from || start.toUTC() > to) continue;
      const date = day.toISODate();
      const ex = exByKey.get(`${m.id}|${date}`);
      out.push({
        type: 'meeting',
        meeting: m,
        date,
        start: start.toUTC().toISO(),
        end: end.toUTC().toISO(),
        cancelled: ex?.status === 'cancelled',
        changed: ex?.status === 'changed',
        location: ex?.status === 'changed' && ex.location ? ex.location : m.location,
        note: ex?.note || null,
      });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

// Monday 00:00 of the week containing `isoDate` in `tz`, as a DateTime.
function weekStart(isoDate, tz) {
  const base = isoDate ? DateTime.fromISO(isoDate, { zone: tz }) : DateTime.now().setZone(tz);
  return (base.isValid ? base : DateTime.now().setZone(tz)).startOf('week');
}

module.exports = {
  DateTime, Interval, dt, fmtDateTime, fmtDate, fmtTime, fmtTimeRange, relative,
  toLocalInput, fromLocalInput, isValidZone, expandMeetings, weekStart,
};
