'use strict';
const express = require('express');
const { db, nowIso } = require('../db');
const { requireLogin } = require('../lib/auth');
const { enrollmentFor, notFound } = require('../lib/authz');
const { isValidZone } = require('../lib/time');
const storage = require('../lib/storage');
const cw = require('../lib/coursework');

const router = express.Router();

router.get('/notifications', requireLogin, (req, res) => {
  const items = db.prepare(`
    SELECT n.*, c.code AS course_code, c.color AS course_color FROM notifications n LEFT JOIN courses c ON c.id = n.course_id
    WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 100`).all(req.user.id);
  res.render('notifications', { title: 'Notifications', items });
});

// Opening a notification marks it read, then follows its (always internal) link.
router.post('/notifications/:id/open', requireLogin, (req, res) => {
  const n = db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!n) return notFound(res);
  db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?').run(nowIso(), n.id);
  res.redirect(n.link.startsWith('/') ? n.link : '/');
});

router.post('/notifications/read-all', requireLogin, (req, res) => {
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(nowIso(), req.user.id);
  req.flash('success', 'All notifications marked as read.');
  res.redirect('/notifications');
});

const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto',
  'Europe/London', 'Europe/Dublin', 'Europe/Berlin', 'Europe/Paris', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo',
  'Australia/Sydney', 'Pacific/Auckland', 'UTC'];

router.get('/settings', requireLogin, (req, res) => {
  res.render('settings', { title: 'Settings', zones: ZONES, errors: [] });
});

router.post('/settings', requireLogin, (req, res) => {
  const tz = String(req.body.timezone || '');
  const reminder = Number(req.body.reminder_hours);
  const errors = [];
  if (!isValidZone(tz)) errors.push('Choose a valid time zone.');
  if (![0, 6, 12, 24, 48, 72].includes(reminder)) errors.push('Choose a reminder time from the list.');
  if (errors.length) return res.status(400).render('settings', { title: 'Settings', zones: ZONES, errors });
  db.prepare('UPDATE users SET timezone = ?, email_notifications = ?, reminder_hours = ? WHERE id = ?')
    .run(tz, req.body.email_notifications ? 1 : 0, reminder, req.user.id);
  req.flash('success', 'Settings saved.');
  res.redirect('/settings');
});

router.get('/files/resources/:id', requireLogin, (req, res) => {
  const r = db.prepare('SELECT * FROM resources WHERE id = ?').get(req.params.id);
  const e = r && enrollmentFor(req.user.id, r.course_id);
  if (!r || !e || !r.stored_name || (!r.published && e.role !== 'instructor')) return notFound(res);
  return storage.send(res, r.stored_name, r.file_name);
});

router.get('/files/submissions/:id', requireLogin, (req, res) => {
  const f = db.prepare(`
    SELECT f.*, s.id AS submission_id, s.group_id, a.course_id, a.group_set_id, a.id AS assignment_id
    FROM submission_files f JOIN submission_versions v ON v.id = f.version_id
    JOIN submissions s ON s.id = v.submission_id JOIN assignments a ON a.id = s.assignment_id
    WHERE f.id = ?`).get(req.params.id);
  if (!f) return notFound(res);
  const e = enrollmentFor(req.user.id, f.course_id);
  let allowed = e?.role === 'instructor';
  if (!allowed && e?.role === 'student') {
    const credited = db.prepare('SELECT 1 FROM submission_credits WHERE submission_id = ? AND student_id = ?').get(f.submission_id, req.user.id);
    const inGroup = f.group_id && cw.confirmedGroup(f.group_set_id, req.user.id)?.id === f.group_id;
    allowed = Boolean(credited || inGroup);
  }
  if (!allowed) return notFound(res);
  return storage.send(res, f.stored_name, f.original_name);
});

module.exports = router;
