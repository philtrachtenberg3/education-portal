'use strict';
// Domain queries for assignments, submissions, groups and grades.
// Status rules live here so every page labels work the same way.

const { db } = require('../db');

const STATUS = {
  not_submitted: { label: 'Not submitted', icon: '○' },
  missing: { label: 'Past due · not submitted', icon: '!' },
  submitted: { label: 'Submitted', icon: '✓' },
  late: { label: 'Submitted late', icon: '✓' },
  returned: { label: 'Returned for revision', icon: '↺' },
  resubmitted: { label: 'Resubmitted', icon: '✓' },
  graded: { label: 'Graded', icon: '★' },
  excused: { label: 'Excused', icon: '–' },
};

const KIND_LABEL = { assignment: 'Assignment', quiz: 'Quiz', task: 'Task' };

function groupMembers(groupId, statuses = ['confirmed']) {
  return db.prepare(`
    SELECT u.id, u.name, u.email, gm.status, gm.id AS membership_id
    FROM group_memberships gm JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = ? AND gm.status IN (${statuses.map(() => '?').join(',')})
    ORDER BY u.name`).all(groupId, ...statuses);
}

// The student's live membership (pending or confirmed) in a group set, with the group.
function membershipInSet(groupSetId, studentId) {
  return db.prepare(`
    SELECT gm.*, g.name AS group_name FROM group_memberships gm JOIN groups g ON g.id = gm.group_id
    WHERE gm.group_set_id = ? AND gm.user_id = ? AND gm.status <> 'removed'`).get(groupSetId, studentId);
}

function confirmedGroup(groupSetId, studentId) {
  const m = membershipInSet(groupSetId, studentId);
  if (!m || m.status !== 'confirmed') return null;
  return { id: m.group_id, name: m.group_name, members: groupMembers(m.group_id) };
}

// The submission a student is credited for, or (for group work) their current group's submission.
function submissionForStudent(assignment, studentId) {
  const credited = db.prepare(`
    SELECT s.* FROM submission_credits sc JOIN submissions s ON s.id = sc.submission_id
    WHERE sc.assignment_id = ? AND sc.student_id = ?`).get(assignment.id, studentId);
  if (credited) return { submission: credited, credited: true };
  if (assignment.group_set_id) {
    const g = confirmedGroup(assignment.group_set_id, studentId);
    if (g) {
      const s = db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND group_id = ?').get(assignment.id, g.id);
      if (s) return { submission: s, credited: false };
    }
  }
  return { submission: null, credited: false };
}

function gradeFor(assignmentId, studentId, { releasedOnly }) {
  const g = db.prepare('SELECT * FROM grades WHERE assignment_id = ? AND student_id = ?').get(assignmentId, studentId);
  if (!g || (releasedOnly && !g.released)) return null;
  return g;
}

/** Everything a student needs to know about one assignment. */
function studentState(assignment, studentId, now = new Date().toISOString()) {
  const { submission, credited } = submissionForStudent(assignment, studentId);
  const grade = gradeFor(assignment.id, studentId, { releasedOnly: true });
  const group = assignment.group_set_id ? confirmedGroup(assignment.group_set_id, studentId) : null;
  let status;
  if (grade?.excused) status = 'excused';
  else if (grade && grade.points != null) status = 'graded';
  else if (submission) status = submission.status;
  else status = assignment.due_at < now ? 'missing' : 'not_submitted';
  return {
    submission, credited, grade, group, status,
    statusLabel: STATUS[status].label, statusIcon: STATUS[status].icon,
    pastDue: assignment.due_at < now,
  };
}

function versionsFor(submissionId) {
  const versions = db.prepare(`
    SELECT v.*, u.name AS submitter_name FROM submission_versions v JOIN users u ON u.id = v.submitted_by
    WHERE v.submission_id = ? ORDER BY v.version DESC`).all(submissionId);
  const files = db.prepare('SELECT * FROM submission_files WHERE version_id = ?');
  for (const v of versions) v.files = files.all(v.id);
  return versions;
}

function creditedStudents(submissionId) {
  return db.prepare(`
    SELECT u.id, u.name, u.email FROM submission_credits sc JOIN users u ON u.id = sc.student_id
    WHERE sc.submission_id = ? ORDER BY u.name`).all(submissionId);
}

function activeStudentCourses(studentId) {
  return db.prepare(`
    SELECT c.*, e.nickname, t.name AS term_name FROM enrollments e
    JOIN courses c ON c.id = e.course_id JOIN terms t ON t.id = c.term_id
    WHERE e.user_id = ? AND e.role = 'student' AND e.status = 'active' AND c.status = 'active'
    ORDER BY c.code`).all(studentId);
}

function instructorCourses(userId) {
  return db.prepare(`
    SELECT c.*, t.name AS term_name FROM enrollments e
    JOIN courses c ON c.id = e.course_id JOIN terms t ON t.id = c.term_id
    WHERE e.user_id = ? AND e.role = 'instructor' AND e.status = 'active' AND c.status = 'active'
    ORDER BY c.code`).all(userId);
}

/** Published assignments across a student's active courses, each with its state. */
function studentAssignments(studentId, { courseId } = {}) {
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT a.*, c.code AS course_code, c.title AS course_title, c.color AS course_color
    FROM assignments a JOIN courses c ON c.id = a.course_id
    JOIN enrollments e ON e.course_id = c.id AND e.user_id = ? AND e.role = 'student' AND e.status = 'active'
    WHERE a.published = 1 AND c.status = 'active' ${courseId ? 'AND c.id = ?' : ''}
    ORDER BY a.due_at`).all(...(courseId ? [studentId, courseId] : [studentId]));
  return rows.map((a) => ({ ...a, state: studentState(a, studentId, now) }));
}

/**
 * Provisional course total from released, scored items only. Returns null when the
 * instructor has hidden totals or nothing has been graded — we never invent a total.
 */
function provisionalTotal(course, items) {
  if (!course.show_total) return null;
  const counted = items.filter((i) => i.state.grade && !i.state.grade.excused && i.state.grade.points != null);
  if (!counted.length) return null;
  const earned = counted.reduce((s, i) => s + i.state.grade.points, 0);
  const possible = counted.reduce((s, i) => s + i.points, 0);
  return { earned, possible, percent: possible ? (earned / possible) * 100 : null, count: counted.length, items: counted };
}

/** Rows for the instructor submissions list: one per owner (student or group). */
function submissionRoster(assignment) {
  const students = db.prepare(`
    SELECT u.id, u.name, u.email FROM enrollments e JOIN users u ON u.id = e.user_id
    WHERE e.course_id = ? AND e.role = 'student' AND e.status = 'active' ORDER BY u.name`).all(assignment.course_id);
  const gradeStmt = db.prepare('SELECT * FROM grades WHERE assignment_id = ? AND student_id = ?');
  if (!assignment.group_set_id) {
    return students.map((s) => {
      const { submission } = submissionForStudent(assignment, s.id);
      return { key: `s${s.id}`, type: 'student', name: s.name, members: [s], submission, grades: [gradeStmt.get(assignment.id, s.id)].filter(Boolean) };
    });
  }
  const groups = db.prepare('SELECT * FROM groups WHERE group_set_id = ? ORDER BY name').all(assignment.group_set_id);
  const rows = groups.map((g) => {
    const submission = db.prepare('SELECT * FROM submissions WHERE assignment_id = ? AND group_id = ?').get(assignment.id, g.id);
    const members = submission ? creditedStudents(submission.id) : groupMembers(g.id);
    return { key: `g${g.id}`, type: 'group', groupId: g.id, name: g.name, members, submission, grades: members.map((m) => gradeStmt.get(assignment.id, m.id)).filter(Boolean) };
  });
  const placed = new Set(rows.flatMap((r) => r.members.map((m) => m.id)));
  const ungrouped = students.filter((s) => !placed.has(s.id) && !confirmedGroup(assignment.group_set_id, s.id));
  for (const s of ungrouped) rows.push({ key: `s${s.id}`, type: 'ungrouped', name: s.name, members: [s], submission: null, grades: [gradeStmt.get(assignment.id, s.id)].filter(Boolean) });
  return rows;
}

function rosterRowStatus(row, assignment) {
  if (!row.submission) return assignment.due_at < new Date().toISOString() ? 'missing' : 'not_submitted';
  const graded = row.grades.length && row.grades.length >= row.members.length && row.grades.every((g) => g.points != null || g.excused);
  if (graded) return row.grades.every((g) => g.released) ? 'graded' : 'graded_draft';
  return row.submission.status;
}

const ROSTER_LABEL = { ...Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v.label])), graded_draft: 'Graded · not released', graded: 'Graded · released', missing: 'Missing' };

module.exports = {
  STATUS, KIND_LABEL, ROSTER_LABEL, groupMembers, membershipInSet, confirmedGroup, submissionForStudent, gradeFor,
  studentState, versionsFor, creditedStudents, activeStudentCourses, instructorCourses, studentAssignments,
  provisionalTotal, submissionRoster, rosterRowStatus,
};
