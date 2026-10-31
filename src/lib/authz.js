'use strict';
// Course-level authorization. Every course route resolves the caller's role from
// their enrollment on the server; a course the user is not enrolled in returns 404
// so identifiers cannot be probed by editing the URL.

const { db } = require('../db');

function enrollmentFor(userId, courseId) {
  return db.prepare(`SELECT * FROM enrollments WHERE user_id = ? AND course_id = ? AND status = 'active'`)
    .get(userId, courseId);
}

function notFound(res) {
  res.status(404);
  return res.render('error', { title: 'Not found', message: 'This page does not exist or you do not have access to it.' });
}

// router.param('courseId', loadCourse)
function loadCourse(req, res, next, id) {
  if (!/^\d+$/.test(id) || !req.user) return notFound(res);
  const course = db.prepare(`
    SELECT c.*, t.name AS term_name FROM courses c JOIN terms t ON t.id = c.term_id WHERE c.id = ?`).get(id);
  const enrollment = course && enrollmentFor(req.user.id, course.id);
  if (!course || !enrollment) return notFound(res);
  req.course = course;
  req.courseRole = enrollment.role;
  res.locals.course = course;
  res.locals.courseRole = enrollment.role;
  res.locals.courseNickname = enrollment.nickname;
  return next();
}

function instructorOnly(req, res, next) {
  if (req.courseRole === 'instructor') return next();
  return notFound(res);
}

// Loads an assignment that belongs to req.course. Students only see published ones.
function loadAssignment(req, res, next, id) {
  if (!/^\d+$/.test(id)) return notFound(res);
  const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND course_id = ?').get(id, req.course.id);
  if (!a || (!a.published && req.courseRole !== 'instructor')) return notFound(res);
  req.assignment = a;
  res.locals.assignment = a;
  return next();
}

module.exports = { enrollmentFor, loadCourse, instructorOnly, loadAssignment, notFound };
