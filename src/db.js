'use strict';
// SQLite database connection and schema.
// All timestamps are stored as UTC ISO-8601 strings; recurring class meetings
// store local wall-clock time plus an IANA time zone so DST is handled at render time.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'portal.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','instructor','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  email_notifications INTEGER NOT NULL DEFAULT 1,
  reminder_hours INTEGER NOT NULL DEFAULT 24,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  flash TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  term_id INTEGER NOT NULL REFERENCES terms(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  show_total INTEGER NOT NULL DEFAULT 0,
  grading_policy TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#3559c7',  -- decorative accent; course code is always shown as text too
  UNIQUE (code, term_id)
);

CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('student','instructor')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dropped','completed')),
  nickname TEXT,
  start_date TEXT,
  end_date TEXT,
  UNIQUE (user_id, course_id)
);

CREATE TABLE IF NOT EXISTS class_meetings (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'lecture' CHECK (kind IN ('lecture','seminar','lab','tutorial')),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),  -- ISO weekday, 1 = Monday
  start_time TEXT NOT NULL,   -- local HH:MM
  end_time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  meeting_url TEXT,
  first_date TEXT NOT NULL,   -- YYYY-MM-DD
  last_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_exceptions (
  id INTEGER PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES class_meetings(id) ON DELETE CASCADE,
  date TEXT NOT NULL,         -- local YYYY-MM-DD of the occurrence
  status TEXT NOT NULL CHECK (status IN ('cancelled','changed')),
  location TEXT,
  note TEXT,
  UNIQUE (meeting_id, date)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('exam','event')),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  meeting_url TEXT,
  published INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS modules (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('lecture','reading','recording','activity','reference','assessment')),
  url TEXT,
  file_name TEXT,
  stored_name TEXT,
  file_size INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0,
  uploader_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (url IS NOT NULL OR stored_name IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS group_sets (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  max_size INTEGER NOT NULL DEFAULT 4,
  membership_deadline TEXT,
  student_created INTEGER NOT NULL DEFAULT 0,
  requires_approval INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  group_set_id INTEGER NOT NULL REFERENCES group_sets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_memberships (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  group_set_id INTEGER NOT NULL REFERENCES group_sets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','removed')),
  decided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- A student may hold at most one live (pending/confirmed) membership per group set.
CREATE UNIQUE INDEX IF NOT EXISTS one_group_per_set
  ON group_memberships (group_set_id, user_id) WHERE status <> 'removed';

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'assignment' CHECK (kind IN ('assignment','quiz','task')),
  instructions TEXT NOT NULL DEFAULT '',
  due_at TEXT NOT NULL,
  available_from TEXT,
  available_until TEXT,
  timezone TEXT NOT NULL,
  points REAL NOT NULL DEFAULT 100,
  submission_types TEXT NOT NULL DEFAULT 'file',   -- comma list of file,text,link
  allowed_extensions TEXT NOT NULL DEFAULT 'pdf,docx',
  max_file_mb INTEGER NOT NULL DEFAULT 10,
  allow_resubmission INTEGER NOT NULL DEFAULT 1,
  allow_late INTEGER NOT NULL DEFAULT 1,
  late_policy TEXT NOT NULL DEFAULT '',
  group_set_id INTEGER REFERENCES group_sets(id),  -- NULL = individual assignment
  group_grading TEXT NOT NULL DEFAULT 'shared' CHECK (group_grading IN ('shared','individual')),
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id INTEGER REFERENCES users(id),
  group_id INTEGER REFERENCES groups(id),
  status TEXT NOT NULL CHECK (status IN ('submitted','late','returned','resubmitted')),
  current_version INTEGER NOT NULL DEFAULT 1,
  first_submitted_at TEXT NOT NULL,
  last_submitted_at TEXT NOT NULL,
  -- the owner is either one student or one group, never both or neither
  CHECK ((student_id IS NULL) <> (group_id IS NULL)),
  UNIQUE (assignment_id, student_id),
  UNIQUE (assignment_id, group_id)
);

CREATE TABLE IF NOT EXISTS submission_versions (
  id INTEGER PRIMARY KEY,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  submitted_by INTEGER NOT NULL REFERENCES users(id),
  submitted_at TEXT NOT NULL,
  is_late INTEGER NOT NULL DEFAULT 0,
  body_text TEXT,
  link_url TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  UNIQUE (submission_id, version)
);

CREATE TABLE IF NOT EXISTS submission_files (
  id INTEGER PRIMARY KEY,
  version_id INTEGER NOT NULL REFERENCES submission_versions(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL
);

-- Students credited for a submission. For individual work this is the owner;
-- for group work it is every confirmed member at the time of submission.
CREATE TABLE IF NOT EXISTS submission_credits (
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id),
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  PRIMARY KEY (submission_id, student_id),
  UNIQUE (assignment_id, student_id)  -- prevents duplicate credit for one assignment
);

CREATE TABLE IF NOT EXISTS grades (
  id INTEGER PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id),
  points REAL,
  excused INTEGER NOT NULL DEFAULT 0,
  feedback TEXT NOT NULL DEFAULT '',
  released INTEGER NOT NULL DEFAULT 0,
  released_at TEXT,
  grader_id INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL,
  UNIQUE (assignment_id, student_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  course_id INTEGER REFERENCES courses(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  read_at TEXT,
  emailed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assign_course ON assignments(course_id, due_at);
CREATE INDEX IF NOT EXISTS idx_res_course ON resources(course_id, module_id, position);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_course ON audit_events(course_id, created_at);
CREATE INDEX IF NOT EXISTS idx_enroll_course ON enrollments(course_id, role);
`;

db.exec(SCHEMA);

const nowIso = () => new Date().toISOString();

module.exports = { db, nowIso, DATA_DIR };
