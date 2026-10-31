# Student Learning Portal (MVP prototype)

A responsive learning portal for students, instructors and administrators, built from
[`student-learning-portal-requirements.md`](student-learning-portal-requirements.md).
It covers Phase 1 (dashboards, courses, timetable, materials, assignments, submissions, grades)
and Phase 2 (course groups, one group submission credited to every member, shared/individual
grading, audit history).

> **Prototype only.** All people and courses are fictional demo data. This is not production-ready
> and makes no claim of GDPR/FERPA or WCAG compliance; see [Not yet built](#not-yet-built--production-gaps).

## Quick start

Requires Node.js 18.18+.

```bash
npm install
npm run seed     # wipes ./data and loads demo data (dates are relative to today)
npm start        # http://localhost:3000  (PORT=xxxx to change)
npm test         # end-to-end checks for all 12 acceptance criteria
```

The login page lists the demo accounts — click one to sign in. All use the password `demo1234`.

| Account | Role | Good for |
|---|---|---|
| maya.okafor@demo.example.edu | Student in all 4 courses | The main student demo |
| daniel.reyes@demo.example.edu | Student, Maya’s teammate | Seeing a group submission made by someone else |
| elena.vasquez@demo.example.edu | Instructor, CS 220 | Individual grading, materials, draft assignment |
| james.whitfield@demo.example.edu | Instructor, ENV 210 + STAT 201 | Group work, group approvals |
| samira.chen@demo.example.edu | Instructor, HIST 145 | An unreleased grade (Essay 1) |
| admin@demo.example.edu | Administrator | Accounts, enrollments, audit log, CSV import |

## Acceptance-criteria walkthrough

| # | Criterion | Where to see it |
|---|---|---|
| 1 | Cross-course “due soon”, sorted, labelled | Maya → **Dashboard** (filter by date range, or switch to *By class* and pick a course) |
| 2 | One grades view with clear states | Maya → **Grades** (graded, *Not graded yet*, *Excused*, *Not submitted*; Essay 1 is graded but unreleased so it stays hidden) |
| 3 | Weekly timetable, meetings vs. due dates | Maya → **Timetable**; next week shows a cancelled lecture and a room change |
| 4 | Find a resource by module and by search | Maya → CS 220 → **Materials** (browse “Week 7”, or search “course notes”) |
| 5 | Individual submission, receipt, history | Maya → *Problem Set 4* → submit, then submit again → both versions listed |
| 6 | One group submission credited to all | Maya → ENV 210 *Policy brief* → submit for Team Coastal; Whitfield → **Submissions** shows one row with 3 credited members; grade with a shared score and a one-member override |
| 7 | Create, preview, publish | Vasquez → CS 220 → **Assignments → New assignment** (saves as draft, opens student preview) and **Materials → Add material** |
| 8 | Grades visible only after release | Chen → HIST 145 Essay 1 → *Save and release*; Maya then sees it and gets a notification |
| 9 | No access by changing URLs | Every course route checks enrollment server-side; other students’ records return 404 (see test 9) |
| 10 | Keyboard and labelled controls | Skip link, visible focus, labelled fields, error summaries that receive focus, status text + icons (never colour alone) |
| 11 | Failed uploads never look successful | Upload a `.txt` or a renamed file to a PDF-only assignment |
| 12 | Every grade/membership change is attributable | Grading page **Change history**; Admin → **Audit log** |

## Technology choice

The spec asks for the strongest full-stack approach with replaceable auth, storage and integrations.
For a prototype that has to be trustworthy and accessible, this uses a deliberately small,
**server-rendered** stack:

- **Node.js + Express 4** — routes are plain functions, so authorization stays visible in each handler.
- **EJS templates** — server-rendered HTML works without JavaScript, is fast on modest phones, and
  keeps semantic markup under direct control for accessibility. `public/app.js` only *enhances*
  (confirmation dialog, upload progress, double-submit guard, unsaved-changes warning).
- **SQLite (better-sqlite3)** — real foreign keys, CHECK constraints, partial unique indexes and
  synchronous transactions, with zero setup. The schema in `src/db.js` maps 1:1 to the spec’s
  §10 entities and ports directly to PostgreSQL.
- **Luxon** for time zones; **multer** for uploads; **bcryptjs** for demo passwords.
- **Inter** (variable font, self-hosted from `@fontsource-variable/inter`) so pages make no third-party requests.

No front-end build step and seven runtime dependencies.

The visual system (“Studio”: dark sidebar, Inter, indigo accent) lives in `public/styles.css` as CSS custom properties on `:root`, with a dark-mode variant under `prefers-color-scheme`.

## Project layout

```
src/
  server.js            app setup, security headers, view helpers
  db.js                schema (all entities from spec §10)
  seed.js              fictional demo data, relative to today
  lib/
    auth.js            sessions, CSRF, login throttle  ← replace with SSO
    authz.js           course-level authorization (404 for non-members)
    coursework.js      submission/grade status rules shared by every page
    calendar.js        meetings + deadlines + events, .ics export
    time.js            DST-safe formatting and recurrence expansion
    storage.js         file validation and storage   ← replace with object storage
    notify.js          in-app notifications, email transport, reminders  ← replace mailer
    audit.js           append-only audit log
    csv.js             CSV import/export boundary    ← replace with SIS sync
  routes/              student, teach, search, course, materials, assignments, grading, groups, admin, account
  views/               EJS templates
public/                styles.css, app.js
test/                  acceptance tests (node:test)
data/                  SQLite DB, uploads, email outbox (git-ignored)
```

## Key design decisions

- **Authorization on the server, per request.** `loadCourse` resolves the caller’s enrollment for
  every `/courses/:id/...` route; non-members get a 404, so IDs can’t be probed. Instructor actions
  use `instructorOnly`. File downloads re-check access. Admins manage structure but cannot see
  grades or submissions, and there is no impersonation.
- **Unambiguous submission ownership.** A submission belongs to *either* a student *or* a group
  (`CHECK ((student_id IS NULL) <> (group_id IS NULL))`). Credited students are recorded in
  `submission_credits` with `UNIQUE (assignment_id, student_id)`, which makes duplicate credit
  impossible. Removing a member after submission keeps their earned credit; adding one credits them.
- **No duplicate submissions.** Each form render carries an idempotency key (unique in the DB);
  a retry or double-click returns the original receipt.
- **Success only after a durable save.** Files are fsync’d, then all rows are written in one
  transaction; on any failure files are removed and the form is re-shown with the student’s text.
- **Uploads validated on the server** by extension, size *and* content signature (a renamed `.exe`
  is rejected as “not a valid .pdf”). Files are stored under random names outside the web root.
- **Time zones.** Deadlines are stored as UTC instants and never shift; they render in each user’s
  chosen zone with the zone named. Recurring meetings store local wall-clock time + IANA zone, so a
  10:00 lecture stays at 10:00 across daylight-saving changes.
- **Grades are never invented.** *Not graded*, *not submitted*, *excused* and *zero* are distinct.
  A course total appears only if the instructor enables it, and is labelled *provisional*,
  *unweighted*, with the included items listed.
- **Notifications** are deduplicated per event and link to the item. Email copies (written to
  `data/email-outbox.log` in development) have generic subjects with no grade details.
- **Security headers**: CSP (scripts same-origin only), `X-Frame-Options: DENY`, HttpOnly
  SameSite session cookies, CSRF tokens on every form, CSV formula-injection escaping.

## Not yet built / production gaps

Deliberately out of scope or simplified for the prototype:

- **Identity:** demo email/password only — no password reset. Production should use institutional SSO.
- **Integrations:** CSV import/export only; no SIS sync, Edu-API or LTI 1.3 yet (Phase 3).
- **Email:** writes to a local outbox file; needs a real transport.
- **Grading:** points only — no rubrics or weighted categories. Totals are unweighted.
- **Submissions:** no saved student drafts before final submission (resubmission covers replacing
  work before the deadline). No bulk ZIP download of submissions (grades export as CSV).
- **Calendar:** `.ics` is a download, not a subscribable tokenized feed.
- **Instructor edits:** warn-before-leaving rather than autosave.
- **Materials:** items are ordered by creation within a module (no drag-to-reorder yet).
- **Operations:** no backups, monitoring, retention/deletion rules, or rate limiting beyond login throttling.
  A WCAG 2.2 AA audit with assistive-technology users is still needed.
