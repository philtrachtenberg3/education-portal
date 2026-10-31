'use strict';
// Administrator area: accounts, terms, course shells, enrollments, audit log and CSV import/export.
// Administrators manage structure; they do not see grades or submissions, and there is no impersonation.

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const { db, nowIso } = require('../db');
const { requireRole, hashPassword, csrfCheck } = require('../lib/auth');
const { audit } = require('../lib/audit');
const { isValidZone } = require('../lib/time');
const csv = require('../lib/csv');

const router = express.Router();
router.use(requireRole('admin'));

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAGE = 30;

router.get('/', (req, res) => {
  const counts = {
    students: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'student'`).get().n,
    instructors: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'instructor'`).get().n,
    courses: db.prepare(`SELECT COUNT(*) AS n FROM courses WHERE status = 'active'`).get().n,
    enrollments: db.prepare(`SELECT COUNT(*) AS n FROM enrollments WHERE status = 'active'`).get().n,
  };
  const recent = db.prepare(`SELECT ae.*, u.name AS actor FROM audit_events ae LEFT JOIN users u ON u.id = ae.actor_id ORDER BY ae.id DESC LIMIT 8`).all();
  res.render('admin/index', { title: 'Administration', counts, recent });
});

// ---------- Users ----------

router.get('/users', (req, res) => {
  const q = str(req.query.q, 100);
  const role = ['student', 'instructor', 'admin'].includes(req.query.role) ? req.query.role : '';
  const where = ['1=1'];
  const params = [];
  if (q) { where.push('(name LIKE ? OR email LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (role) { where.push('role = ?'); params.push(role); }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${where.join(' AND ')}`).get(...params).n;
  const page = Math.max(1, Number(req.query.page) || 1);
  const users = db.prepare(`SELECT * FROM users WHERE ${where.join(' AND ')} ORDER BY name LIMIT ? OFFSET ?`).all(...params, PAGE, (page - 1) * PAGE);
  res.render('admin/users', { title: 'Accounts', users, q, role, page, pages: Math.max(1, Math.ceil(total / PAGE)), total, created: null });
});

router.post('/users', (req, res) => {
  const name = str(req.body.name);
  const email = str(req.body.email).toLowerCase();
  const role = ['student', 'instructor', 'admin'].includes(req.body.role) ? req.body.role : null;
  if (!name || !EMAIL.test(email) || !role) {
    req.flash('error', 'Enter a name, a valid email address and a role.');
    return res.redirect('/admin/users');
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    req.flash('error', `An account for ${email} already exists.`);
    return res.redirect('/admin/users');
  }
  // One-time temporary password shown once to the admin; production would use SSO or an emailed set-password link.
  const temp = crypto.randomBytes(9).toString('base64url');
  const info = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)').run(name, email, hashPassword(temp), role);
  audit({ actorId: req.user.id, action: 'admin.user_created', entityType: 'user', entityId: info.lastInsertRowid, after: { email, role } });
  const users = db.prepare('SELECT * FROM users ORDER BY name LIMIT ?').all(PAGE);
  res.render('admin/users', { title: 'Accounts', users, q: '', role: '', page: 1, pages: 1, total: users.length, created: { name, email, temp } });
});

router.post('/users/:id/status', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u || u.id === req.user.id) { req.flash('error', 'You cannot change the status of that account.'); return res.redirect('/admin/users'); }
  const status = u.status === 'active' ? 'suspended' : 'active';
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, u.id);
  if (status === 'suspended') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  audit({ actorId: req.user.id, action: `admin.user_${status}`, entityType: 'user', entityId: u.id, before: { status: u.status }, after: { status } });
  req.flash('success', `${u.name} is now ${status}.`);
  res.redirect('/admin/users');
});

// ---------- Terms & courses ----------

router.get('/courses', (req, res) => {
  const courses = db.prepare(`
    SELECT c.*, t.name AS term_name,
      (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id AND e.role = 'student' AND e.status = 'active') AS students,
      (SELECT GROUP_CONCAT(u.name, ', ') FROM enrollments e JOIN users u ON u.id = e.user_id WHERE e.course_id = c.id AND e.role = 'instructor' AND e.status = 'active') AS instructors
    FROM courses c JOIN terms t ON t.id = c.term_id ORDER BY t.start_date DESC, c.code`).all();
  const terms = db.prepare('SELECT * FROM terms ORDER BY start_date DESC').all();
  res.render('admin/courses', { title: 'Courses & terms', courses, terms });
});

router.post('/terms', (req, res) => {
  const name = str(req.body.name, 80);
  const { start_date: start, end_date: end } = req.body;
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
    req.flash('error', 'Enter a term name and valid start and end dates.');
    return res.redirect('/admin/courses');
  }
  const info = db.prepare('INSERT INTO terms (name, start_date, end_date) VALUES (?,?,?)').run(name, start, end);
  audit({ actorId: req.user.id, action: 'admin.term_created', entityType: 'term', entityId: info.lastInsertRowid, after: { name, start, end } });
  req.flash('success', `Term “${name}” created.`);
  res.redirect('/admin/courses');
});

router.post('/courses', (req, res) => {
  const code = str(req.body.code, 20).toUpperCase();
  const title = str(req.body.title, 150);
  const term = db.prepare('SELECT * FROM terms WHERE id = ?').get(req.body.term_id);
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color) ? req.body.color : '#3559c7';
  if (!code || !title || !term) { req.flash('error', 'Enter a course code, title and term.'); return res.redirect('/admin/courses'); }
  try {
    const info = db.prepare('INSERT INTO courses (code, title, term_id, color) VALUES (?,?,?,?)').run(code, title, term.id, color);
    audit({ actorId: req.user.id, action: 'admin.course_created', entityType: 'course', entityId: info.lastInsertRowid, courseId: info.lastInsertRowid, after: { code, title, term: term.name } });
    req.flash('success', `${code} created. Add instructors and students below.`);
    return res.redirect(`/admin/courses/${info.lastInsertRowid}`);
  } catch (e) {
    if (e.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw e;
    req.flash('error', `${code} already exists in ${term.name}.`);
    return res.redirect('/admin/courses');
  }
});

router.post('/courses/:id/status', (req, res) => {
  const c = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!c) return res.redirect('/admin/courses');
  const status = c.status === 'active' ? 'archived' : 'active';
  db.prepare('UPDATE courses SET status = ? WHERE id = ?').run(status, c.id);
  audit({ actorId: req.user.id, action: `admin.course_${status}`, entityType: 'course', entityId: c.id, courseId: c.id });
  req.flash('success', `${c.code} is now ${status}.`);
  res.redirect('/admin/courses');
});

// ---------- Enrollments ----------

router.get('/courses/:id', (req, res) => {
  const course = db.prepare('SELECT c.*, t.name AS term_name FROM courses c JOIN terms t ON t.id = c.term_id WHERE c.id = ?').get(req.params.id);
  if (!course) return res.status(404).render('error', { title: 'Not found', message: 'That course does not exist.' });
  const enrollments = db.prepare(`
    SELECT e.*, u.name, u.email FROM enrollments e JOIN users u ON u.id = e.user_id
    WHERE e.course_id = ? ORDER BY e.role DESC, e.status, u.name`).all(course.id);
  res.render('admin/course', { title: `${course.code} enrollments`, adminCourse: course, enrollments });
});

function enroll(actorId, course, user, role) {
  const existing = db.prepare('SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?').get(user.id, course.id);
  if (existing) {
    db.prepare(`UPDATE enrollments SET role = ?, status = 'active' WHERE id = ?`).run(role, existing.id);
  } else {
    db.prepare('INSERT INTO enrollments (user_id, course_id, role, start_date) VALUES (?,?,?,?)').run(user.id, course.id, role, nowIso().slice(0, 10));
  }
  audit({ actorId, action: 'admin.enrolled', entityType: 'enrollment', entityId: user.id, courseId: course.id, before: existing ? { role: existing.role, status: existing.status } : null, after: { role, status: 'active' } });
}

router.post('/courses/:id/enrollments', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(str(req.body.email));
  const role = req.body.role === 'instructor' ? 'instructor' : 'student';
  if (!course || !user) { req.flash('error', 'No account exists with that email. Create the account first.'); return res.redirect(`/admin/courses/${req.params.id}`); }
  if (user.role === 'admin') { req.flash('error', 'Administrator accounts cannot be enrolled in courses.'); return res.redirect(`/admin/courses/${course.id}`); }
  enroll(req.user.id, course, user, role);
  req.flash('success', `${user.name} enrolled as ${role}.`);
  res.redirect(`/admin/courses/${course.id}`);
});

router.post('/enrollments/:id/drop', (req, res) => {
  const e = db.prepare('SELECT * FROM enrollments WHERE id = ?').get(req.params.id);
  if (!e) return res.redirect('/admin/courses');
  const status = e.status === 'active' ? 'dropped' : 'active';
  db.prepare('UPDATE enrollments SET status = ?, end_date = ? WHERE id = ?').run(status, status === 'dropped' ? nowIso().slice(0, 10) : null, e.id);
  audit({ actorId: req.user.id, action: `admin.enrollment_${status}`, entityType: 'enrollment', entityId: e.user_id, courseId: e.course_id, before: { status: e.status }, after: { status } });
  req.flash('success', `Enrollment ${status === 'dropped' ? 'ended' : 'restored'}. Past records are kept.`);
  res.redirect(`/admin/courses/${e.course_id}`);
});

// ---------- Audit log ----------

router.get('/audit', (req, res) => {
  const action = str(req.query.action, 60);
  const courseId = Number(req.query.course) || null;
  const where = ['1=1'];
  const params = [];
  if (action) { where.push('ae.action LIKE ?'); params.push(`${action}%`); }
  if (courseId) { where.push('ae.course_id = ?'); params.push(courseId); }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_events ae WHERE ${where.join(' AND ')}`).get(...params).n;
  const page = Math.max(1, Number(req.query.page) || 1);
  const events = db.prepare(`
    SELECT ae.*, u.name AS actor, c.code AS course_code FROM audit_events ae
    LEFT JOIN users u ON u.id = ae.actor_id LEFT JOIN courses c ON c.id = ae.course_id
    WHERE ${where.join(' AND ')} ORDER BY ae.id DESC LIMIT ? OFFSET ?`).all(...params, PAGE, (page - 1) * PAGE);
  const courses = db.prepare('SELECT id, code FROM courses ORDER BY code').all();
  res.render('admin/audit', { title: 'Audit log', events, courses, filters: { action, course: courseId }, page, pages: Math.max(1, Math.ceil(total / PAGE)), total });
});

// ---------- CSV import / export ----------

const IMPORTS = {
  users: { columns: ['name', 'email', 'role'], help: 'role is student, instructor or admin. New accounts get a random password (use SSO in production).' },
  courses: { columns: ['code', 'title', 'term'], help: 'term must match an existing term name exactly.' },
  enrollments: { columns: ['email', 'course_code', 'term', 'role'], help: 'role is student or instructor.' },
  schedule: { columns: ['course_code', 'term', 'title', 'kind', 'weekday', 'start_time', 'end_time', 'timezone', 'location', 'first_date', 'last_date'], help: 'kind: lecture, seminar, lab or tutorial. weekday: 1 (Mon) – 7 (Sun). Times HH:MM in the given IANA time zone.' },
};

router.get('/import', (req, res) => res.render('admin/import', { title: 'Import & export', IMPORTS, result: null }));

const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1048576, files: 1 } }).single('file');

router.post('/import', (req, res, next) => importUpload(req, res, (err) => {
  if (err) return res.status(400).render('admin/import', { title: 'Import & export', IMPORTS, result: { errors: ['The CSV file could not be read (2 MB limit).'], ok: 0 } });
  return csrfCheck(req, res, () => {
    try { runImport(req, res); } catch (e) { next(e); }
  });
}));

function runImport(req, res) {
  const type = IMPORTS[req.body.type] ? req.body.type : null;
  const text = req.file ? req.file.buffer.toString('utf8') : String(req.body.csv || '');
  const render = (result, status = 200) => res.status(status).render('admin/import', { title: 'Import & export', IMPORTS, result: { type, ...result } });
  if (!type) return render({ errors: ['Choose what you are importing.'], ok: 0 }, 400);
  const { header, records } = csv.parse(text);
  const missing = IMPORTS[type].columns.filter((c) => !['location'].includes(c) && !header.includes(c));
  if (!records.length || missing.length) return render({ errors: [missing.length ? `Missing column(s): ${missing.join(', ')}.` : 'The file has no data rows.'], ok: 0 }, 400);

  const errors = [];
  const created = [];
  const termByName = (n) => db.prepare('SELECT * FROM terms WHERE name = ?').get(n);
  const courseBy = (code, term) => db.prepare('SELECT c.* FROM courses c JOIN terms t ON t.id = c.term_id WHERE c.code = ? AND t.name = ?').get(code.toUpperCase(), term);
  // All-or-nothing: any row error rolls back the whole file.
  const apply = db.transaction(() => {
    for (const r of records) {
      const fail = (m) => errors.push(`Line ${r.line}: ${m}`);
      if (type === 'users') {
        const email = r.email.toLowerCase();
        if (!r.name || !EMAIL.test(email) || !['student', 'instructor', 'admin'].includes(r.role)) { fail('needs name, valid email and role.'); continue; }
        if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) { fail(`${email} already exists — skipped.`); continue; }
        db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)').run(r.name, email, hashPassword(crypto.randomBytes(12).toString('hex')), r.role);
        created.push(email);
      } else if (type === 'courses') {
        const term = termByName(r.term);
        if (!r.code || !r.title || !term) { fail('needs code, title and an existing term.'); continue; }
        if (courseBy(r.code, r.term)) { fail(`${r.code} already exists in ${r.term}.`); continue; }
        db.prepare('INSERT INTO courses (code, title, term_id) VALUES (?,?,?)').run(r.code.toUpperCase(), r.title, term.id);
        created.push(r.code);
      } else if (type === 'enrollments') {
        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(r.email);
        const course = courseBy(r.course_code, r.term);
        if (!user || !course || !['student', 'instructor'].includes(r.role)) { fail('unknown email/course or invalid role.'); continue; }
        enroll(req.user.id, course, user, r.role);
        created.push(`${r.email} → ${course.code}`);
      } else if (type === 'schedule') {
        const course = courseBy(r.course_code, r.term);
        const weekday = Number(r.weekday);
        const ok = course && r.title && ['lecture', 'seminar', 'lab', 'tutorial'].includes(r.kind) && weekday >= 1 && weekday <= 7
          && /^\d{2}:\d{2}$/.test(r.start_time) && /^\d{2}:\d{2}$/.test(r.end_time) && r.end_time > r.start_time && isValidZone(r.timezone)
          && /^\d{4}-\d{2}-\d{2}$/.test(r.first_date) && /^\d{4}-\d{2}-\d{2}$/.test(r.last_date);
        if (!ok) { fail('check course, kind, weekday, times, time zone and dates.'); continue; }
        db.prepare(`INSERT INTO class_meetings (course_id, title, kind, weekday, start_time, end_time, timezone, location, first_date, last_date)
                    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(course.id, r.title, r.kind, weekday, r.start_time, r.end_time, r.timezone, r.location || '', r.first_date, r.last_date);
        created.push(`${course.code} ${r.title}`);
      }
    }
    if (errors.length) throw new Error('rollback');
  });
  try {
    apply();
  } catch (e) {
    if (e.message !== 'rollback') throw e;
    return render({ errors: [...errors, 'No rows were imported. Fix the lines above and upload the file again.'], ok: 0 }, 400);
  }
  audit({ actorId: req.user.id, action: 'admin.csv_import', entityType: type, after: { rows: created.length } });
  return render({ errors: [], ok: created.length, created });
}

const EXPORTS = {
  users: () => ({ header: ['name', 'email', 'role', 'status'], rows: db.prepare('SELECT name, email, role, status FROM users ORDER BY name').all().map(Object.values) }),
  courses: () => ({ header: ['code', 'title', 'term', 'status'], rows: db.prepare('SELECT c.code, c.title, t.name, c.status FROM courses c JOIN terms t ON t.id = c.term_id ORDER BY c.code').all().map(Object.values) }),
  enrollments: () => ({ header: ['email', 'course_code', 'term', 'role', 'status'], rows: db.prepare(`SELECT u.email, c.code, t.name, e.role, e.status FROM enrollments e JOIN users u ON u.id = e.user_id JOIN courses c ON c.id = e.course_id JOIN terms t ON t.id = c.term_id ORDER BY c.code, e.role, u.email`).all().map(Object.values) }),
  schedule: () => ({ header: IMPORTS.schedule.columns, rows: db.prepare(`SELECT c.code, t.name, m.title, m.kind, m.weekday, m.start_time, m.end_time, m.timezone, m.location, m.first_date, m.last_date FROM class_meetings m JOIN courses c ON c.id = m.course_id JOIN terms t ON t.id = c.term_id ORDER BY c.code, m.weekday`).all().map(Object.values) }),
};

router.get('/export/:type.csv', (req, res) => {
  const make = EXPORTS[req.params.type];
  if (!make) return res.status(404).send('Unknown export');
  const { header, rows } = make();
  audit({ actorId: req.user.id, action: 'admin.csv_export', entityType: req.params.type });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${req.params.type}.csv"`);
  res.send(csv.stringify(header, rows));
});

module.exports = router;
