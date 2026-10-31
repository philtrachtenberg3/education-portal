'use strict';
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { db, nowIso } = require('../db');
const { instructorOnly, loadAssignment, notFound } = require('../lib/authz');
const { csrfCheck } = require('../lib/auth');
const { audit } = require('../lib/audit');
const { notify, courseStudentIds } = require('../lib/notify');
const { fromLocalInput, isValidZone, fmtDateTime } = require('../lib/time');
const storage = require('../lib/storage');
const cw = require('../lib/coursework');

const router = express.Router({ mergeParams: true });
router.param('aid', loadAssignment);

const str = (v, max = 20000) => String(v ?? '').trim().slice(0, max);
const base = (req) => `/courses/${req.course.id}/assignments`;
const MAX_FILES = 5;

// ---------- Course assignment list ----------

router.get('/assignments', (req, res) => {
  if (req.courseRole === 'instructor') {
    const rows = db.prepare(`
      SELECT a.*, gs.name AS group_set_name,
        (SELECT COUNT(*) FROM submissions s WHERE s.assignment_id = a.id) AS submission_count
      FROM assignments a LEFT JOIN group_sets gs ON gs.id = a.group_set_id
      WHERE a.course_id = ? ORDER BY a.due_at`).all(req.course.id);
    return res.render('course/assignments', { title: `Assignments · ${req.course.code}`, tab: 'assignments', rows, items: null });
  }
  const items = cw.studentAssignments(req.user.id, { courseId: req.course.id });
  res.render('course/assignments', { title: `Assignments · ${req.course.code}`, tab: 'assignments', items, rows: null });
});

router.get('/assignments/new', instructorOnly, (req, res) => renderForm(req, res, {
  a: { kind: 'assignment', timezone: req.user.timezone, points: 100, submission_types: 'file', allowed_extensions: 'pdf,docx', max_file_mb: 10, allow_resubmission: 1, allow_late: 1, group_grading: 'shared' },
}));

// ---------- Submission rules ----------

/** Whether the student may submit now, and if not, a plain-language reason. */
function submissionWindow(a, state, now = nowIso()) {
  if (!a.published) return { ok: false, reason: 'This assignment is not published yet.' };
  if (a.available_from && now < a.available_from) return { ok: false, reason: `Submissions open ${fmtDateTime(a.available_from, a.timezone)}.` };
  if (a.available_until && now > a.available_until) return { ok: false, reason: 'The submission window for this assignment has closed.' };
  if (now > a.due_at && !a.allow_late) return { ok: false, reason: 'The deadline has passed and this assignment does not accept late work.' };
  if (a.group_set_id && !state.group) return { ok: false, reason: 'This is a group assignment. You need to be a confirmed member of a group before you can submit.' };
  if (state.submission) {
    if (!state.credited) return { ok: false, reason: 'Your group submitted before you joined. Ask your instructor to add you to the submission.' };
    if (state.status === 'graded' && state.submission.status !== 'returned') return { ok: false, reason: 'This work has been graded. Resubmission is closed unless your instructor returns it for revision.' };
    if (!a.allow_resubmission && state.submission.status !== 'returned') return { ok: false, reason: 'This assignment allows one submission, which you have already made.' };
  }
  return { ok: true };
}

function detailLocals(req, extra = {}) {
  const a = req.assignment;
  const groupSet = a.group_set_id ? db.prepare('SELECT * FROM group_sets WHERE id = ?').get(a.group_set_id) : null;
  return { title: a.title, tab: 'assignments', groupSet, types: a.submission_types.split(','), ...extra };
}

function renderStudentView(req, res, { errors = [], draft = {}, status = 200, preview = false } = {}) {
  const a = req.assignment;
  // In preview, instructors see exactly what an enrolled student without work would see.
  const state = preview ? { submission: null, grade: null, group: null, status: 'not_submitted', statusLabel: cw.STATUS.not_submitted.label, statusIcon: '○', pastDue: a.due_at < nowIso() }
    : cw.studentState(a, req.user.id);
  const versions = state.submission && (state.credited || state.group) ? cw.versionsFor(state.submission.id) : [];
  const credited = state.submission ? cw.creditedStudents(state.submission.id) : [];
  const window = preview ? { ok: true } : submissionWindow(a, state);
  res.status(status).render('course/assignment', detailLocals(req, {
    state, versions, credited, window, errors, draft, preview,
    idempotencyKey: crypto.randomUUID(),
  }));
}

// ---------- Detail / preview ----------

router.get('/assignments/:aid', (req, res) => {
  if (req.courseRole === 'instructor') {
    const roster = cw.submissionRoster(req.assignment);
    const counts = { submitted: roster.filter((r) => r.submission).length, total: roster.length };
    return res.render('course/assignment-instructor', detailLocals(req, { counts }));
  }
  return renderStudentView(req, res);
});

router.get('/assignments/:aid/preview', instructorOnly, (req, res) => renderStudentView(req, res, { preview: true }));

// ---------- Submit ----------

function uploadFor(a) {
  return multer({ storage: multer.memoryStorage(), limits: { fileSize: a.max_file_mb * 1048576, files: MAX_FILES, fields: 20 } }).array('files', MAX_FILES);
}

router.post('/assignments/:aid/submit', (req, res, next) => {
  if (req.courseRole !== 'student') return notFound(res);
  uploadFor(req.assignment)(req, res, (err) => {
    if (err) {
      req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? `One of the files is larger than the ${req.assignment.max_file_mb} MB limit. Nothing was submitted.`
        : err.code === 'LIMIT_FILE_COUNT' ? `You can attach at most ${MAX_FILES} files.` : 'The upload was interrupted. Nothing was submitted — please try again.';
    }
    csrfCheck(req, res, () => {
      try { handleSubmit(req, res); } catch (e) { next(e); }
    });
  });
});

function handleSubmit(req, res) {
  const a = req.assignment;
  const key = str(req.body.idempotency_key, 64);
  const draft = { body_text: str(req.body.body_text), link_url: str(req.body.link_url, 500) };
  const fail = (msg, status = 400) => renderStudentView(req, res, { errors: [].concat(msg), draft, status });

  // A retried or double-clicked submit returns the original receipt instead of a duplicate.
  const prior = key && db.prepare(`
    SELECT v.* FROM submission_versions v JOIN submission_credits sc ON sc.submission_id = v.submission_id
    WHERE v.idempotency_key = ? AND sc.student_id = ?`).get(key, req.user.id);
  if (prior) return res.redirect(`${base(req)}/${a.id}/receipt?v=${prior.version}`);
  if (!key) return fail('The form was incomplete. Refresh the page and try again.');
  if (req.uploadError) return fail(req.uploadError);

  const state = cw.studentState(a, req.user.id);
  const window = submissionWindow(a, state);
  if (!window.ok) return fail(window.reason, 409);

  const types = a.submission_types.split(',');
  const files = types.includes('file') ? req.files || [] : [];
  const errors = [];
  if (!req.body.confirm) errors.push(a.group_set_id ? 'Confirm that this submission is for your group and its listed members.' : 'Tick the confirmation box to submit.');
  if (a.group_set_id && Number(req.body.group_id) !== state.group.id) errors.push('Your group membership changed while you were on this page. Review the members below and submit again.');
  const text = types.includes('text') ? draft.body_text : '';
  const link = types.includes('link') ? draft.link_url : '';
  if (link && !/^https?:\/\/\S+$/i.test(link)) errors.push('The link must be a full web address starting with https://.');
  if (!files.length && !text && !link) errors.push(`Add your work before submitting: ${types.map((t) => ({ file: 'a file', text: 'a text response', link: 'a link' }[t])).join(' or ')}.`);
  const allowed = a.allowed_extensions.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  for (const f of files) {
    const e = storage.validateFile(f, allowed, a.max_file_mb * 1048576);
    if (e) errors.push(e);
  }
  if (errors.length) return fail(errors);

  // Write files first, then record everything in one transaction. On any failure
  // the files are removed and no success is shown.
  const stored = files.map((f) => ({ f, name: storage.save(f.buffer, f.originalname) }));
  let result;
  try {
    result = db.transaction(() => {
      const now = nowIso();
      const fresh = cw.studentState(a, req.user.id, now);
      const w = submissionWindow(a, fresh, now);
      if (!w.ok) throw Object.assign(new Error(w.reason), { userMessage: w.reason });
      const late = now > a.due_at ? 1 : 0;
      let sub = fresh.submission;
      if (!sub) {
        const info = db.prepare(`INSERT INTO submissions (assignment_id, student_id, group_id, status, current_version, first_submitted_at, last_submitted_at)
                                 VALUES (?,?,?,?,1,?,?)`).run(a.id, a.group_set_id ? null : req.user.id, a.group_set_id ? fresh.group.id : null, late ? 'late' : 'submitted', now, now);
        sub = { id: info.lastInsertRowid, current_version: 0 };
      }
      const version = sub.current_version + 1;
      if (version > 1) {
        db.prepare(`UPDATE submissions SET status = 'resubmitted', current_version = ?, last_submitted_at = ? WHERE id = ?`).run(version, now, sub.id);
      }
      const v = db.prepare(`INSERT INTO submission_versions (submission_id, version, submitted_by, submitted_at, is_late, body_text, link_url, idempotency_key)
                            VALUES (?,?,?,?,?,?,?,?)`).run(sub.id, version, req.user.id, now, late, text || null, link || null, key);
      for (const { f, name } of stored) {
        db.prepare('INSERT INTO submission_files (version_id, original_name, stored_name, size, mime) VALUES (?,?,?,?,?)')
          .run(v.lastInsertRowid, f.originalname, name, f.size, f.mimetype);
      }
      // Credit the owner, or every confirmed group member. Members already credited
      // for this assignment elsewhere are skipped, never double-credited.
      const members = a.group_set_id ? fresh.group.members.map((m) => m.id) : [req.user.id];
      const credit = db.prepare('INSERT OR IGNORE INTO submission_credits (submission_id, student_id, assignment_id) VALUES (?,?,?)');
      for (const id of members) credit.run(sub.id, id, a.id);
      return { submissionId: sub.id, version, versionId: v.lastInsertRowid, members };
    })();
  } catch (e) {
    for (const s of stored) storage.remove(s.name);
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' && /idempotency_key/.test(e.message)) {
      return res.redirect(`${base(req)}/${a.id}/receipt`);
    }
    if (e.userMessage) return fail(e.userMessage, 409);
    console.error(e);
    return fail('Your work could not be saved, so nothing was submitted. Your text has been kept below — please try again.', 500);
  }

  const credited = cw.creditedStudents(result.submissionId).map((s) => s.id);
  notify(credited, {
    kind: 'receipt', title: `Submission received: ${a.title}${result.version > 1 ? ` (version ${result.version})` : ''}`,
    link: `${base(req)}/${a.id}/receipt?v=${result.version}`, courseId: req.course.id, dedupeKey: `receipt:${result.versionId}`,
  });
  req.flash('success', 'Submission received. Keep this receipt for your records.');
  return res.redirect(`${base(req)}/${a.id}/receipt?v=${result.version}`);
}

// ---------- Receipt ----------

router.get('/assignments/:aid/receipt', (req, res) => {
  const a = req.assignment;
  let submission;
  if (req.courseRole === 'instructor') {
    submission = req.query.s && db.prepare('SELECT * FROM submissions WHERE id = ? AND assignment_id = ?').get(req.query.s, a.id);
  } else {
    const st = cw.submissionForStudent(a, req.user.id);
    submission = st.submission;
  }
  if (!submission) return notFound(res);
  const versions = cw.versionsFor(submission.id);
  const v = versions.find((x) => x.version === Number(req.query.v)) || versions[0];
  const group = submission.group_id ? db.prepare('SELECT * FROM groups WHERE id = ?').get(submission.group_id) : null;
  res.render('course/receipt', { title: `Receipt · ${a.title}`, tab: 'assignments', submission, v, versions, group, credited: cw.creditedStudents(submission.id) });
});

// ---------- Instructor: create / edit / publish ----------

const KINDS = ['assignment', 'quiz', 'task'];

function readAssignment(req, existing = {}) {
  const tz = isValidZone(req.body.timezone) ? req.body.timezone : req.user.timezone;
  const types = [].concat(req.body.submission_types || []).filter((t) => ['file', 'text', 'link'].includes(t));
  const a = {
    ...existing,
    title: str(req.body.title, 200),
    kind: KINDS.includes(req.body.kind) ? req.body.kind : 'assignment',
    instructions: str(req.body.instructions),
    timezone: tz,
    due_at: fromLocalInput(req.body.due_at, tz),
    available_from: fromLocalInput(req.body.available_from, tz),
    available_until: fromLocalInput(req.body.available_until, tz),
    points: Number(req.body.points),
    submission_types: types.join(','),
    allowed_extensions: str(req.body.allowed_extensions, 200).toLowerCase().split(/[\s,]+/).map((e) => e.replace(/^\./, '')).filter(Boolean).join(','),
    max_file_mb: Number(req.body.max_file_mb) || 10,
    allow_resubmission: req.body.allow_resubmission ? 1 : 0,
    allow_late: req.body.allow_late ? 1 : 0,
    late_policy: str(req.body.late_policy, 1000),
    group_set_id: Number(req.body.group_set_id) || null,
    group_grading: req.body.group_grading === 'individual' ? 'individual' : 'shared',
  };
  const errors = [];
  if (!a.title) errors.push('Enter a title.');
  if (!a.due_at) errors.push('Enter a valid due date and time.');
  if (a.available_from && a.due_at && a.available_from > a.due_at) errors.push('The availability start must be before the due date.');
  if (a.available_until && a.due_at && a.available_until < a.due_at) errors.push('The availability end must be on or after the due date.');
  if (!Number.isFinite(a.points) || a.points < 0 || a.points > 10000) errors.push('Points must be a number between 0 and 10000.');
  if (!types.length) errors.push('Choose at least one way for students to submit.');
  if (types.includes('file') && !a.allowed_extensions) errors.push('List the accepted file types, e.g. pdf, docx.');
  if (a.max_file_mb < 1 || a.max_file_mb > 100) errors.push('The file size limit must be between 1 and 100 MB.');
  if (a.group_set_id && !db.prepare('SELECT 1 FROM group_sets WHERE id = ? AND course_id = ?').get(a.group_set_id, req.course.id)) errors.push('Choose a group set from this course.');
  if (existing.id && (existing.group_set_id || null) !== a.group_set_id
      && db.prepare('SELECT 1 FROM submissions WHERE assignment_id = ?').get(existing.id)) {
    errors.push('Students have already submitted, so this assignment cannot be switched between individual and group work.');
  }
  return { a, errors };
}

function renderForm(req, res, { a, errors = [], status = 200 }) {
  const groupSets = db.prepare('SELECT * FROM group_sets WHERE course_id = ? ORDER BY name').all(req.course.id);
  res.status(status).render('course/assignment-form', { title: a.id ? `Edit ${a.title}` : 'New assignment', tab: 'assignments', a, errors, groupSets });
}

router.post('/assignments', instructorOnly, (req, res) => {
  const { a, errors } = readAssignment(req);
  if (errors.length) return renderForm(req, res, { a, errors, status: 400 });
  const now = nowIso();
  const info = db.prepare(`
    INSERT INTO assignments (course_id, title, kind, instructions, due_at, available_from, available_until, timezone, points, submission_types,
      allowed_extensions, max_file_mb, allow_resubmission, allow_late, late_policy, group_set_id, group_grading, published, created_at, updated_at)
    VALUES (@course_id, @title, @kind, @instructions, @due_at, @available_from, @available_until, @timezone, @points, @submission_types,
      @allowed_extensions, @max_file_mb, @allow_resubmission, @allow_late, @late_policy, @group_set_id, @group_grading, 0, @now, @now)`)
    .run({ ...a, course_id: req.course.id, now });
  req.flash('success', 'Draft saved. Preview it below, then publish when it is ready.');
  res.redirect(`${base(req)}/${info.lastInsertRowid}/preview`);
});

router.get('/assignments/:aid/edit', instructorOnly, (req, res) => renderForm(req, res, { a: req.assignment }));

router.post('/assignments/:aid', instructorOnly, (req, res) => {
  const old = req.assignment;
  const { a, errors } = readAssignment(req, old);
  if (errors.length) return renderForm(req, res, { a, errors, status: 400 });
  db.prepare(`
    UPDATE assignments SET title=@title, kind=@kind, instructions=@instructions, due_at=@due_at, available_from=@available_from,
      available_until=@available_until, timezone=@timezone, points=@points, submission_types=@submission_types,
      allowed_extensions=@allowed_extensions, max_file_mb=@max_file_mb, allow_resubmission=@allow_resubmission,
      allow_late=@allow_late, late_policy=@late_policy, group_set_id=@group_set_id, group_grading=@group_grading, updated_at=@now
    WHERE id=@id`).run({ ...a, now: nowIso() });

  if (old.published) {
    const students = courseStudentIds(req.course.id);
    if (old.due_at !== a.due_at) {
      audit({ actorId: req.user.id, action: 'assignment.due_changed', entityType: 'assignment', entityId: old.id, courseId: req.course.id, before: { due_at: old.due_at }, after: { due_at: a.due_at } });
      notify(students, { kind: 'due_changed', title: `Due date changed: ${a.title}`, link: `${base(req)}/${old.id}`, courseId: req.course.id, dedupeKey: `due:${old.id}:${a.due_at}` });
    } else if (old.instructions !== a.instructions || old.title !== a.title || old.points !== a.points) {
      audit({ actorId: req.user.id, action: 'assignment.changed', entityType: 'assignment', entityId: old.id, courseId: req.course.id });
      notify(students, { kind: 'assignment_changed', title: `Assignment updated: ${a.title}`, link: `${base(req)}/${old.id}`, courseId: req.course.id, dedupeKey: `changed:${old.id}:${nowIso().slice(0, 13)}` });
    }
  }
  req.flash('success', old.published ? 'Changes saved and students notified.' : 'Draft updated.');
  res.redirect(`${base(req)}/${old.id}${old.published ? '' : '/preview'}`);
});

router.post('/assignments/:aid/publish', instructorOnly, (req, res) => {
  const a = req.assignment;
  const published = a.published ? 0 : 1;
  if (!published && db.prepare('SELECT 1 FROM submissions WHERE assignment_id = ?').get(a.id)) {
    req.flash('error', 'Students have already submitted work, so this assignment cannot be unpublished.');
    return res.redirect(`${base(req)}/${a.id}`);
  }
  db.prepare('UPDATE assignments SET published = ?, updated_at = ? WHERE id = ?').run(published, nowIso(), a.id);
  audit({ actorId: req.user.id, action: published ? 'assignment.published' : 'assignment.unpublished', entityType: 'assignment', entityId: a.id, courseId: req.course.id });
  if (published) {
    notify(courseStudentIds(req.course.id), { kind: 'assignment_published', title: `New ${a.kind}: ${a.title}`, link: `${base(req)}/${a.id}`, courseId: req.course.id, dedupeKey: `published:${a.id}` });
  }
  req.flash('success', published ? `“${a.title}” is published and students have been notified.` : `“${a.title}” is hidden from students.`);
  res.redirect(`${base(req)}/${a.id}`);
});

module.exports = router;
module.exports.submissionWindow = submissionWindow;
