'use strict';
// In-app notifications plus a replaceable email transport.
// Each event carries a dedupe key so one event never alerts a user twice.
// Email subjects are deliberately generic: no grades or submission details.

const fs = require('fs');
const path = require('path');
const { db, nowIso, DATA_DIR } = require('../db');

const OUTBOX = path.join(DATA_DIR, 'email-outbox.log');

// Development mailer: appends to a local outbox file instead of sending.
// Swap for an SMTP/API transport in production.
const mailer = {
  send({ to, subject, text }) {
    fs.appendFileSync(OUTBOX, `[${nowIso()}] To: ${to}\nSubject: ${subject}\n${text}\n\n`);
  },
};

const insert = db.prepare(`
  INSERT OR IGNORE INTO notifications (user_id, kind, title, link, course_id, dedupe_key, created_at)
  VALUES (?,?,?,?,?,?,?)`);

/**
 * @param {number[]} userIds recipients
 * @param {{kind:string,title:string,link:string,courseId?:number,dedupeKey:string}} n
 */
function notify(userIds, { kind, title, link, courseId = null, dedupeKey }) {
  const created = nowIso();
  const course = courseId ? db.prepare('SELECT code FROM courses WHERE id = ?').get(courseId) : null;
  for (const uid of new Set(userIds)) {
    const info = insert.run(uid, kind, title, link, courseId, dedupeKey, created);
    if (info.changes === 0) continue; // already notified for this event
    const user = db.prepare('SELECT email, email_notifications FROM users WHERE id = ?').get(uid);
    if (user?.email_notifications) {
      mailer.send({
        to: user.email,
        subject: course ? `New update in ${course.code}` : 'New update in Student Learning Portal',
        text: `You have a new notification. Sign in to view it: ${link}`,
      });
      db.prepare('UPDATE notifications SET emailed_at = ? WHERE id = ?').run(created, info.lastInsertRowid);
    }
  }
}

function courseStudentIds(courseId) {
  return db.prepare(`SELECT user_id FROM enrollments WHERE course_id = ? AND role = 'student' AND status = 'active'`)
    .all(courseId).map((r) => r.user_id);
}

function unreadCount(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;
}

/**
 * Deadline reminders: each student chooses how many hours ahead (0 disables).
 * Only unsubmitted, published work is included; dedupe key prevents repeats.
 */
function runReminders() {
  const now = new Date();
  const rows = db.prepare(`
    SELECT u.id AS user_id, u.reminder_hours, a.id AS assignment_id, a.course_id, a.title, a.due_at
    FROM users u
    JOIN enrollments e ON e.user_id = u.id AND e.role = 'student' AND e.status = 'active'
    JOIN courses c ON c.id = e.course_id AND c.status = 'active'
    JOIN assignments a ON a.course_id = c.id AND a.published = 1
    WHERE u.reminder_hours > 0 AND a.due_at > ?
      AND NOT EXISTS (SELECT 1 FROM submission_credits sc WHERE sc.assignment_id = a.id AND sc.student_id = u.id)`)
    .all(now.toISOString());
  for (const r of rows) {
    const hoursLeft = (new Date(r.due_at) - now) / 3600e3;
    if (hoursLeft <= r.reminder_hours) {
      notify([r.user_id], {
        kind: 'reminder',
        title: `Due soon: ${r.title}`,
        link: `/courses/${r.course_id}/assignments/${r.assignment_id}`,
        courseId: r.course_id,
        dedupeKey: `reminder:${r.assignment_id}:${r.due_at}`,
      });
    }
  }
}

module.exports = { notify, courseStudentIds, unreadCount, runReminders, mailer };
