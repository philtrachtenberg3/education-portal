'use strict';
// Combines class meetings, deadlines and dated events into one typed list.
// Each item keeps its type so views can label meetings, deadlines, exams and
// events with text and icons — never colour alone.

const { db } = require('../db');
const { expandMeetings } = require('./time');

const TYPE_INFO = {
  meeting: { label: 'Class', icon: '▣' },
  deadline: { label: 'Due', icon: '⚑' },
  exam: { label: 'Exam', icon: '✎' },
  event: { label: 'Event', icon: '◆' },
};

/**
 * @param {object[]} courses courses with id/code/title/color
 * @param {string} fromIso @param {string} toIso
 * @param {{includeUnpublished?: boolean}} opts instructors see draft items
 */
function calendarItems(courses, fromIso, toIso, { includeUnpublished = false } = {}) {
  if (!courses.length) return [];
  const ids = courses.map((c) => c.id);
  const byId = new Map(courses.map((c) => [c.id, c]));
  const ph = ids.map(() => '?').join(',');

  const meetings = db.prepare(`SELECT * FROM class_meetings WHERE course_id IN (${ph})`).all(...ids);
  const exceptions = meetings.length
    ? db.prepare(`SELECT * FROM meeting_exceptions WHERE meeting_id IN (${meetings.map(() => '?').join(',')})`).all(...meetings.map((m) => m.id))
    : [];
  const items = expandMeetings(meetings, exceptions, fromIso, toIso).map((o) => ({
    type: 'meeting', course: byId.get(o.meeting.course_id), title: o.meeting.title, subtype: o.meeting.kind,
    start: o.start, end: o.end, location: o.location, url: o.meeting.meeting_url,
    cancelled: o.cancelled, changed: o.changed, note: o.note, meetingId: o.meeting.id, date: o.date,
  }));

  const pub = includeUnpublished ? '' : 'AND published = 1';
  for (const a of db.prepare(`SELECT * FROM assignments WHERE course_id IN (${ph}) AND due_at BETWEEN ? AND ? ${pub}`).all(...ids, fromIso, toIso)) {
    items.push({
      type: 'deadline', course: byId.get(a.course_id), title: a.title, subtype: a.kind, start: a.due_at, end: a.due_at,
      link: `/courses/${a.course_id}/assignments/${a.id}`, assignment: a, draft: !a.published,
    });
  }
  for (const e of db.prepare(`SELECT * FROM events WHERE course_id IN (${ph}) AND starts_at < ? AND ends_at > ? ${pub}`).all(...ids, toIso, fromIso)) {
    items.push({
      type: e.kind, course: byId.get(e.course_id), title: e.title, start: e.starts_at, end: e.ends_at,
      location: e.location, url: e.meeting_url, draft: !e.published, eventId: e.id,
    });
  }
  return items.sort((a, b) => a.start.localeCompare(b.start) || a.type.localeCompare(b.type));
}

function nextMeeting(courses, now = new Date()) {
  const to = new Date(now.getTime() + 14 * 864e5).toISOString();
  return calendarItems(courses, now.toISOString(), to)
    .find((i) => i.type === 'meeting' && !i.cancelled && i.end > now.toISOString()) || null;
}

// Minimal RFC 5545 export. Each occurrence is exported as a UTC event so
// external calendars show the correct local time regardless of DST.
function toIcs(items, calName) {
  const esc = (s) => String(s || '').replace(/[\\;,]/g, (m) => '\\' + m).replace(/\n/g, '\\n');
  const stamp = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Student Learning Portal//EN', `X-WR-CALNAME:${esc(calName)}`];
  const now = stamp(new Date().toISOString());
  for (const i of items) {
    if (i.cancelled) continue;
    const uid = `${i.type}-${i.meetingId || i.assignment?.id || i.eventId}-${stamp(i.start)}@slp`;
    const prefix = `${i.course.code} ${TYPE_INFO[i.type].label}: `;
    lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${now}`, `DTSTART:${stamp(i.start)}`,
      `DTEND:${stamp(i.type === 'deadline' ? new Date(Date.parse(i.start) + 60e3).toISOString() : i.end)}`,
      `SUMMARY:${esc(prefix + i.title)}`);
    if (i.location) lines.push(`LOCATION:${esc(i.location)}`);
    if (i.url) lines.push(`URL:${esc(i.url)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

module.exports = { calendarItems, nextMeeting, toIcs, TYPE_INFO };
