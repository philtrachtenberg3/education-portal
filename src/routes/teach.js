'use strict';
const express = require('express');
const { db } = require('../db');
const { requireRole } = require('../lib/auth');
const cw = require('../lib/coursework');
const { calendarItems, TYPE_INFO } = require('../lib/calendar');

const router = express.Router();

// Submissions waiting on the grader: never graded, or changed since last grading.
const NEEDS_GRADING = `
  s.status IN ('submitted','late','resubmitted') AND EXISTS (
    SELECT 1 FROM submission_credits sc LEFT JOIN grades g ON g.assignment_id = s.assignment_id AND g.student_id = sc.student_id
    WHERE sc.submission_id = s.id AND (g.id IS NULL OR (g.points IS NULL AND g.excused = 0) OR g.updated_at < s.last_submitted_at))`;

router.get('/teach', requireRole('instructor'), (req, res) => {
  const courses = cw.instructorCourses(req.user.id);
  const ids = courses.map((c) => c.id);
  const ph = ids.map(() => '?').join(',') || 'NULL';
  const now = new Date();
  const upcoming = calendarItems(courses, now.toISOString(), new Date(now.getTime() + 7 * 864e5).toISOString(), { includeUnpublished: true })
    .filter((i) => i.type !== 'deadline');

  const toGrade = db.prepare(`
    SELECT a.id, a.title, a.due_at, a.course_id, a.group_set_id, c.code AS course_code, c.color AS course_color, COUNT(s.id) AS waiting
    FROM assignments a JOIN courses c ON c.id = a.course_id JOIN submissions s ON s.assignment_id = a.id
    WHERE a.course_id IN (${ph}) AND ${NEEDS_GRADING}
    GROUP BY a.id ORDER BY a.due_at`).all(...ids);

  const activity = db.prepare(`
    SELECT v.submitted_at, v.version, v.is_late, a.id AS assignment_id, a.title, a.course_id, c.code AS course_code, c.color AS course_color,
           u.name AS submitter, gr.name AS group_name
    FROM submission_versions v JOIN submissions s ON s.id = v.submission_id JOIN assignments a ON a.id = s.assignment_id
    JOIN courses c ON c.id = a.course_id JOIN users u ON u.id = v.submitted_by LEFT JOIN groups gr ON gr.id = s.group_id
    WHERE a.course_id IN (${ph}) ORDER BY v.submitted_at DESC LIMIT 10`).all(...ids);

  const pendingMembers = db.prepare(`
    SELECT COUNT(*) AS n, gs.course_id FROM group_memberships gm JOIN group_sets gs ON gs.id = gm.group_set_id
    WHERE gm.status = 'pending' AND gs.course_id IN (${ph}) GROUP BY gs.course_id`).all(...ids);

  const drafts = db.prepare(`SELECT course_id, COUNT(*) AS n FROM assignments WHERE published = 0 AND course_id IN (${ph}) GROUP BY course_id`).all(...ids);

  res.render('teach/dashboard', { title: 'Teaching dashboard', courses, upcoming, toGrade, activity, pendingMembers, drafts, TYPE_INFO });
});

module.exports = router;
module.exports.NEEDS_GRADING = NEEDS_GRADING;
