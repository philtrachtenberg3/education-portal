'use strict';
const express = require('express');
const multer = require('multer');
const { db, nowIso } = require('../db');
const { instructorOnly, notFound } = require('../lib/authz');
const { csrfCheck } = require('../lib/auth');
const { audit } = require('../lib/audit');
const storage = require('../lib/storage');

const router = express.Router({ mergeParams: true });
const RESOURCE_MAX = 50 * 1048576;
const RESOURCE_TYPES = ['pdf', 'docx', 'pptx', 'xlsx', 'zip', 'png', 'jpg', 'jpeg', 'txt', 'md', 'csv', 'py', 'ipynb'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: RESOURCE_MAX, files: 1 } }).single('file');

const KINDS = { lecture: 'Lecture slides', reading: 'Reading', recording: 'Recording / link', activity: 'Activity', reference: 'Reference', assessment: 'Assessment info' };
const PAGE = 25;
const str = (v, max = 5000) => String(v ?? '').trim().slice(0, max);
const base = (req) => `/courses/${req.course.id}/materials`;

router.get('/materials', (req, res) => {
  const isInstructor = req.courseRole === 'instructor';
  const asStudent = !isInstructor || req.query.as === 'student';
  const q = str(req.query.q, 100);
  const kind = KINDS[req.query.kind] ? req.query.kind : '';
  const moduleId = Number(req.query.module) || null;
  const sort = ['module', 'newest', 'title'].includes(req.query.sort) ? req.query.sort : 'module';

  const where = ['r.course_id = ?'];
  const params = [req.course.id];
  if (asStudent) where.push('r.published = 1');
  if (q) {
    where.push("(r.title LIKE ? ESCAPE '\\' OR r.description LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    params.push(like, like);
  }
  if (kind) { where.push('r.kind = ?'); params.push(kind); }
  if (moduleId) { where.push('r.module_id = ?'); params.push(moduleId); }
  const order = { module: 'COALESCE(m.position, 9999), r.position, r.title', newest: 'r.updated_at DESC', title: 'r.title COLLATE NOCASE' }[sort];
  const all = db.prepare(`
    SELECT r.*, m.title AS module_title, m.position AS module_position, u.name AS uploader
    FROM resources r LEFT JOIN modules m ON m.id = r.module_id JOIN users u ON u.id = r.uploader_id
    WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(...params);
  const modules = db.prepare('SELECT * FROM modules WHERE course_id = ? ORDER BY position, id').all(req.course.id);

  // Grouped by module when browsing; a flat, paginated list when searching or sorting.
  const grouped = sort === 'module' && !q;
  let groups = null;
  let items = all;
  let page = 1;
  let pages = 1;
  if (grouped) {
    groups = modules.map((m) => ({ module: m, items: all.filter((r) => r.module_id === m.id) })).filter((g) => g.items.length || (isInstructor && !asStudent && !kind && !moduleId));
    const loose = all.filter((r) => !r.module_id);
    if (loose.length) groups.push({ module: { id: null, title: 'Other materials' }, items: loose });
  } else {
    page = Math.max(1, Number(req.query.page) || 1);
    pages = Math.max(1, Math.ceil(all.length / PAGE));
    items = all.slice((page - 1) * PAGE, page * PAGE);
  }
  res.render('course/materials', {
    title: `Materials · ${req.course.code}`, tab: 'materials', groups, items, total: all.length, modules, KINDS,
    filters: { q, kind, module: moduleId, sort }, asStudent, isInstructor, page, pages,
  });
});

router.post('/modules', instructorOnly, (req, res) => {
  const title = str(req.body.title, 120);
  if (!title) { req.flash('error', 'Give the module a name.'); return res.redirect(base(req)); }
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM modules WHERE course_id = ?').get(req.course.id).p;
  db.prepare('INSERT INTO modules (course_id, title, position) VALUES (?,?,?)').run(req.course.id, title, pos);
  req.flash('success', `Module “${title}” added.`);
  res.redirect(base(req));
});

const loadResource = (req, res, next) => {
  const r = db.prepare('SELECT * FROM resources WHERE id = ? AND course_id = ?').get(req.params.rid, req.course.id);
  if (!r) return notFound(res);
  req.resource = r;
  next();
};

function renderForm(req, res, { resource, errors = [], status = 200 }) {
  const modules = db.prepare('SELECT * FROM modules WHERE course_id = ? ORDER BY position').all(req.course.id);
  res.status(status).render('course/resource-form', {
    title: resource.id ? `Edit ${resource.title}` : 'Add material', tab: 'materials', resource, modules, KINDS, errors,
    accept: RESOURCE_TYPES.map((e) => '.' + e).join(','), maxMb: RESOURCE_MAX / 1048576,
  });
}

// Runs multer and turns its errors (e.g. file too large) into a form error.
function withUpload(handler) {
  return (req, res, next) => upload(req, res, (err) => {
    if (err) {
      req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? `The file is larger than the ${RESOURCE_MAX / 1048576} MB limit.` : 'The file could not be uploaded. Please try again.';
    }
    return csrfCheck(req, res, () => handler(req, res, next));
  });
}

function readForm(req, existing) {
  const r = {
    ...existing,
    title: str(req.body.title, 200), description: str(req.body.description, 2000),
    kind: KINDS[req.body.kind] ? req.body.kind : 'reading', url: str(req.body.url, 500) || null,
    module_id: Number(req.body.module_id) || null, published: req.body.published ? 1 : 0,
  };
  const errors = [];
  if (req.uploadError) errors.push(req.uploadError);
  if (!r.title) errors.push('Enter a title.');
  if (r.module_id && !db.prepare('SELECT 1 FROM modules WHERE id = ? AND course_id = ?').get(r.module_id, req.course.id)) errors.push('Choose a module from this course.');
  if (r.url && !/^https?:\/\//i.test(r.url)) errors.push('Links must start with http:// or https://.');
  if (req.file) {
    const e = storage.validateFile(req.file, RESOURCE_TYPES, RESOURCE_MAX);
    if (e) errors.push(e);
  }
  if (!req.file && !r.url && !existing?.stored_name) errors.push('Attach a file or enter a link.');
  return { r, errors };
}

router.get('/materials/new', instructorOnly, (req, res) => renderForm(req, res, {
  resource: { kind: req.query.kind || 'reading', module_id: Number(req.query.module) || null, published: 0 },
}));

router.post('/materials', instructorOnly, withUpload((req, res) => {
  const { r, errors } = readForm(req, {});
  if (errors.length) return renderForm(req, res, { resource: r, errors, status: 400 });
  const stored = req.file ? storage.save(req.file.buffer, req.file.originalname) : null;
  const now = nowIso();
  try {
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM resources WHERE course_id = ? AND module_id IS ?').get(req.course.id, r.module_id).p;
    const info = db.prepare(`
      INSERT INTO resources (course_id, module_id, title, description, kind, url, file_name, stored_name, file_size, position, published, uploader_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.course.id, r.module_id, r.title, r.description, r.kind, r.url,
      req.file?.originalname || null, stored, req.file?.size || null, pos, r.published, req.user.id, now, now);
    if (r.published) audit({ actorId: req.user.id, action: 'resource.published', entityType: 'resource', entityId: info.lastInsertRowid, courseId: req.course.id, after: { title: r.title } });
  } catch (e) {
    storage.remove(stored);
    throw e;
  }
  req.flash('success', r.published ? `“${r.title}” is published to students.` : `“${r.title}” saved as a draft. Students cannot see it until you publish it.`);
  res.redirect(base(req));
}));

router.get('/materials/:rid/edit', instructorOnly, loadResource, (req, res) => renderForm(req, res, { resource: req.resource }));

router.post('/materials/:rid', instructorOnly, loadResource, withUpload((req, res) => {
  const old = req.resource;
  const { r, errors } = readForm(req, old);
  if (errors.length) return renderForm(req, res, { resource: r, errors, status: 400 });
  // Replacing a file keeps the same record (and its place in the module); only the file changes.
  const stored = req.file ? storage.save(req.file.buffer, req.file.originalname) : old.stored_name;
  db.prepare(`
    UPDATE resources SET module_id = ?, title = ?, description = ?, kind = ?, url = ?, file_name = ?, stored_name = ?, file_size = ?, published = ?, updated_at = ?
    WHERE id = ?`).run(r.module_id, r.title, r.description, r.kind, r.url, req.file?.originalname || old.file_name, stored,
    req.file?.size || old.file_size, r.published, nowIso(), old.id);
  if (req.file && old.stored_name) storage.remove(old.stored_name);
  if (old.published !== r.published) {
    audit({ actorId: req.user.id, action: r.published ? 'resource.published' : 'resource.unpublished', entityType: 'resource', entityId: old.id, courseId: req.course.id });
  }
  req.flash('success', req.file ? `File replaced for “${r.title}”.` : `“${r.title}” updated.`);
  res.redirect(base(req));
}));

router.post('/materials/:rid/publish', instructorOnly, loadResource, (req, res) => {
  const published = req.resource.published ? 0 : 1;
  db.prepare('UPDATE resources SET published = ?, updated_at = ? WHERE id = ?').run(published, nowIso(), req.resource.id);
  audit({ actorId: req.user.id, action: published ? 'resource.published' : 'resource.unpublished', entityType: 'resource', entityId: req.resource.id, courseId: req.course.id });
  req.flash('success', `“${req.resource.title}” is now ${published ? 'visible to students' : 'hidden from students'}.`);
  res.redirect(`${base(req)}#resource-${req.resource.id}`);
});

module.exports = router;
