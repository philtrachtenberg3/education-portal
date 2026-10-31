'use strict';
// Search across the signed-in user's own courses: course names, assignments and materials.
// Results are limited to active enrollments; students only see published items.

const express = require('express');
const { db } = require('../db');
const { requireRole } = require('../lib/auth');

const router = express.Router();
const LIMIT = 25;

router.get('/search', requireRole('student', 'instructor'), (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const results = { courses: [], assignments: [], materials: [] };
  if (q.length >= 2) {
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    const role = req.user.role;
    const enrolled = `SELECT course_id FROM enrollments WHERE user_id = @uid AND role = @role AND status = 'active'`;
    const params = { uid: req.user.id, role, like };
    const pub = role === 'student' ? 'AND x.published = 1' : '';
    results.courses = db.prepare(`
      SELECT c.id, c.code, c.title, c.color FROM courses c
      WHERE c.id IN (${enrolled}) AND c.status = 'active'
        AND (c.code LIKE @like ESCAPE '\\' OR c.title LIKE @like ESCAPE '\\') ORDER BY c.code`).all(params);
    results.assignments = db.prepare(`
      SELECT x.id, x.title, x.kind, x.due_at, x.published, c.id AS course_id, c.code AS course_code, c.color AS course_color
      FROM assignments x JOIN courses c ON c.id = x.course_id
      WHERE x.course_id IN (${enrolled}) AND c.status = 'active' ${pub}
        AND (x.title LIKE @like ESCAPE '\\' OR x.instructions LIKE @like ESCAPE '\\')
      ORDER BY x.due_at DESC LIMIT ${LIMIT}`).all(params);
    results.materials = db.prepare(`
      SELECT x.id, x.title, x.kind, x.description, x.published, x.stored_name, x.url, c.id AS course_id, c.code AS course_code, c.color AS course_color
      FROM resources x JOIN courses c ON c.id = x.course_id
      WHERE x.course_id IN (${enrolled}) AND c.status = 'active' ${pub}
        AND (x.title LIKE @like ESCAPE '\\' OR x.description LIKE @like ESCAPE '\\')
      ORDER BY x.updated_at DESC LIMIT ${LIMIT}`).all(params);
  }
  const total = results.courses.length + results.assignments.length + results.materials.length;
  res.render('search', { title: q ? `Search: ${q}` : 'Search', q, results, total });
});

module.exports = router;
