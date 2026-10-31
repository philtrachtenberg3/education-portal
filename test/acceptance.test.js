'use strict';
// End-to-end checks for the MVP acceptance criteria (spec section 11), run against
// a freshly seeded database in a temporary directory.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'slp-test-'));
const { seed } = require('../src/seed');
seed();
const { db } = require('../src/db');
const app = require('../src/server');

let server;
let BASE;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

// ---------- helpers ----------

const q = (sql, ...a) => db.prepare(sql).get(...a);
const qa = (sql, ...a) => db.prepare(sql).all(...a);
const userId = (local) => q('SELECT id FROM users WHERE email = ?', `${local}@demo.example.edu`).id;
const assignmentId = (title) => q('SELECT id, course_id FROM assignments WHERE title LIKE ?', `${title}%`);

class Client {
  constructor() { this.cookie = ''; }
  async login(local) {
    const r = await fetch(`${BASE}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: `${local}@demo.example.edu`, password: 'demo1234' }),
    });
    assert.equal(r.status, 302, `login failed for ${local}`);
    this.cookie = r.headers.get('set-cookie').split(';')[0];
    return this;
  }
  get(p) { return fetch(BASE + p, { headers: { cookie: this.cookie }, redirect: 'manual' }); }
  async html(p) {
    const r = await this.get(p);
    return { status: r.status, body: await r.text() };
  }
  async csrf() {
    const { body } = await this.html('/settings');
    return /name="_csrf" value="([^"]+)"/.exec(body)[1];
  }
  async post(p, fields = {}, { csrf = true } = {}) {
    const body = new URLSearchParams(fields);
    if (csrf) body.set('_csrf', await this.csrf());
    return fetch(BASE + p, { method: 'POST', redirect: 'manual', headers: { cookie: this.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body });
  }
  async upload(p, fields = {}, files = []) {
    const form = new FormData();
    form.set('_csrf', await this.csrf());
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const f of files) form.append(f.field || 'files', new Blob([f.data]), f.name);
    return fetch(BASE + p, { method: 'POST', redirect: 'manual', headers: { cookie: this.cookie }, body: form });
  }
}
const as = (local) => new Client().login(local);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

// ---------- 1. Cross-course dashboard ----------

test('1. dashboard shows upcoming work from several courses, sorted, with course and deadline', async () => {
  const maya = await as('maya.okafor');
  const { body } = await maya.html('/dashboard');
  const dueSoon = body.slice(body.indexOf('id="due-card"'), body.indexOf('id="due-live"'));
  const codes = [...dueSoon.matchAll(/class="course-chip"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.ok(new Set(codes).size >= 3, `expected several courses, got ${codes}`);
  const titles = [...dueSoon.matchAll(/class="item-title" href="\/courses\/\d+\/assignments\/(\d+)"/g)].map((m) => Number(m[1]));
  const dues = titles.map((id) => q('SELECT due_at FROM assignments WHERE id = ?', id).due_at);
  assert.deepEqual(dues, [...dues].sort(), 'due soon list must be sorted by due date');
  assert.match(dueSoon, /Due \w{3} \d+ \w{3} \d{4}, <\/span>\w{3} \d+:\d{2} [AP]M E[SD]T/, 'full deadline for screen readers, day and time with zone shown');
  assert.ok(!dueSoon.includes('Problem Set 5'), 'unpublished draft must not appear');
});

test('1b. dashboard filters upcoming work by date range or by class, and remembers the choice', async () => {
  const maya = await as('maya.okafor');
  const now = Date.now();
  const listed = (body) => {
    const card = body.slice(body.indexOf('id="due-card"'), body.indexOf('id="due-live"'));
    return [...card.matchAll(/class="item-title" href="\/courses\/(\d+)\/assignments\/(\d+)"/g)]
      .map((m) => q('SELECT id, course_id, due_at FROM assignments WHERE id = ?', Number(m[2])));
  };

  // By date: next 3 days only contains work due within 3 days.
  const r3 = await maya.get('/dashboard?due=date&range=3d');
  assert.match(r3.headers.get('set-cookie') || '', /slp_due=/);
  const in3 = listed(await r3.text());
  assert.ok(in3.length > 0);
  assert.ok(in3.every((a) => Date.parse(a.due_at) >= now && Date.parse(a.due_at) <= now + 3 * 864e5 + 60e3));

  // Custom range with the end before the start is reported, not silently accepted.
  const bad = await maya.html('/dashboard?due=date&range=custom&from=2026-12-10&to=2026-12-01');
  assert.match(bad.body, /end date is before the start date/);

  // By class, one course, whole course: only that course, including earlier work.
  const cs = q(`SELECT id FROM courses WHERE code = 'CS 220'`).id;
  const whole = await maya.html(`/dashboard?due=class&course=${cs}&span=all`);
  const items = listed(whole.body);
  assert.ok(items.every((a) => a.course_id === cs), 'only the chosen class');
  const published = q('SELECT COUNT(*) AS n FROM assignments WHERE course_id = ? AND published = 1', cs).n;
  assert.equal(items.length, published, 'whole course lists every published item');
  assert.match(whole.body, /<h4 class="due-earlier">Earlier<\/h4>/);

  // All classes: one boxed section per enrolled course.
  const all = await maya.html('/dashboard?due=class&course=&span=30d');
  for (const c of qa(`SELECT course_id FROM enrollments WHERE user_id = ? AND role = 'student'`, userId('maya.okafor'))) {
    assert.ok(all.body.includes(`id="due-c${c.course_id}"`));
  }

  // Without query parameters, the remembered cookie restores the last choice.
  const saved = /slp_due=([^;]+)/.exec(r3.headers.get('set-cookie'))[1];
  const again = await fetch(`${BASE}/dashboard`, { headers: { cookie: `${maya.cookie}; slp_due=${saved}` } });
  assert.match(await again.text(), /data-key="range-3d" aria-current="true"/);
});

test('1c. search finds items only in the user’s own courses, and hides drafts from students', async () => {
  const maya = await as('maya.okafor');
  const hit = await maya.html('/search?q=hash');
  assert.match(hit.body, /Problem Set 4: Hash tables/);
  assert.match(hit.body, /Reading: Hash tables/);
  // Draft resource in CS 220 must not appear for students, but does for the instructor.
  assert.ok(!(await maya.html('/search?q=red-black')).body.includes('Red-black trees'));
  const prof = await as('elena.vasquez');
  assert.match((await prof.html('/search?q=red-black')).body, /Red-black trees/);
  // A course Maya is not enrolled in never shows up.
  db.prepare(`INSERT INTO courses (code, title, term_id) VALUES ('GEO 300', 'Hashing the Earth', 1)`).run();
  assert.ok(!(await maya.html('/search?q=hashing')).body.includes('GEO 300'));
  // Admins have no course search.
  assert.equal((await (await as('admin')).get('/search?q=hash')).status, 403);
});

// ---------- 2. Grades across courses ----------

test('2. one grades view distinguishes graded, not graded, excused and not submitted; hides unreleased', async () => {
  const maya = await as('maya.okafor');
  const { body } = await maya.html('/grades');
  for (const code of ['CS 220', 'ENV 210', 'HIST 145', 'STAT 201']) assert.ok(body.includes(code));
  assert.match(body, /87 \/ 100/, 'released score shown');
  assert.match(body, /Excused/, 'excused is labelled');
  assert.match(body, /Not graded yet/, 'submitted-but-ungraded is labelled');
  assert.match(body, /Not submitted/, 'missing work is labelled');
  assert.ok(!body.includes('81 / 100'), 'unreleased Essay 1 grade must not leak');
});

// ---------- 3. Timetable ----------

test('3. weekly timetable distinguishes class meetings from due dates in text', async () => {
  const maya = await as('maya.okafor');
  const { body } = await maya.html('/calendar');
  assert.match(body, /Class · lecture/);
  assert.match(body, /<span class="type"><span aria-hidden="true">⚑<\/span> Due/);
  const nextWeek = /href="\?week=([\d-]+)">Next week/.exec(body)[1];
  const { body: nw } = await maya.html(`/calendar?week=${nextWeek}`);
  assert.match(nw, /Cancelled/, 'cancelled meeting exception shown');
  const ics = await (await maya.get('/calendar.ics')).text();
  assert.match(ics, /BEGIN:VCALENDAR[\s\S]*SUMMARY:CS 220 Class: Lecture/);
});

// ---------- 4. Materials ----------

test('4. a reading can be found by browsing its module and by searching', async () => {
  const maya = await as('maya.okafor');
  const cs = q(`SELECT id FROM courses WHERE code = 'CS 220'`).id;
  const browse = await maya.html(`/courses/${cs}/materials`);
  const start = browse.body.search(/<h2 id="mod-\d+">Week 7 · Hash tables<\/h2>/);
  const week7 = browse.body.slice(start, browse.body.indexOf('<h2', start + 10));
  assert.match(week7, /Reading: Hash tables/);
  const search = await maya.html(`/courses/${cs}/materials?q=course+notes`);
  assert.match(search.body, /Reading: Hash tables/);
  assert.ok(!search.body.includes('Big-O cheat sheet'));
  assert.ok(!browse.body.includes('Red-black trees'), 'unpublished resource hidden from students');
  const file = q(`SELECT id FROM resources WHERE title LIKE 'Reading: Hash%'`).id;
  const dl = await maya.get(`/files/resources/${file}`);
  assert.equal(dl.status, 200);
});

// ---------- 5. Individual submission, receipt, resubmission history, no duplicates ----------

test('5. individual submission gives a receipt; resubmission keeps history; retries do not duplicate', async () => {
  const maya = await as('maya.okafor');
  const a = assignmentId('Problem Set 4');
  const url = `/courses/${a.course_id}/assignments/${a.id}`;
  const key1 = 'test-key-ps4-1';
  const r1 = await maya.upload(`${url}/submit`, { idempotency_key: key1, confirm: '1' }, [{ name: 'hashmap.py', data: 'class HashMap:\n    pass\n' }]);
  assert.equal(r1.status, 302);
  assert.match(r1.headers.get('location'), /receipt\?v=1/);
  const receipt = await maya.html(r1.headers.get('location'));
  assert.match(receipt.body, /Submission receipt/);
  assert.match(receipt.body, /hashmap\.py/);
  assert.match(receipt.body, /\d{4}, \d+:\d{2} [AP]M/);

  // Same idempotency key again (double click / retry): same receipt, no new version.
  const retry = await maya.upload(`${url}/submit`, { idempotency_key: key1, confirm: '1' }, [{ name: 'hashmap.py', data: 'x = 1\n' }]);
  assert.match(retry.headers.get('location'), /receipt\?v=1/);

  const r2 = await maya.upload(`${url}/submit`, { idempotency_key: 'test-key-ps4-2', confirm: '1' }, [{ name: 'hashmap_v2.py', data: 'x = 2\n' }]);
  assert.match(r2.headers.get('location'), /receipt\?v=2/);
  const sub = q('SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?', a.id, userId('maya.okafor'));
  assert.equal(sub.current_version, 2);
  assert.equal(sub.status, 'resubmitted');
  assert.equal(qa('SELECT * FROM submission_versions WHERE submission_id = ?', sub.id).length, 2);
  const page = await maya.html(url);
  assert.match(page.body, /Version 1/);
  assert.match(page.body, /Version 2/);
});

// ---------- 6. Group submission credited to all members; shared and individual grades ----------

test('6. one group submission credits every confirmed member; instructor grades shared with one override', async () => {
  const maya = await as('maya.okafor');
  const a = assignmentId('Policy brief');
  const url = `/courses/${a.course_id}/assignments/${a.id}`;
  const coastal = q(`SELECT id FROM groups WHERE name = 'Team Coastal'`).id;

  const noConfirm = await maya.upload(`${url}/submit`, { idempotency_key: 'g-0', group_id: String(coastal) }, [{ name: 'brief.pdf', data: PDF }]);
  assert.equal(noConfirm.status, 400, 'group confirmation is required');

  const r = await maya.upload(`${url}/submit`, { idempotency_key: 'g-1', group_id: String(coastal), confirm: '1' }, [{ name: 'brief.pdf', data: PDF }]);
  assert.equal(r.status, 302);
  const subs = qa('SELECT * FROM submissions WHERE assignment_id = ?', a.id);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].group_id, coastal);
  assert.equal(subs[0].student_id, null);
  const credited = qa('SELECT student_id FROM submission_credits WHERE submission_id = ?', subs[0].id).map((x) => x.student_id).sort();
  assert.deepEqual(credited, ['maya.okafor', 'daniel.reyes', 'priya.natarajan'].map(userId).sort());

  // Daniel sees the group's submission without submitting himself.
  const daniel = await as('daniel.reyes');
  assert.match((await daniel.html(url)).body, /Submitted .* by Maya Okafor/);

  const prof = await as('james.whitfield');
  const list = await prof.html(`${url}/submissions`);
  const row = list.body.slice(list.body.indexOf('Team Coastal'), list.body.indexOf('Team Coastal') + 600);
  assert.match(row, /Daniel Reyes, Maya Okafor, Priya Natarajan/);

  const maya_ = userId('maya.okafor');
  const priya = userId('priya.natarajan');
  const g = await prof.post(`${url}/grade/g${coastal}`, { action: 'release', shared_points: '88', shared_feedback: 'Strong options analysis.', [`points_${priya}`]: '92' });
  assert.equal(g.status, 302);
  const grades = Object.fromEntries(qa('SELECT student_id, points, released FROM grades WHERE assignment_id = ?', a.id).map((x) => [x.student_id, x]));
  assert.equal(grades[maya_].points, 88);
  assert.equal(grades[userId('daniel.reyes')].points, 88);
  assert.equal(grades[priya].points, 92, 'individual override applies to one member only');
  assert.ok(Object.values(grades).every((x) => x.released === 1));
});

// ---------- 7. Instructor creates, previews and publishes ----------

test('7. instructor creates a resource and an assignment, previews and publishes them', async () => {
  const prof = await as('elena.vasquez');
  const cs = q(`SELECT id FROM courses WHERE code = 'CS 220'`).id;
  const mod = q('SELECT id FROM modules WHERE course_id = ? ORDER BY position LIMIT 1', cs).id;
  const res = await prof.upload(`/courses/${cs}/materials`, { title: 'Week 10 graph notes', description: 'Adjacency lists vs matrices', kind: 'reading', module_id: String(mod) }, [{ field: 'file', name: 'graphs.pdf', data: PDF }]);
  assert.equal(res.status, 302);
  const maya = await as('maya.okafor');
  assert.ok(!(await maya.html(`/courses/${cs}/materials?q=graph+notes`)).body.includes('Week 10 graph notes'), 'draft hidden');
  const rid = q(`SELECT id FROM resources WHERE title = 'Week 10 graph notes'`).id;
  await prof.post(`/courses/${cs}/materials/${rid}/publish`);
  assert.ok((await maya.html(`/courses/${cs}/materials?q=graph+notes`)).body.includes('Week 10 graph notes'), 'published resource visible');

  const create = await prof.post(`/courses/${cs}/assignments`, {
    title: 'Problem Set 6: Heaps', kind: 'assignment', instructions: 'Implement a binary heap.', timezone: 'America/New_York',
    due_at: '2030-01-15T23:59', points: '100', submission_types: 'file', allowed_extensions: 'py,pdf', max_file_mb: '5', allow_resubmission: '1',
  });
  assert.equal(create.status, 302);
  assert.match(create.headers.get('location'), /\/preview$/);
  const preview = await prof.html(create.headers.get('location'));
  assert.match(preview.body, /Student preview/);
  const aid = Number(/assignments\/(\d+)\/preview/.exec(create.headers.get('location'))[1]);
  assert.equal((await maya.get(`/courses/${cs}/assignments/${aid}`)).status, 404, 'students cannot open a draft');
  await prof.post(`/courses/${cs}/assignments/${aid}/publish`);
  assert.equal((await maya.get(`/courses/${cs}/assignments/${aid}`)).status, 200);
  assert.ok(q(`SELECT 1 FROM notifications WHERE user_id = ? AND dedupe_key = ?`, userId('maya.okafor'), `published:${aid}`));
});

// ---------- 8. Grades visible only after release ----------

test('8. a saved grade stays hidden until released, then the student is notified', async () => {
  const prof = await as('elena.vasquez');
  const maya = await as('maya.okafor');
  const a = assignmentId('Lab 6');
  const url = `/courses/${a.course_id}/assignments/${a.id}`;
  const mid = userId('maya.okafor');
  await prof.post(`${url}/grade/s${mid}`, { action: 'save', [`points_${mid}`]: '9', [`feedback_${mid}`]: 'Great profiling.' });
  let page = await maya.html(url);
  assert.ok(!page.body.includes('Great profiling.'), 'unreleased feedback hidden');
  assert.ok(!page.body.includes('id="feedback"'));
  await prof.post(`${url}/grade/s${mid}`, { action: 'release', [`points_${mid}`]: '9', [`feedback_${mid}`]: 'Great profiling.' });
  page = await maya.html(url);
  assert.match(page.body, /Great profiling\./);
  assert.ok(q(`SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'grade_released' AND link LIKE ?`, mid, `%/assignments/${a.id}#feedback`));
});

// ---------- 9. No access to other students' records by changing identifiers ----------

test('9. students cannot reach other students’ grades, submissions or courses by editing URLs', async () => {
  const maya = await as('maya.okafor');
  const omar = userId('omar.haddad');
  const ps3 = assignmentId('Problem Set 3');
  // grading page for another student (instructor-only)
  assert.equal((await maya.get(`/courses/${ps3.course_id}/assignments/${ps3.id}/grade/s${omar}`)).status, 404);
  assert.equal((await maya.post(`/courses/${ps3.course_id}/assignments/${ps3.id}/grade/s${omar}`, { action: 'release', [`points_${omar}`]: '100' })).status, 404);
  assert.equal(q('SELECT points FROM grades WHERE assignment_id = ? AND student_id = ?', ps3.id, omar).points, 0);
  // gradebook export
  assert.equal((await maya.get(`/courses/${ps3.course_id}/grades.csv`)).status, 404);
  // another student's submission file
  const danielFile = q(`SELECT f.id FROM submission_files f JOIN submission_versions v ON v.id = f.version_id JOIN submissions s ON s.id = v.submission_id WHERE s.student_id = ?`, userId('daniel.reyes')).id;
  assert.equal((await maya.get(`/files/submissions/${danielFile}`)).status, 404);
  // another student's receipt via instructor-only parameter
  const danielSub = q('SELECT id FROM submissions WHERE assignment_id = ? AND student_id = ?', ps3.id, userId('daniel.reyes')).id;
  const rec = await maya.html(`/courses/${ps3.course_id}/assignments/${ps3.id}/receipt?s=${danielSub}`);
  assert.ok(!rec.body.includes('Daniel Reyes'), 'receipt must be the student’s own');
  // a course she is not enrolled in, and an instructor from another course
  const other = db.prepare('INSERT INTO courses (code, title, term_id) VALUES (?,?,1)').run('BIO 110', 'Cell Biology').lastInsertRowid;
  assert.equal((await maya.get(`/courses/${other}`)).status, 404);
  const chen = await as('samira.chen');
  assert.equal((await chen.get(`/courses/${ps3.course_id}/grades`)).status, 404);
  // admin pages
  assert.equal((await maya.get('/admin/users')).status, 403);
  // CSRF: state change without a token is rejected
  assert.equal((await maya.post('/settings', { timezone: 'UTC', reminder_hours: '0' }, { csrf: false })).status, 403);
});

// ---------- 10. Accessible, labelled controls ----------

test('10. core forms have labelled controls and a skip link', async () => {
  const maya = await as('maya.okafor');
  const prof = await as('elena.vasquez');
  const brief = assignmentId('Essay proposal');
  const lab = assignmentId('Lab 6');
  const cs = q(`SELECT id FROM courses WHERE code = 'CS 220'`).id;
  const pages = [
    [maya, '/dashboard'], [maya, '/assignments'], [maya, `/courses/${cs}/materials`],
    [maya, `/courses/${brief.course_id}/assignments/${brief.id}`],
    [prof, `/courses/${lab.course_id}/assignments/${lab.id}/grade/s${userId('maya.okafor')}`],
  ];
  for (const [c, p] of pages) {
    const { body } = await c.html(p);
    assert.match(body, /class="skip-link" href="#main"/, p);
    assert.match(body, /<h1[ >]/, `${p} has an h1`);
    for (const m of body.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      const attrs = m[2];
      if (/type="(hidden|submit)"/.test(attrs)) continue;
      const id = /id="([^"]+)"/.exec(attrs)?.[1];
      const wrapped = body.slice(Math.max(0, m.index - 200), m.index).lastIndexOf('<label') > body.slice(Math.max(0, m.index - 200), m.index).lastIndexOf('</label>');
      assert.ok(wrapped || (id && body.includes(`for="${id}"`)), `${p}: unlabelled ${m[0].slice(0, 80)}`);
    }
  }
});

// ---------- 11. Failed uploads show an error, not success ----------

test('11. invalid or oversized uploads are rejected with a clear error and nothing is saved', async () => {
  const maya = await as('maya.okafor');
  const a = assignmentId('Essay proposal');
  const url = `/courses/${a.course_id}/assignments/${a.id}`;
  const wrongType = await maya.upload(`${url}/submit`, { idempotency_key: 'bad-1', confirm: '1' }, [{ name: 'proposal.exe', data: 'MZ' }]);
  assert.equal(wrongType.status, 400);
  assert.match(await wrongType.text(), /Accepted types: \.pdf, \.docx/);
  const fake = await maya.upload(`${url}/submit`, { idempotency_key: 'bad-2', confirm: '1' }, [{ name: 'proposal.pdf', data: 'not really a pdf' }]);
  assert.equal(fake.status, 400);
  assert.match(await fake.text(), /does not look like a valid \.pdf/);
  const big = Buffer.concat([PDF, Buffer.alloc(11 * 1048576)]);
  const tooBig = await maya.upload(`${url}/submit`, { idempotency_key: 'bad-3', confirm: '1' }, [{ name: 'proposal.pdf', data: big }]);
  assert.equal(tooBig.status, 400);
  assert.match(await tooBig.text(), /larger than the 10 MB limit/);
  assert.equal(qa('SELECT * FROM submissions WHERE assignment_id = ?', a.id).length, 0);

  // Text work is preserved when a submission fails.
  const stat = assignmentId('Homework 6');
  const r = await maya.upload(`/courses/${stat.course_id}/assignments/${stat.id}/submit`, { idempotency_key: 'bad-4', body_text: 'My interval answers…' }, []);
  assert.equal(r.status, 400);
  assert.match(await r.text(), /My interval answers…/);
});

// ---------- 12. Audit trail ----------

test('12. every grade and group-membership change is attributable in the audit log', async () => {
  const prof = await as('james.whitfield');
  const env = q(`SELECT id FROM courses WHERE code = 'ENV 210'`).id;
  const carbon = q(`SELECT id FROM groups WHERE name = 'Team Carbon'`).id;
  const omar = userId('omar.haddad');
  const r = await prof.post(`/courses/${env}/groups/${carbon}/members/${omar}/approve`);
  assert.equal(r.status, 302);
  assert.equal(q(`SELECT status FROM group_memberships WHERE group_id = ? AND user_id = ? AND status <> 'removed'`, carbon, omar).status, 'confirmed');
  const ev = q(`SELECT * FROM audit_events WHERE action = 'group.member_approved' ORDER BY id DESC LIMIT 1`);
  assert.equal(ev.actor_id, userId('james.whitfield'));

  const coastal = q(`SELECT id FROM groups WHERE name = 'Team Coastal'`).id;
  const priya = userId('priya.natarajan');
  const noReason = await prof.post(`/courses/${env}/groups/${coastal}/members/${priya}/remove`);
  assert.equal(noReason.status, 302);
  assert.ok(q(`SELECT 1 FROM group_memberships WHERE group_id = ? AND user_id = ? AND status = 'confirmed'`, coastal, priya), 'removal after submission requires a reason');
  await prof.post(`/courses/${env}/groups/${coastal}/members/${priya}/remove`, { reason: 'Withdrew from course' });
  assert.ok(q(`SELECT 1 FROM submission_credits sc JOIN submissions s ON s.id = sc.submission_id WHERE s.group_id = ? AND sc.student_id = ?`, coastal, priya), 'earned credit is kept');
  assert.equal(q(`SELECT reason FROM audit_events WHERE action = 'group.member_removed' ORDER BY id DESC LIMIT 1`).reason, 'Withdrew from course');

  const unattributed = q(`SELECT COUNT(*) AS n FROM audit_events WHERE (action LIKE 'grade.%' OR action LIKE 'group.%') AND actor_id IS NULL`).n;
  assert.equal(unattributed, 0);
  const gradeEvents = q(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'grade.saved'`).n;
  assert.ok(gradeEvents >= q('SELECT COUNT(*) AS n FROM grades').n, 'every grade has at least one audit event');
});
