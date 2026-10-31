'use strict';
const express = require('express');
const { db } = require('../db');
const { requireRole, requireLogin } = require('../lib/auth');
const cw = require('../lib/coursework');
const { calendarItems, nextMeeting, toIcs, TYPE_INFO } = require('../lib/calendar');
const { weekStart, DateTime } = require('../lib/time');

const router = express.Router();
const student = requireRole('student');

// Recent course activity relevant to this student: announcements, new/updated
// materials, due-date changes and released feedback.
function recentUpdates(studentId, courses, days = 21) {
  if (!courses.length) return [];
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const ids = courses.map((c) => c.id);
  const ph = ids.map(() => '?').join(',');
  const byId = new Map(courses.map((c) => [c.id, c]));
  const out = [];
  for (const a of db.prepare(`SELECT * FROM announcements WHERE course_id IN (${ph}) AND published = 1 AND created_at > ?`).all(...ids, since)) {
    out.push({ when: a.created_at, kind: 'Announcement', icon: '✉', title: a.title, course: byId.get(a.course_id), link: `/courses/${a.course_id}#announcement-${a.id}` });
  }
  for (const r of db.prepare(`SELECT * FROM resources WHERE course_id IN (${ph}) AND published = 1 AND updated_at > ?`).all(...ids, since)) {
    out.push({ when: r.updated_at, kind: r.created_at === r.updated_at ? 'New material' : 'Updated material', icon: '❏', title: r.title, course: byId.get(r.course_id), link: `/courses/${r.course_id}/materials#resource-${r.id}` });
  }
  for (const e of db.prepare(`
      SELECT ae.*, a.title, a.id AS aid FROM audit_events ae JOIN assignments a ON a.id = ae.entity_id
      WHERE ae.action = 'assignment.due_changed' AND ae.course_id IN (${ph}) AND ae.created_at > ? AND a.published = 1`).all(...ids, since)) {
    out.push({ when: e.created_at, kind: 'Due date changed', icon: '⚑', title: e.title, course: byId.get(e.course_id), link: `/courses/${e.course_id}/assignments/${e.aid}` });
  }
  for (const g of db.prepare(`
      SELECT g.*, a.title, a.course_id FROM grades g JOIN assignments a ON a.id = g.assignment_id
      WHERE g.student_id = ? AND g.released = 1 AND g.released_at > ? AND a.course_id IN (${ph})`).all(studentId, since, ...ids)) {
    out.push({ when: g.released_at, kind: 'Feedback returned', icon: '★', title: g.title, course: byId.get(g.course_id), link: `/courses/${g.course_id}/assignments/${g.assignment_id}#feedback` });
  }
  for (const e of db.prepare(`
      SELECT ae.created_at, a.title, a.id AS aid, a.course_id FROM audit_events ae
      JOIN submissions s ON s.id = ae.entity_id JOIN assignments a ON a.id = s.assignment_id
      JOIN submission_credits sc ON sc.submission_id = s.id AND sc.student_id = ?
      WHERE ae.action = 'submission.returned' AND ae.created_at > ?`).all(studentId, since)) {
    out.push({ when: e.created_at, kind: 'Returned for revision', icon: '↺', title: e.title, course: byId.get(e.course_id), link: `/courses/${e.course_id}/assignments/${e.aid}` });
  }
  return out.filter((u) => u.course).sort((a, b) => b.when.localeCompare(a.when));
}

// ---------- Dashboard "Upcoming" panel ----------

const DUE_RANGES = { '3d': 'Next 3 days', '7d': 'Next 7 days', '30d': 'Next 30 days', all: 'All upcoming', custom: 'Custom dates' };
const CLASS_SPANS = { '7d': 'Next 7 days', '30d': 'Next 30 days', all: 'Whole course' };
const DUE_KEYS = ['due', 'range', 'from', 'to', 'course', 'span'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Filters for the dashboard's upcoming-work card: "by date" with a date range, or
 * "by class" with a course and span. Choices come from the query string, or from
 * the cookie that remembers the last choice.
 */
function duePanel(req, res, items, courses) {
  const tz = req.user.timezone;
  const now = DateTime.now().setZone(tz);
  const nowIso = now.toUTC().toISO();
  const fromQuery = DUE_KEYS.some((k) => k in req.query);
  let src = req.query;
  if (!fromQuery) {
    const saved = /(?:^|;\s*)slp_due=([^;]*)/.exec(req.headers.cookie || '')?.[1];
    try { src = saved ? Object.fromEntries(new URLSearchParams(decodeURIComponent(saved))) : {}; } catch { src = {}; }
  }
  const s = {
    due: src.due === 'class' ? 'class' : 'date',
    range: DUE_RANGES[src.range] ? src.range : '7d',
    from: ISO_DATE.test(src.from) ? src.from : '',
    to: ISO_DATE.test(src.to) ? src.to : '',
    course: courses.find((c) => String(c.id) === String(src.course))?.id || '',
    span: CLASS_SPANS[src.span] ? src.span : '7d',
  };
  const query = (o = {}) => {
    const merged = { ...s, ...o };
    return new URLSearchParams(Object.entries(merged).filter(([, v]) => v !== '' && v != null)).toString();
  };
  if (fromQuery) res.cookie('slp_due', query(), { httpOnly: true, sameSite: 'lax', maxAge: 365 * 864e5 });

  const fmtDay = (d) => d.toFormat('ccc d LLL');
  const within = (start, end) => (i) => i.due_at >= start.toUTC().toISO() && (!end || i.due_at <= end.toUTC().toISO());
  const out = { s, href: (o) => `/dashboard?${query(o)}`, RANGES: DUE_RANGES, SPANS: CLASS_SPANS, courses, error: null };

  if (s.due === 'date') {
    let start = now;
    let end = null;
    let phrase;
    if (['3d', '7d', '30d'].includes(s.range)) {
      end = now.plus({ days: parseInt(s.range, 10) });
      phrase = `in the ${DUE_RANGES[s.range].toLowerCase()}`;
    } else if (s.range === 'custom') {
      if (s.from) start = DateTime.fromISO(s.from, { zone: tz }).startOf('day');
      if (s.to) end = DateTime.fromISO(s.to, { zone: tz }).endOf('day');
      if (end && end < start) {
        out.error = 'The end date is before the start date.';
        end = start.endOf('day');
      }
      phrase = end ? `between ${fmtDay(start)} and ${fmtDay(end)}` : `from ${fmtDay(start)} onwards`;
    } else {
      phrase = 'in all your courses';
    }
    out.list = items.filter(within(start, end));
    out.summary = `${out.list.length} item${out.list.length === 1 ? '' : 's'} due ${phrase}`;
    return out;
  }

  const end = s.span === 'all' ? null : now.plus({ days: s.span === '7d' ? 7 : 30 });
  const shown = s.course ? courses.filter((c) => c.id === s.course) : courses;
  out.groups = shown.map((c) => {
    const mine = items.filter((i) => i.course_id === c.id);
    return {
      course: c,
      upcoming: mine.filter((i) => i.due_at >= nowIso && (!end || i.due_at <= end.toUTC().toISO())),
      earlier: s.span === 'all' ? mine.filter((i) => i.due_at < nowIso).reverse() : [],
    };
  });
  const n = out.groups.reduce((t, g) => t + g.upcoming.length, 0);
  const where = s.course ? shown[0].code : 'all classes';
  out.summary = s.span === 'all'
    ? `${n} upcoming in ${where}, plus ${out.groups.reduce((t, g) => t + g.earlier.length, 0)} earlier`
    : `${n} due in ${where} in the ${CLASS_SPANS[s.span].toLowerCase()}`;
  return out;
}

router.get('/dashboard', student, (req, res) => {
  const now = new Date().toISOString();
  const weekEnd = new Date(Date.now() + 7 * 864e5).toISOString();
  const courses = cw.activeStudentCourses(req.user.id);
  const items = cw.studentAssignments(req.user.id);
  const upcoming = items.filter((i) => i.due_at >= now);
  const due = duePanel(req, res, items, courses);
  const pastDue = items.filter((i) => i.state.status === 'missing');
  const thisWeek = upcoming.filter((i) => i.due_at <= weekEnd);
  const recentlyGraded = items
    .filter((i) => i.state.grade?.released_at && i.state.grade.released_at >= new Date(Date.now() - 7 * 864e5).toISOString())
    .sort((a, b) => b.state.grade.released_at.localeCompare(a.state.grade.released_at));

  const snapshot = courses.map((c) => {
    const courseItems = items.filter((i) => i.course_id === c.id);
    const latest = courseItems.filter((i) => i.state.grade).sort((a, b) => (b.state.grade.released_at || '').localeCompare(a.state.grade.released_at || ''))[0];
    return { course: c, total: cw.provisionalTotal(c, courseItems), latest };
  });

  res.render('student/dashboard', {
    title: 'Dashboard', courses, due, pastDue, thisWeek, recentlyGraded, snapshot,
    next: nextMeeting(courses),
    updates: recentUpdates(req.user.id, courses).slice(0, 6),
  });
});

const PAGE = 20;

router.get('/assignments', student, (req, res) => {
  const now = new Date().toISOString();
  const courses = cw.activeStudentCourses(req.user.id);
  const courseId = Number(req.query.course) || null;
  const status = ['upcoming', 'todo', 'missing', 'completed', 'all'].includes(req.query.status) ? req.query.status : 'upcoming';
  const { from, to } = req.query;
  let items = cw.studentAssignments(req.user.id, { courseId: courses.some((c) => c.id === courseId) ? courseId : null });
  const done = (i) => ['graded', 'excused', 'submitted', 'late', 'resubmitted'].includes(i.state.status);
  if (status === 'upcoming') items = items.filter((i) => i.due_at >= now);
  if (status === 'todo') items = items.filter((i) => !done(i) && i.state.status !== 'missing');
  if (status === 'missing') items = items.filter((i) => i.state.status === 'missing');
  if (status === 'completed') items = items.filter(done).reverse();
  const tz = req.user.timezone;
  if (from) items = items.filter((i) => i.due_at >= DateTime.fromISO(from, { zone: tz }).toUTC().toISO());
  if (to) items = items.filter((i) => i.due_at <= DateTime.fromISO(to, { zone: tz }).endOf('day').toUTC().toISO());
  const page = Math.max(1, Number(req.query.page) || 1);
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  res.render('student/assignments', {
    title: 'Assignments', courses, items: items.slice((page - 1) * PAGE, page * PAGE), total: items.length,
    filters: { course: courseId, status, from: from || '', to: to || '' }, page, pages,
  });
});

router.get('/calendar', student, (req, res) => {
  const tz = req.user.timezone;
  const courses = cw.activeStudentCourses(req.user.id);
  const courseId = Number(req.query.course) || null;
  const shown = courseId ? courses.filter((c) => c.id === courseId) : courses;
  const view = req.query.view === 'list' ? 'list' : 'week';
  const start = view === 'week' ? weekStart(req.query.week, tz) : DateTime.now().setZone(tz).startOf('day');
  const end = view === 'week' ? start.plus({ days: 7 }) : start.plus({ days: 28 });
  const items = calendarItems(shown, start.toUTC().toISO(), end.toUTC().toISO());
  const days = [];
  for (let d = start; d < end; d = d.plus({ days: 1 })) {
    const dayEnd = d.endOf('day').toUTC().toISO();
    const dayStart = d.toUTC().toISO();
    days.push({ date: d, today: d.hasSame(DateTime.now().setZone(tz), 'day'), items: items.filter((i) => i.start >= dayStart && i.start <= dayEnd) });
  }
  res.render('student/calendar', {
    title: 'Timetable & calendar', courses, courseId, view, days, start, TYPE_INFO,
    prevWeek: start.minus({ weeks: 1 }).toISODate(), nextWeek: start.plus({ weeks: 1 }).toISODate(),
    isThisWeek: start.hasSame(DateTime.now().setZone(tz), 'week'),
  });
});

// Downloadable calendar feed (meetings, deadlines, exams) for this user's courses.
router.get('/calendar.ics', requireLogin, (req, res) => {
  const courses = req.user.role === 'instructor' ? cw.instructorCourses(req.user.id) : cw.activeStudentCourses(req.user.id);
  const from = new Date(Date.now() - 14 * 864e5).toISOString();
  const to = new Date(Date.now() + 150 * 864e5).toISOString();
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="learning-portal.ics"');
  res.send(toIcs(calendarItems(courses, from, to), 'Learning Portal'));
});

router.get('/grades', student, (req, res) => {
  const courses = cw.activeStudentCourses(req.user.id);
  const items = cw.studentAssignments(req.user.id);
  const sections = courses.map((c) => {
    const rows = items.filter((i) => i.course_id === c.id);
    return { course: c, rows, total: cw.provisionalTotal(c, rows) };
  });
  res.render('student/grades', { title: 'Grades', sections });
});

router.get('/courses', requireLogin, (req, res) => {
  const now = new Date().toISOString();
  const courses = req.user.role === 'instructor' ? cw.instructorCourses(req.user.id) : cw.activeStudentCourses(req.user.id);
  const instructorsStmt = db.prepare(`
    SELECT u.name FROM enrollments e JOIN users u ON u.id = e.user_id
    WHERE e.course_id = ? AND e.role = 'instructor' AND e.status = 'active' ORDER BY u.name`);
  const nextDueStmt = db.prepare(`SELECT * FROM assignments WHERE course_id = ? AND published = 1 AND due_at >= ? ORDER BY due_at LIMIT 1`);
  const rows = courses.map((c) => ({
    course: c,
    instructors: instructorsStmt.all(c.id).map((r) => r.name),
    nextMeeting: nextMeeting([c]),
    nextDue: nextDueStmt.get(c.id, now),
  }));
  res.render('courses', { title: 'Courses', rows });
});

module.exports = router;
