'use strict';
const express = require('express');
const { db, nowIso } = require('../db');
const { instructorOnly, notFound } = require('../lib/authz');
const { audit } = require('../lib/audit');
const { notify } = require('../lib/notify');
const { fromLocalInput } = require('../lib/time');
const cw = require('../lib/coursework');

const router = express.Router({ mergeParams: true });
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const base = (req) => `/courses/${req.course.id}/groups`;

const groupHasSubmissions = (groupId) => Boolean(db.prepare('SELECT 1 FROM submissions WHERE group_id = ?').get(groupId));
const liveCount = (groupId) => db.prepare(`SELECT COUNT(*) AS n FROM group_memberships WHERE group_id = ? AND status <> 'removed'`).get(groupId).n;
const deadlinePassed = (set) => set.membership_deadline && nowIso() > set.membership_deadline;

function setMembership(req, { group, set, userId, status, action, reason = null }) {
  const now = nowIso();
  const existing = db.prepare(`SELECT * FROM group_memberships WHERE group_set_id = ? AND user_id = ? AND status <> 'removed'`).get(set.id, userId);
  if (status === 'removed') {
    db.prepare(`UPDATE group_memberships SET status = 'removed', decided_by = ?, updated_at = ? WHERE id = ?`).run(req.user.id, now, existing.id);
  } else if (existing) {
    db.prepare('UPDATE group_memberships SET status = ?, decided_by = ?, updated_at = ? WHERE id = ?').run(status, req.user.id, now, existing.id);
  } else {
    db.prepare(`INSERT INTO group_memberships (group_id, group_set_id, user_id, status, decided_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(group.id, set.id, userId, status, req.user.id, now, now);
  }
  audit({
    actorId: req.user.id, action, entityType: 'group_membership', entityId: group.id, courseId: req.course.id,
    before: existing ? { group: existing.group_id, student: userId, status: existing.status } : null,
    after: { group: group.id, group_name: group.name, student: userId, status }, reason,
  });
}

function loadSets(courseId) {
  return db.prepare('SELECT * FROM group_sets WHERE course_id = ? ORDER BY id').all(courseId).map((set) => {
    const groups = db.prepare('SELECT * FROM groups WHERE group_set_id = ? ORDER BY name').all(set.id).map((g) => ({
      ...g, members: cw.groupMembers(g.id, ['confirmed', 'pending']), locked: groupHasSubmissions(g.id),
    }));
    const assignments = db.prepare('SELECT id, title, published, group_grading FROM assignments WHERE group_set_id = ? ORDER BY due_at').all(set.id);
    return { ...set, groups, assignments };
  });
}

router.get('/groups', (req, res) => {
  const sets = loadSets(req.course.id);
  if (req.courseRole === 'instructor') {
    const students = db.prepare(`SELECT u.id, u.name FROM enrollments e JOIN users u ON u.id = e.user_id
      WHERE e.course_id = ? AND e.role = 'student' AND e.status = 'active' ORDER BY u.name`).all(req.course.id);
    for (const set of sets) {
      const placed = new Set(set.groups.flatMap((g) => g.members.map((m) => m.id)));
      set.ungrouped = students.filter((s) => !placed.has(s.id));
    }
    return res.render('course/groups-instructor', { title: `Groups · ${req.course.code}`, tab: 'groups', sets });
  }
  for (const set of sets) {
    set.mine = cw.membershipInSet(set.id, req.user.id);
    set.myGroup = set.mine && set.groups.find((g) => g.id === set.mine.group_id);
    set.closed = deadlinePassed(set);
  }
  res.render('course/groups', { title: `Groups · ${req.course.code}`, tab: 'groups', sets });
});

// ---------- Student actions ----------

function studentSetGuard(req, res, set) {
  if (!set || req.courseRole !== 'student') return notFound(res);
  if (deadlinePassed(set)) {
    req.flash('error', 'The group membership deadline has passed. Contact your instructor to change groups.');
    return res.redirect(base(req));
  }
  return null;
}

router.post('/groups/sets/:sid/create', (req, res) => {
  const set = db.prepare('SELECT * FROM group_sets WHERE id = ? AND course_id = ?').get(req.params.sid, req.course.id);
  const blocked = studentSetGuard(req, res, set);
  if (blocked) return blocked;
  if (!set.student_created) { req.flash('error', 'Your instructor creates the groups for this set.'); return res.redirect(base(req)); }
  if (cw.membershipInSet(set.id, req.user.id)) { req.flash('error', 'Leave your current group before creating a new one.'); return res.redirect(base(req)); }
  const name = str(req.body.name, 80);
  if (!name) { req.flash('error', 'Give your group a name.'); return res.redirect(base(req)); }
  db.transaction(() => {
    const info = db.prepare('INSERT INTO groups (group_set_id, name, created_by, created_at) VALUES (?,?,?,?)').run(set.id, name, req.user.id, nowIso());
    const group = { id: info.lastInsertRowid, name };
    setMembership(req, { group, set, userId: req.user.id, status: set.requires_approval ? 'pending' : 'confirmed', action: 'group.created_by_student' });
  })();
  req.flash('success', set.requires_approval ? `Group “${name}” created. Your membership is waiting for instructor approval.` : `Group “${name}” created. Classmates can now join it.`);
  res.redirect(base(req));
});

router.post('/groups/:gid/join', (req, res) => {
  const group = db.prepare('SELECT g.* FROM groups g JOIN group_sets s ON s.id = g.group_set_id WHERE g.id = ? AND s.course_id = ?').get(req.params.gid, req.course.id);
  const set = group && db.prepare('SELECT * FROM group_sets WHERE id = ?').get(group.group_set_id);
  const blocked = studentSetGuard(req, res, set);
  if (blocked) return blocked;
  if (!set.student_created) { req.flash('error', 'Your instructor assigns the groups for this set.'); return res.redirect(base(req)); }
  if (cw.membershipInSet(set.id, req.user.id)) { req.flash('error', 'You are already in a group for this set. Leave it first.'); return res.redirect(base(req)); }
  if (groupHasSubmissions(group.id)) { req.flash('error', `“${group.name}” has already submitted work. Ask your instructor to add you.`); return res.redirect(base(req)); }
  if (liveCount(group.id) >= set.max_size) { req.flash('error', `“${group.name}” is full (${set.max_size} members).`); return res.redirect(base(req)); }
  setMembership(req, { group, set, userId: req.user.id, status: set.requires_approval ? 'pending' : 'confirmed', action: 'group.join_requested' });
  req.flash('success', set.requires_approval ? `Request to join “${group.name}” sent. You will be notified when your instructor responds.` : `You joined “${group.name}”.`);
  res.redirect(base(req));
});

router.post('/groups/:gid/leave', (req, res) => {
  const group = db.prepare('SELECT g.* FROM groups g JOIN group_sets s ON s.id = g.group_set_id WHERE g.id = ? AND s.course_id = ?').get(req.params.gid, req.course.id);
  const set = group && db.prepare('SELECT * FROM group_sets WHERE id = ?').get(group.group_set_id);
  const blocked = studentSetGuard(req, res, set);
  if (blocked) return blocked;
  const mine = cw.membershipInSet(set.id, req.user.id);
  if (!mine || mine.group_id !== group.id) return notFound(res);
  if (groupHasSubmissions(group.id)) { req.flash('error', 'Your group has already submitted work, so membership changes need your instructor.'); return res.redirect(base(req)); }
  setMembership(req, { group, set, userId: req.user.id, status: 'removed', action: 'group.left' });
  req.flash('success', `You left “${group.name}”.`);
  res.redirect(base(req));
});

// ---------- Instructor actions ----------

router.post('/groups/sets', instructorOnly, (req, res) => {
  const name = str(req.body.name, 100);
  const max = Number(req.body.max_size);
  if (!name || !Number.isInteger(max) || max < 2 || max > 20) {
    req.flash('error', 'Give the group set a name and a size limit between 2 and 20.');
    return res.redirect(`${base(req)}#new-set`);
  }
  db.prepare('INSERT INTO group_sets (course_id, name, max_size, membership_deadline, student_created, requires_approval) VALUES (?,?,?,?,?,?)')
    .run(req.course.id, name, max, fromLocalInput(req.body.membership_deadline, req.user.timezone), req.body.student_created ? 1 : 0, req.body.requires_approval ? 1 : 0);
  req.flash('success', `Group set “${name}” created.`);
  res.redirect(base(req));
});

router.post('/groups/sets/:sid/groups', instructorOnly, (req, res) => {
  const set = db.prepare('SELECT * FROM group_sets WHERE id = ? AND course_id = ?').get(req.params.sid, req.course.id);
  if (!set) return notFound(res);
  const name = str(req.body.name, 80);
  if (!name) { req.flash('error', 'Give the group a name.'); return res.redirect(base(req)); }
  db.prepare('INSERT INTO groups (group_set_id, name, created_by, created_at) VALUES (?,?,?,?)').run(set.id, name, req.user.id, nowIso());
  req.flash('success', `Group “${name}” created.`);
  res.redirect(`${base(req)}#set-${set.id}`);
});

function instructorGroup(req) {
  const group = db.prepare('SELECT g.* FROM groups g JOIN group_sets s ON s.id = g.group_set_id WHERE g.id = ? AND s.course_id = ?').get(req.params.gid, req.course.id);
  return group && { group, set: db.prepare('SELECT * FROM group_sets WHERE id = ?').get(group.group_set_id) };
}

router.post('/groups/:gid/members', instructorOnly, (req, res) => {
  const found = instructorGroup(req);
  if (!found) return notFound(res);
  const { group, set } = found;
  const studentId = Number(req.body.student_id);
  const enrolled = db.prepare(`SELECT u.name FROM enrollments e JOIN users u ON u.id = e.user_id WHERE e.course_id = ? AND e.user_id = ? AND e.role = 'student' AND e.status = 'active'`).get(req.course.id, studentId);
  if (!enrolled) { req.flash('error', 'Choose a student enrolled in this course.'); return res.redirect(`${base(req)}#set-${set.id}`); }
  if (cw.membershipInSet(set.id, studentId)) { req.flash('error', `${enrolled.name} is already in a group in this set. Remove them from it first.`); return res.redirect(`${base(req)}#set-${set.id}`); }
  if (liveCount(group.id) >= set.max_size && !req.body.override_size) { req.flash('error', `“${group.name}” is full. Tick “allow over limit” to add anyway.`); return res.redirect(`${base(req)}#set-${set.id}`); }
  const reason = str(req.body.reason, 300) || null;
  let credited = 0;
  db.transaction(() => {
    setMembership(req, { group, set, userId: studentId, status: 'confirmed', action: 'group.member_added', reason });
    // Instructor additions after a submission credit the student with the group's existing work.
    for (const s of db.prepare('SELECT * FROM submissions WHERE group_id = ?').all(group.id)) {
      const info = db.prepare('INSERT OR IGNORE INTO submission_credits (submission_id, student_id, assignment_id) VALUES (?,?,?)').run(s.id, studentId, s.assignment_id);
      if (info.changes) {
        credited += 1;
        audit({ actorId: req.user.id, action: 'submission.credit_added', entityType: 'submission', entityId: s.id, courseId: req.course.id, after: { student: studentId }, reason });
      }
    }
  })();
  notify([studentId], { kind: 'group', title: `You were added to ${group.name}`, link: base(req), courseId: req.course.id, dedupeKey: `group-add:${group.id}:${studentId}:${nowIso().slice(0, 16)}` });
  req.flash('success', `${enrolled.name} added to “${group.name}”${credited ? ` and credited for ${credited} existing submission${credited > 1 ? 's' : ''}` : ''}.`);
  res.redirect(`${base(req)}#set-${set.id}`);
});

router.post('/groups/:gid/members/:uid/:decision', instructorOnly, (req, res) => {
  const found = instructorGroup(req);
  if (!found) return notFound(res);
  const { group, set } = found;
  const m = db.prepare(`SELECT gm.*, u.name FROM group_memberships gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? AND gm.user_id = ? AND gm.status <> 'removed'`).get(group.id, req.params.uid);
  if (!m) return notFound(res);
  const decision = req.params.decision;
  const reason = str(req.body.reason, 300) || null;
  if (decision === 'approve' && m.status === 'pending') {
    if (db.prepare(`SELECT COUNT(*) AS n FROM group_memberships WHERE group_id = ? AND status = 'confirmed'`).get(group.id).n >= set.max_size) {
      req.flash('error', `“${group.name}” already has ${set.max_size} confirmed members.`);
      return res.redirect(`${base(req)}#set-${set.id}`);
    }
    setMembership(req, { group, set, userId: m.user_id, status: 'confirmed', action: 'group.member_approved', reason });
    notify([m.user_id], { kind: 'group', title: `Your membership in ${group.name} was approved`, link: base(req), courseId: req.course.id, dedupeKey: `group-approve:${m.id}` });
    req.flash('success', `${m.name} confirmed in “${group.name}”.`);
  } else if (decision === 'remove' || decision === 'reject') {
    if (groupHasSubmissions(group.id) && !reason) {
      req.flash('error', `“${group.name}” has submitted work. Enter a reason to remove ${m.name}; their credit for past submissions is kept.`);
      return res.redirect(`${base(req)}#set-${set.id}`);
    }
    setMembership(req, { group, set, userId: m.user_id, status: 'removed', action: decision === 'reject' ? 'group.member_rejected' : 'group.member_removed', reason });
    notify([m.user_id], { kind: 'group', title: decision === 'reject' ? `Your request to join ${group.name} was declined` : `You were removed from ${group.name}`, link: base(req), courseId: req.course.id, dedupeKey: `group-${decision}:${m.id}` });
    req.flash('success', `${m.name} ${decision === 'reject' ? 'declined' : 'removed'}. ${groupHasSubmissions(group.id) ? 'Credit for work already submitted is kept.' : ''}`);
  } else {
    return notFound(res);
  }
  res.redirect(`${base(req)}#set-${set.id}`);
});

module.exports = router;
