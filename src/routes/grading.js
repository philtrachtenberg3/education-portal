'use strict';
const express = require('express');
const { db, nowIso } = require('../db');
const { instructorOnly, loadAssignment, notFound } = require('../lib/authz');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const cw = require('../lib/coursework');
const csv = require('../lib/csv');

const router = express.Router({ mergeParams: true });
router.param('aid', loadAssignment);

const base = (req) => `/courses/${req.course.id}/assignments/${req.assignment.id}`;
const str = (v, max = 10000) => String(v ?? '').trim().slice(0, max);

// ---------- Submissions list ----------

router.get('/assignments/:aid/submissions', instructorOnly, (req, res) => {
  const a = req.assignment;
  const status = String(req.query.status || '');
  const q = str(req.query.q, 100).toLowerCase();
  const sort = req.query.sort === 'time' ? 'time' : 'name';
  let rows = cw.submissionRoster(a).map((r) => ({ ...r, status: cw.rosterRowStatus(r, a) }));
  const counts = rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  if (status === 'needs_grading') rows = rows.filter((r) => ['submitted', 'late', 'resubmitted'].includes(r.status));
  else if (status) rows = rows.filter((r) => r.status === status);
  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.members.some((m) => m.name.toLowerCase().includes(q)));
  if (sort === 'time') rows.sort((x, y) => (y.submission?.last_submitted_at || '').localeCompare(x.submission?.last_submitted_at || ''));
  const unreleased = db.prepare('SELECT COUNT(*) AS n FROM grades WHERE assignment_id = ? AND released = 0 AND (points IS NOT NULL OR excused = 1)').get(a.id).n;
  res.render('course/submissions', { title: `Submissions · ${a.title}`, tab: 'assignments', rows, counts, filters: { status, q, sort }, unreleased, ROSTER_LABEL: cw.ROSTER_LABEL });
});

// ---------- Grade one student / group ----------

/** Resolve a roster key (s<studentId> or g<groupId>) into the people being graded. */
function resolveTarget(req) {
  const a = req.assignment;
  const m = /^([sg])(\d+)$/.exec(req.params.key || '');
  if (!m) return null;
  const id = Number(m[2]);
  if (m[1] === 's') {
    const student = db.prepare(`SELECT u.id, u.name, u.email FROM enrollments e JOIN users u ON u.id = e.user_id
      WHERE e.course_id = ? AND e.user_id = ? AND e.role = 'student'`).get(req.course.id, id);
    if (!student) return null;
    const { submission } = cw.submissionForStudent(a, id);
    return { key: req.params.key, type: 'student', name: student.name, members: [student], submission };
  }
  const group = a.group_set_id && db.prepare('SELECT * FROM groups WHERE id = ? AND group_set_id = ?').get(id, a.group_set_id);
  if (!group) return null;
  const submission = db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND group_id = ?').get(a.id, id);
  return { key: req.params.key, type: 'group', group, name: group.name, members: submission ? cw.creditedStudents(submission.id) : cw.groupMembers(id), submission };
}

function renderGrader(req, res, target, { errors = [], status = 200 } = {}) {
  const a = req.assignment;
  const grades = Object.fromEntries(target.members.map((m) => [m.id, cw.gradeFor(a.id, m.id, { releasedOnly: false })]));
  // Prefill the shared score with the most common member score; differing members show as overrides.
  const tally = new Map();
  for (const g of Object.values(grades)) if (g?.points != null) tally.set(g.points, (tally.get(g.points) || 0) + 1);
  const sharedPoints = [...tally.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  const firstFeedback = Object.values(grades).find((g) => g?.feedback)?.feedback || '';
  const roster = cw.submissionRoster(a);
  const idx = roster.findIndex((r) => r.key === target.key);
  const history = db.prepare(`
    SELECT ae.*, u.name AS actor FROM audit_events ae LEFT JOIN users u ON u.id = ae.actor_id
    WHERE ae.course_id = ? AND ((ae.entity_type = 'grade' AND ae.entity_id IN (SELECT id FROM grades WHERE assignment_id = ? AND student_id IN (${target.members.map(() => '?').join(',') || 'NULL'})))
      OR (ae.entity_type = 'submission' AND ae.entity_id = ?))
    ORDER BY ae.created_at DESC LIMIT 30`).all(req.course.id, a.id, ...target.members.map((m) => m.id), target.submission?.id ?? -1);
  res.status(status).render('course/grade', {
    title: `Grade · ${target.name}`, tab: 'assignments', target, grades, sharedPoints, firstFeedback, errors,
    versions: target.submission ? cw.versionsFor(target.submission.id) : [],
    shared: target.type === 'group' && a.group_grading === 'shared',
    prev: roster[idx - 1], next: roster[idx + 1], history, nameOf: Object.fromEntries(target.members.map((m) => [m.id, m.name])),
  });
}

router.get('/assignments/:aid/grade/:key', instructorOnly, (req, res) => {
  const target = resolveTarget(req);
  if (!target) return notFound(res);
  renderGrader(req, res, target);
});

router.post('/assignments/:aid/grade/:key', instructorOnly, (req, res) => {
  const a = req.assignment;
  const target = resolveTarget(req);
  if (!target) return notFound(res);
  if (!target.members.length) {
    return renderGrader(req, res, target, { errors: ['This group has no members to grade.'], status: 400 });
  }
  const action = ['save', 'release', 'return'].includes(req.body.action) ? req.body.action : 'save';
  const shared = target.type === 'group' && a.group_grading === 'shared';
  const parsePoints = (raw) => (raw === '' || raw == null ? null : Number(raw));
  const errors = [];
  const sharedPoints = shared ? parsePoints(str(req.body.shared_points, 20)) : null;
  const sharedFeedback = shared ? str(req.body.shared_feedback) : '';

  const desired = target.members.map((m) => {
    const own = parsePoints(str(req.body[`points_${m.id}`], 20));
    const ownFeedback = str(req.body[`feedback_${m.id}`]);
    const d = {
      student: m,
      excused: req.body[`excused_${m.id}`] ? 1 : 0,
      points: own ?? sharedPoints,
      feedback: ownFeedback || sharedFeedback,
    };
    if (d.excused) d.points = null;
    if (d.points != null && (!Number.isFinite(d.points) || d.points < 0 || d.points > a.points * 2)) {
      errors.push(`${m.name}: points must be between 0 and ${a.points * 2}.`);
    }
    return d;
  });
  if (action === 'release' && desired.some((d) => d.points == null && !d.excused)) {
    errors.push('Enter a score (or mark as excused) for every student before releasing.');
  }
  if (action === 'return' && !target.submission) errors.push('There is no submission to return.');
  if (errors.length) return renderGrader(req, res, target, { errors, status: 400 });

  const reason = str(req.body.reason, 500) || null;
  const released = [];
  db.transaction(() => {
    const now = nowIso();
    for (const d of desired) {
      const old = cw.gradeFor(a.id, d.student.id, { releasedOnly: false });
      const wantReleased = action === 'release' ? 1 : 0;
      const changed = !old || old.points !== d.points || old.excused !== d.excused || old.feedback !== d.feedback || old.released !== wantReleased;
      if (!changed) continue;
      if (!old && d.points == null && !d.excused && !d.feedback) continue; // nothing entered
      db.prepare(`
        INSERT INTO grades (assignment_id, student_id, points, excused, feedback, released, released_at, grader_id, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT (assignment_id, student_id) DO UPDATE SET points = excluded.points, excused = excluded.excused,
          feedback = excluded.feedback, released = excluded.released,
          released_at = CASE WHEN excluded.released = 1 THEN excluded.released_at ELSE grades.released_at END,
          grader_id = excluded.grader_id, updated_at = excluded.updated_at`)
        .run(a.id, d.student.id, d.points, d.excused, d.feedback, wantReleased, wantReleased ? now : null, req.user.id, now);
      const g = cw.gradeFor(a.id, d.student.id, { releasedOnly: false });
      const summary = (x) => (x ? { points: x.points, excused: !!x.excused, released: !!x.released } : null);
      const feedbackChanged = (old?.feedback || '') !== d.feedback;
      audit({
        actorId: req.user.id, action: 'grade.saved', entityType: 'grade', entityId: g.id, courseId: req.course.id,
        before: summary(old), after: { ...summary(g), ...(feedbackChanged && { feedback_changed: true }) },
        reason: reason || (shared && target.type === 'group' ? `Shared group grade (${target.name})` : null),
      });
      if (wantReleased) released.push(g);
    }
    if (action === 'return') {
      db.prepare(`UPDATE submissions SET status = 'returned' WHERE id = ?`).run(target.submission.id);
      audit({ actorId: req.user.id, action: 'submission.returned', entityType: 'submission', entityId: target.submission.id, courseId: req.course.id, reason });
    }
  })();

  for (const g of released) {
    notify([g.student_id], {
      kind: 'grade_released', title: `Feedback available: ${a.title}`, link: `/courses/${req.course.id}/assignments/${a.id}#feedback`,
      courseId: req.course.id, dedupeKey: `grade:${g.id}:${g.updated_at}`,
    });
  }
  if (action === 'return') {
    notify(target.members.map((m) => m.id), {
      kind: 'returned', title: `Returned for revision: ${a.title}`, link: `/courses/${req.course.id}/assignments/${a.id}`,
      courseId: req.course.id, dedupeKey: `returned:${target.submission.id}:${nowIso().slice(0, 16)}`,
    });
  }
  const msg = { save: 'Grades saved. Students cannot see them until you release them.', release: 'Grades and feedback released to students.', return: 'Work returned for revision. Students can now resubmit.' }[action];
  req.flash('success', msg);
  const nextKey = req.body.go_next && req.body.next_key;
  res.redirect(nextKey && /^[sg]\d+$/.test(nextKey) ? `${base(req)}/grade/${nextKey}` : `${base(req)}/grade/${target.key}`);
});

// Release every graded-but-hidden grade for this assignment at once.
router.post('/assignments/:aid/release', instructorOnly, (req, res) => {
  const a = req.assignment;
  const pending = db.prepare('SELECT * FROM grades WHERE assignment_id = ? AND released = 0 AND (points IS NOT NULL OR excused = 1)').all(a.id);
  const now = nowIso();
  db.transaction(() => {
    for (const g of pending) {
      db.prepare('UPDATE grades SET released = 1, released_at = ? WHERE id = ?').run(now, g.id);
      audit({ actorId: req.user.id, action: 'grade.released', entityType: 'grade', entityId: g.id, courseId: req.course.id, before: { released: false }, after: { released: true } });
    }
  })();
  for (const g of pending) {
    notify([g.student_id], { kind: 'grade_released', title: `Feedback available: ${a.title}`, link: `/courses/${req.course.id}/assignments/${a.id}#feedback`, courseId: req.course.id, dedupeKey: `grade:${g.id}:${g.updated_at}` });
  }
  req.flash('success', `${pending.length} grade${pending.length === 1 ? '' : 's'} released.`);
  res.redirect(`${base(req)}/submissions`);
});

// ---------- Course grades tab ----------

function gradebook(course) {
  const students = db.prepare(`
    SELECT u.id, u.name, u.email FROM enrollments e JOIN users u ON u.id = e.user_id
    WHERE e.course_id = ? AND e.role = 'student' AND e.status = 'active' ORDER BY u.name`).all(course.id);
  const assignments = db.prepare('SELECT * FROM assignments WHERE course_id = ? AND published = 1 ORDER BY due_at').all(course.id);
  const cells = {};
  for (const s of students) {
    cells[s.id] = {};
    for (const a of assignments) {
      const { submission } = cw.submissionForStudent(a, s.id);
      const grade = cw.gradeFor(a.id, s.id, { releasedOnly: false });
      cells[s.id][a.id] = { submission, grade, key: a.group_set_id && submission?.group_id ? `g${submission.group_id}` : `s${s.id}` };
    }
  }
  return { students, assignments, cells };
}

router.get('/grades', (req, res) => {
  if (req.courseRole === 'instructor') {
    return res.render('course/gradebook', { title: `Gradebook · ${req.course.code}`, tab: 'grades', ...gradebook(req.course) });
  }
  const items = cw.studentAssignments(req.user.id, { courseId: req.course.id });
  res.render('course/grades', { title: `Grades · ${req.course.code}`, tab: 'grades', items, total: cw.provisionalTotal(req.course, items) });
});

router.get('/grades.csv', instructorOnly, (req, res) => {
  const { students, assignments, cells } = gradebook(req.course);
  const header = ['Student', 'Email', ...assignments.map((a) => `${a.title} (${a.points})`)];
  const rows = students.map((s) => [s.name, s.email, ...assignments.map((a) => {
    const c = cells[s.id][a.id];
    if (c.grade?.excused) return 'EX';
    if (c.grade?.points != null) return c.grade.points + (c.grade.released ? '' : ' (unreleased)');
    return c.submission ? 'Not graded' : 'Not submitted';
  })]);
  audit({ actorId: req.user.id, action: 'gradebook.exported', entityType: 'course', entityId: req.course.id, courseId: req.course.id });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${req.course.code.replace(/\W+/g, '-')}-grades.csv"`);
  res.send(csv.stringify(header, rows));
});

module.exports = router;
