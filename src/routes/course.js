'use strict';
const express = require('express');
const { db, nowIso } = require('../db');
const { instructorOnly, notFound } = require('../lib/authz');
const { audit } = require('../lib/audit');
const { notify, courseStudentIds } = require('../lib/notify');
const { calendarItems, nextMeeting, TYPE_INFO } = require('../lib/calendar');
const { weekStart, fromLocalInput, DateTime } = require('../lib/time');
const cw = require('../lib/coursework');

const router = express.Router({ mergeParams: true });
const base = (req) => `/courses/${req.course.id}`;
const str = (v, max = 5000) => String(v ?? '').trim().slice(0, max);

router.get('/', (req, res) => {
  const c = req.course;
  const isInstructor = req.courseRole === 'instructor';
  const announcements = db.prepare(`
    SELECT a.*, u.name AS author FROM announcements a JOIN users u ON u.id = a.author_id
    WHERE a.course_id = ? ${isInstructor ? '' : 'AND a.published = 1'} ORDER BY a.created_at DESC`).all(c.id);
  const instructors = db.prepare(`
    SELECT u.name, u.email FROM enrollments e JOIN users u ON u.id = e.user_id
    WHERE e.course_id = ? AND e.role = 'instructor' AND e.status = 'active'`).all(c.id);
  const now = nowIso();
  const upcoming = isInstructor
    ? db.prepare('SELECT * FROM assignments WHERE course_id = ? AND due_at >= ? ORDER BY due_at LIMIT 4').all(c.id, now)
    : cw.studentAssignments(req.user.id, { courseId: c.id }).filter((a) => a.due_at >= now).slice(0, 4);
  res.render('course/overview', { title: c.title, tab: 'overview', announcements, instructors, upcoming, next: nextMeeting([c]) });
});

router.post('/nickname', (req, res) => {
  const nickname = str(req.body.nickname, 60) || null;
  db.prepare('UPDATE enrollments SET nickname = ? WHERE user_id = ? AND course_id = ?').run(nickname, req.user.id, req.course.id);
  req.flash('success', nickname ? `Nickname set to “${nickname}”. The official course name is still shown alongside it.` : 'Nickname removed.');
  res.redirect(base(req));
});

router.post('/overview', instructorOnly, (req, res) => {
  const before = { description: req.course.description, grading_policy: req.course.grading_policy, show_total: req.course.show_total };
  const after = { description: str(req.body.description), grading_policy: str(req.body.grading_policy, 2000), show_total: req.body.show_total ? 1 : 0 };
  db.prepare('UPDATE courses SET description = ?, grading_policy = ?, show_total = ? WHERE id = ?')
    .run(after.description, after.grading_policy, after.show_total, req.course.id);
  if (before.show_total !== after.show_total) {
    audit({ actorId: req.user.id, action: 'course.total_visibility', entityType: 'course', entityId: req.course.id, courseId: req.course.id, before: { show_total: before.show_total }, after: { show_total: after.show_total } });
  }
  req.flash('success', 'Course overview saved.');
  res.redirect(base(req));
});

router.post('/announcements', instructorOnly, (req, res) => {
  const title = str(req.body.title, 200);
  const body = str(req.body.body);
  if (!title || !body) {
    req.flash('error', 'An announcement needs both a title and a message.');
    return res.redirect(`${base(req)}#new-announcement`);
  }
  const published = req.body.publish ? 1 : 0;
  const info = db.prepare('INSERT INTO announcements (course_id, author_id, title, body, published, created_at) VALUES (?,?,?,?,?,?)')
    .run(req.course.id, req.user.id, title, body, published, nowIso());
  if (published) announce(req, info.lastInsertRowid, title);
  req.flash('success', published ? 'Announcement posted and students notified.' : 'Announcement saved as a draft. Students cannot see it yet.');
  res.redirect(base(req));
});

function announce(req, id, title) {
  notify(courseStudentIds(req.course.id), {
    kind: 'announcement', title: `Announcement: ${title}`, link: `${base(req)}#announcement-${id}`,
    courseId: req.course.id, dedupeKey: `announcement:${id}`,
  });
}

router.post('/announcements/:id/publish', instructorOnly, (req, res) => {
  const a = db.prepare('SELECT * FROM announcements WHERE id = ? AND course_id = ?').get(req.params.id, req.course.id);
  if (!a) return notFound(res);
  const published = a.published ? 0 : 1;
  db.prepare('UPDATE announcements SET published = ?, created_at = CASE WHEN ? = 1 THEN ? ELSE created_at END WHERE id = ?')
    .run(published, published, nowIso(), a.id);
  audit({ actorId: req.user.id, action: published ? 'announcement.published' : 'announcement.unpublished', entityType: 'announcement', entityId: a.id, courseId: req.course.id });
  if (published) announce(req, a.id, a.title);
  req.flash('success', published ? 'Announcement published.' : 'Announcement hidden from students.');
  res.redirect(base(req));
});

router.get('/schedule', (req, res) => {
  const tz = req.user.timezone;
  const isInstructor = req.courseRole === 'instructor';
  const start = weekStart(req.query.week, tz);
  const end = start.plus({ days: 7 });
  const items = calendarItems([req.course], start.toUTC().toISO(), end.toUTC().toISO(), { includeUnpublished: isInstructor });
  const days = [];
  for (let d = start; d < end; d = d.plus({ days: 1 })) {
    const s = d.toUTC().toISO();
    const e = d.endOf('day').toUTC().toISO();
    days.push({ date: d, today: d.hasSame(DateTime.now().setZone(tz), 'day'), items: items.filter((i) => i.start >= s && i.start <= e) });
  }
  const meetings = db.prepare('SELECT * FROM class_meetings WHERE course_id = ? ORDER BY weekday, start_time').all(req.course.id);
  const upcomingEvents = db.prepare(`SELECT * FROM events WHERE course_id = ? AND ends_at >= ? ${isInstructor ? '' : 'AND published = 1'} ORDER BY starts_at`).all(req.course.id, nowIso());
  const exceptions = db.prepare(`
    SELECT x.*, m.title AS meeting_title FROM meeting_exceptions x JOIN class_meetings m ON m.id = x.meeting_id
    WHERE m.course_id = ? ORDER BY x.date`).all(req.course.id);
  res.render('course/schedule', {
    title: `Schedule · ${req.course.code}`, tab: 'schedule', days, start, meetings, upcomingEvents, exceptions, TYPE_INFO,
    prevWeek: start.minus({ weeks: 1 }).toISODate(), nextWeek: start.plus({ weeks: 1 }).toISODate(),
    isThisWeek: start.hasSame(DateTime.now().setZone(tz), 'week'),
    WEEKDAYS: ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  });
});

router.post('/schedule/events', instructorOnly, (req, res) => {
  const tz = req.user.timezone;
  const startsAt = fromLocalInput(req.body.starts_at, tz);
  const endsAt = fromLocalInput(req.body.ends_at, tz);
  const title = str(req.body.title, 200);
  const kind = req.body.kind === 'exam' ? 'exam' : 'event';
  if (!title || !startsAt || !endsAt || endsAt <= startsAt) {
    req.flash('error', 'Give the event a title and an end time after its start time.');
    return res.redirect(`${base(req)}/schedule#add-event`);
  }
  const info = db.prepare('INSERT INTO events (course_id, title, kind, starts_at, ends_at, location, meeting_url, published) VALUES (?,?,?,?,?,?,?,1)')
    .run(req.course.id, title, kind, startsAt, endsAt, str(req.body.location, 200), str(req.body.meeting_url, 500) || null);
  notify(courseStudentIds(req.course.id), {
    kind: 'event', title: `${kind === 'exam' ? 'Exam' : 'Event'} scheduled: ${title}`, link: `${base(req)}/schedule`,
    courseId: req.course.id, dedupeKey: `event:${info.lastInsertRowid}`,
  });
  req.flash('success', `${kind === 'exam' ? 'Exam' : 'Event'} added to the course schedule.`);
  res.redirect(`${base(req)}/schedule`);
});

// Cancel or relocate one occurrence of a recurring class meeting.
router.post('/schedule/exceptions', instructorOnly, (req, res) => {
  const meeting = db.prepare('SELECT * FROM class_meetings WHERE id = ? AND course_id = ?').get(req.body.meeting_id, req.course.id);
  const date = str(req.body.date, 10);
  const d = DateTime.fromISO(date, { zone: meeting?.timezone || 'UTC' });
  if (!meeting || !d.isValid || d.weekday !== meeting.weekday || date < meeting.first_date || date > meeting.last_date) {
    req.flash('error', 'Choose a date on which that class actually meets.');
    return res.redirect(`${base(req)}/schedule#change-meeting`);
  }
  const status = req.body.status === 'changed' ? 'changed' : 'cancelled';
  db.prepare(`INSERT INTO meeting_exceptions (meeting_id, date, status, location, note) VALUES (?,?,?,?,?)
              ON CONFLICT (meeting_id, date) DO UPDATE SET status = excluded.status, location = excluded.location, note = excluded.note`)
    .run(meeting.id, date, status, str(req.body.location, 200) || null, str(req.body.note, 300) || null);
  audit({ actorId: req.user.id, action: `meeting.${status}`, entityType: 'class_meeting', entityId: meeting.id, courseId: req.course.id, after: { date, location: req.body.location || null } });
  notify(courseStudentIds(req.course.id), {
    kind: 'schedule', title: `${meeting.title} on ${d.toFormat('ccc d LLL')} ${status === 'cancelled' ? 'is cancelled' : 'has changed'}`,
    link: `${base(req)}/schedule?week=${date}`, courseId: req.course.id, dedupeKey: `meeting:${meeting.id}:${date}:${status}:${req.body.location || ''}`,
  });
  req.flash('success', `Class on ${d.toFormat('ccc d LLL')} marked as ${status}. Students have been notified.`);
  res.redirect(`${base(req)}/schedule?week=${date}`);
});

module.exports = router;
