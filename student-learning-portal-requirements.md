# Student Learning Portal — Product Requirements

**Document type:** Product and MVP build specification  
**Status:** Initial draft for a coding platform  
**Working product name:** Student Learning Portal  
**Audience:** Product builder, designer, and engineering team

## 1. Product summary

Build a clear, responsive university learning portal for students and instructors. Students should be able to see what is coming up across all enrolled courses, view their timetable and grades without digging through each course, find course materials quickly, and submit work. Instructors should be able to manage course content and assignments, review submissions, provide feedback and grades, and create group assignments where one submission is credited to every confirmed group member.

The MVP is a learning-management portal, not a complete student information system. Course registration, billing, admissions, degree audits, and official transcript management are outside the MVP. Design the data model and integration boundaries so the portal can later connect to a university student-information system (SIS), identity provider, and external learning tools.

## 2. Problem and product principles

Students currently have to navigate course-by-course to understand their workload and grades. Group submissions can require instructors to manually associate one upload with several students. Course readings, lecture files, and references may be difficult to locate later.

The product should follow these principles:

1. **Cross-course clarity:** The student’s next actions, schedule, and grades are visible from one home screen.
2. **Course context stays visible:** Every due date, grade, file, and submission clearly identifies its course.
3. **One authoritative submission record:** A group submission belongs to a defined group and is automatically associated with each member.
4. **Course materials are findable:** Instructors organize resources into predictable sections; students can search and filter them.
5. **Accessible by default:** Core tasks work with keyboard, screen reader, zoom, mobile, and assistive technology.
6. **Trustworthy academic records:** Permissions, grade visibility, submission receipts, and change history are explicit.

## 3. Users and permissions

### Student

- View only their own enrolled courses, grades, feedback, timetable, submissions, and group memberships.
- View course materials published to students.
- Submit individual work or submit on behalf of a confirmed group when the assignment allows it.
- See who is in a group and the submission status for that group assignment.
- Cannot edit grades, instructor feedback, course membership, or published assignment instructions.

### Instructor

- View and manage courses for which they are assigned an instructor role.
- Create and organize course materials, assignments, schedule events, groups, and announcements.
- Review submissions, provide feedback, set grades, and return work to students.
- Configure whether an assignment is individual or group-based and whether grading is shared or individual.
- Cannot see or change courses outside their assigned permissions unless separately granted an administrator role.

### Administrator (minimum operational role)

- Manage accounts, course shells, enrollments, terms, and role assignment.
- View system-level audit events and configure institution-wide settings.
- Cannot silently impersonate a student or instructor; any support access must be explicitly authorized and audited.

Implement authorization on the server for every protected operation. Hiding a button in the interface is not sufficient authorization.

## 4. MVP scope

### Included

- Authentication and role-based access for students, instructors, and administrators.
- Course list and course detail pages.
- Student dashboard aggregating upcoming work, class meetings, recent feedback, and grades across active courses.
- Assignment creation, publication, individual/group submission, instructor review, feedback, and grade entry.
- Course timetable and calendar/list views.
- Course content library for readings, lecture slides, recordings/links, activities, and references.
- Course groups and group assignment membership.
- Notifications for new/changed assignments, due dates, submission confirmation, feedback, and grades.
- Responsive web experience for desktop and mobile browsers.
- Seed/demo data so the prototype can be explored without a real university connection.

### Explicitly later

- Course registration, waitlists, prerequisites, degree planning, fees, official transcript issuance, attendance tracking, video conferencing, discussion boards, plagiarism detection, online exams, native mobile apps, and AI grading.
- Direct SIS write-back. Initial course/user data may be entered by administrators or imported from a simple CSV. Keep a clean integration layer for later synchronization.

## 5. Student experience requirements

### 5.1 Home dashboard

The dashboard is the default student landing page and must summarize all active courses, not only favorited courses.

Show:

- **Due soon:** Upcoming assignments, quizzes, and other instructor-defined tasks, sorted by due date. Each item shows title, course, due date/time, submission status, and a direct action to open or submit.
- **Today / next class:** Next scheduled class meeting, course, time, location or meeting link.
- **Grades snapshot:** A compact row/card for every active course, showing current course grade when the instructor has enabled it, most recent grade/feedback, and a link to the full course grade view.
- **Recent updates:** New announcements, changed due dates, newly published resources, and returned work.
- Clear empty states when there are no upcoming items, no grades posted, or no courses.

Allow the student to switch among a concise dashboard, a full assignment list, and a calendar. Provide filters for course, date range, and status. Past-due and completed items remain available in history but should not crowd out upcoming work.

### 5.2 Courses and course pages

The course list shows course name, code, term, instructor, and next meeting or next due item. A course page contains these predictable areas:

- Overview / announcements
- Schedule
- Assignments
- Grades and feedback
- Materials
- Groups (when used)

Show the course name and code persistently so a student always knows which course they are viewing. Students may optionally create a personal nickname, while the official name remains available.

### 5.3 Schedule and calendar

- Provide a weekly timetable for recurring class meetings and a calendar/list view for dated events and due dates.
- Distinguish class meetings, assignment deadlines, exams, and instructor-created events using both labels/icons and text, not color alone.
- Show the event’s local date, time, course, room or location, and online meeting link if applicable.
- Support recurring meetings, exceptions/cancellations, and daylight-saving/time-zone-safe storage.
- Let students filter by course and export or subscribe to a standard calendar feed if feasible for the chosen stack.
- Do not treat an assignment deadline as a class meeting or silently move a due date when time zones change.

### 5.4 Assignments and submissions

An assignment detail page must show:

- Title, course, instructions, due date/time and time zone, availability window, allowed file types/size, submission method, grading method, points or rubric, and late-work policy if configured.
- Whether the assignment is individual or group-based; for group work, show the confirmed group and members.
- Whether a draft can be replaced before the deadline and what happens after the deadline.
- Submission status: not submitted, draft, submitted, late, returned for revision, graded, or resubmitted.

Students can submit an allowed file, text response, or instructor-defined link. Before final submission, show the selected file/group and request confirmation. After success, show a durable receipt with timestamp, submitted file name(s), assignment, course, and submitting student or group. A retry or duplicate click must not create accidental duplicate submissions. Preserve prior versions when resubmission is allowed.

If upload fails, explain what failed and preserve the student’s work for retry where technically possible. Enforce file type and size limits on the server and validate uploaded files.

### 5.5 Groups and shared credit

- Groups may be created by the instructor, or students may propose/create groups if the instructor enables it.
- The instructor sets the group-size limit, membership deadline, and whether the instructor must approve membership.
- Before a group assignment is submitted, display the full membership list and require the submitter to confirm that the submission is for that group.
- One successful group submission is associated with the group and every confirmed member. The instructor sees one group submission with all credited members, eliminating manual duplicate entry.
- The assignment setting controls grading: **shared grade and feedback** for all members, or **individual grade/feedback** per member. The instructor may adjust a member’s grade without changing other members’ grades.
- A student can see the group’s submission status but cannot alter another member’s membership or submit on behalf of an unconfirmed group.
- Changes to membership after a submission require instructor action and are recorded in the audit history. Do not silently remove a student’s earned credit.
- Instructors can download/view the submission once and see its group, submitter, timestamp, and all credited members.

### 5.6 Grades and feedback

- Provide a single Grades page aggregating all active courses, with assignment, score, maximum points or grading scale, status, and course context.
- Each course grade view shows graded and ungraded work, feedback, rubric results when used, and the course grade calculation policy if provided by the instructor.
- Distinguish **not graded**, **not submitted**, **excused**, and **zero**; do not treat them as interchangeable.
- Do not invent a course total when weighting rules are absent or when the instructor has hidden totals. Label provisional/calculated results clearly and show which items are included.
- Grade visibility must follow the instructor’s release/publish setting. Students must never see another student’s individual grade or feedback.
- When a grade or feedback is released, notify the student and link directly to the item.

### 5.7 Materials and resources

Instructors can add files and links and organize them in modules/folders such as lectures, readings, activities, references, and assessments. A resource record includes title, description, type, course, topic/module, uploader, publication state, and upload/update date.

Students can:

- Browse resources by module/topic and resource type.
- Search titles and descriptions within a course, with filters for type and topic.
- Sort by module order, newest, and title.
- Open or download resources according to access permissions.

Unpublished items are visible to instructors but not students. Replacing a file should preserve the resource’s place and show its latest update date. Avoid relying on arbitrary folder nesting as the only way to find material.

## 6. Instructor experience requirements

### 6.1 Instructor dashboard

Show assigned courses, upcoming teaching events, assignments needing grading, recent student activity, and quick links to create an announcement, resource, or assignment. Instructor work items should be separated from student-facing course deadlines.

### 6.2 Course management

Instructors can edit the course overview, schedule, modules/materials, announcements, and participant groups, subject to administrator-controlled course ownership. Provide preview/publish controls for student-facing content.

### 6.3 Assignment management and grading

- Create/edit assignments with title, instructions, dates, submission method, accepted formats, late policy, points/rubric, visibility, and individual/group settings.
- Preview the student-facing assignment before publishing.
- View submissions by status, student/group, and submission time; search/filter and download permitted files.
- Enter grades and feedback, save drafts, and explicitly release grades/feedback.
- Provide a clear indicator when an assignment is group-submitted and list each credited student.
- Support bulk download/export where practical, while keeping grades and files permission-protected.
- Record grade changes with editor, previous value, new value, timestamp, and optional reason.

## 7. Notifications

Provide an in-app notification center and configurable email notifications where email is available. Notify users about relevant events only: assignment published/changed, due date changed, deadline approaching (student-controlled reminder preferences), submission receipt, feedback/grade released, group membership approval, and course announcement.

Notifications must link to the relevant course/item, respect user preferences, avoid exposing private grades or submission details in email subject lines, and avoid sending duplicate alerts for one event.

## 8. Non-functional requirements

### Accessibility and usability

- Target WCAG 2.2 Level AA for core flows, including keyboard access, visible focus, semantic headings/labels, sufficient contrast, screen-reader announcements for status changes, accessible form errors, and layouts that reflow on small screens/zoom.
- Never use color as the only indication of course, deadline, grade, or status.
- Use plain language, consistent navigation, descriptive buttons, and useful empty/error states.
- Make frequent tasks work comfortably on a phone-sized screen without requiring a native app.

### Privacy and security

- Collect only data required for course operations; define retention and deletion rules with the institution before production use.
- Protect grades, submissions, schedules, and course rosters as education records. Enforce least-privilege access and course-level authorization.
- Use secure authentication, session management, password reset or institutional SSO, server-side authorization, encrypted transport, and secure storage for uploaded files.
- Keep an audit log for grade changes, membership changes, publication changes, and administrative access. Logs must not expose passwords, tokens, or unnecessary file contents.
- Separate development/demo data from production data. Do not place real student data in a public prototype.
- Apply GDPR requirements where relevant; if deployed for a U.S. institution, review FERPA obligations with institutional counsel/privacy staff. The specification is not a legal compliance certification.

### Reliability and data integrity

- Autosave or warn before losing unsaved instructor edits.
- Make submission and grade writes transactional: show success only after durable save.
- Prevent duplicate group credit, duplicate submissions from retries, and inconsistent grade displays.
- Provide backups and a documented recovery plan before production deployment.
- Store timestamps consistently and render them in the user’s configured/local time zone with the time zone stated near deadlines.

### Performance

- The dashboard and course pages should remain responsive on a typical student connection and a modest mobile device.
- Paginate or progressively load long assignment, grade, and resource lists.
- Provide upload progress and clear file size limits.

## 9. Integration and data portability

For the prototype, support local/demo accounts and administrator-managed courses plus CSV import/export for users, courses, enrollments, and schedule entries. Keep the application’s core course, person, enrollment, outcome, and assignment records independent from any one vendor’s API.

When connecting to institutional systems:

- Prefer the university’s supported SSO and SIS/API processes; the SIS should remain authoritative for official identity, course catalog, term, and enrollment data unless the institution decides otherwise.
- Evaluate 1EdTech Edu-API for higher-education enterprise data exchange and LTI 1.3 for secure connections to external learning tools. Confirm maturity and institutional support before committing to a specific implementation.
- Treat integration as a later phase requiring institution IT/security approval, data mapping, error handling, reconciliation, and ownership rules. Do not scrape a student portal or store university credentials.

## 10. Suggested core data entities

- **User:** id, name, institutional email, role(s), status, time zone, notification preferences.
- **Term:** id, name, start/end dates.
- **Course:** id, code, title, description, term, status, instructors.
- **Enrollment:** user, course, role/status, effective dates.
- **ClassMeeting/Event:** course, title/type, start/end time, time zone, location/link, recurrence/exception data.
- **Module/Resource:** course, module, title, description, type, file/link, sort order, publication state, timestamps.
- **Assignment:** course, title, instructions, due/availability dates, submission settings, grading settings, publication state.
- **Group/GroupMembership:** course, name, member, status, approval, effective dates.
- **Submission:** assignment, individual or group owner, submitter, timestamp, status, versions/files/text/link.
- **Grade/Feedback:** submission or student-assignment, grader, points/scale, rubric, feedback, release state, timestamps.
- **Notification:** recipient, event type, linked item, read state, sent timestamp.
- **AuditEvent:** actor, action, affected record, before/after summary, timestamp, reason where applicable.

Use stable IDs and foreign-key constraints. A submission owner must be either an individual student or a group, never an ambiguous mixture.

## 11. MVP acceptance criteria

The MVP is ready for a stakeholder demo when all of these can be demonstrated with seeded data:

1. A student signs in and sees upcoming work from multiple courses in one dashboard, correctly sorted and labeled with course and deadline.
2. The student opens one Grades view and sees assignments/grades across active courses with clear states for ungraded and graded items.
3. The student views a weekly timetable and can distinguish meetings from due dates.
4. The student locates a reading/lecture resource by browsing its course module and by searching within the course.
5. A student submits an individual assignment and receives a timestamped receipt; a permitted resubmission preserves submission history.
6. A student submits once for a confirmed group; the instructor sees one submission associated with all confirmed members and can issue shared or individual grades as configured.
7. The instructor creates a resource and assignment, previews them, and publishes them to the intended course.
8. The instructor grades a submission, saves feedback, releases it, and the student sees the result only after release.
9. A student cannot access another student’s grade, submission, or private feedback by changing a URL or request identifier.
10. Core dashboard, resource search, assignment submission, group confirmation, and grading flows are keyboard usable and have labeled accessible controls.
11. Failed uploads or saves produce a clear error and do not display a false success state.
12. Every grade or group-membership change is attributable to an authorized actor in the audit history.

## 12. Recommended build sequence

### Phase 1 — Clickable/functional MVP

Authentication with demo users; student and instructor dashboards; course pages; timetable; resources; assignments; individual submissions; grades/feedback; seeded sample data.

### Phase 2 — Group-work workflow

Course groups, membership approval/deadlines, one group submission linked to all members, shared/individual grading, audit history, and group status visibility.

### Phase 3 — Production readiness and integrations

Institution SSO, SIS roster/course synchronization, standards-based tool integration, operational monitoring, backup/recovery, retention configuration, and institution privacy/security review.

## 13. Implementation instructions for a coding platform

Build a polished, responsive web application from this specification. Start with the Phase 1 experience and include enough seeded data to demonstrate multiple courses, deadlines, a timetable, course resources, grades, and both student and instructor roles. Implement the data model and authorization so Phase 2 group submissions can be added without redesigning assignment ownership.

Prioritize the student dashboard and student task flows. Use realistic sample content, not lorem ipsum. Make course identity, due dates, grade state, and submission status immediately legible. Keep registration and official SIS functions out of the MVP. If the platform needs to choose a technology stack, use its strongest supported full-stack approach, document the choice, and keep authentication, file storage, and institutional integrations replaceable.

Do not claim production readiness or legal compliance based only on a prototype. Do not use real student records in demo content.

## 14. Research basis and references

These product choices reflect documented patterns in widely used learning platforms and current interoperability/accessibility guidance. The details below are design inputs, not claims that any one vendor is the ideal product.

- Instructure Canvas student dashboard documentation describes cross-course To Do items, course labels, recent feedback, and a dashboard grades view: [Canvas student To Do list and dashboard sidebar](https://community.instructure.com/en/kb/articles/662818-how-do-i-use-the-to-do-list-and-sidebar-in-the-dashboard-as-a-student).
- Moodle assignment documentation describes group submission with a shared submission area and the choice between common group grades/feedback and individual member grading: [Moodle assignment settings](https://docs.moodle.org/24/en/Assignment_settings).
- Moodle course group documentation describes groups as course-level membership: [Moodle groups and cohorts](https://docs.moodle.org/503/en/Groups_and_cohorts).
- W3C recommends WCAG 2.2 as the current WCAG 2 standard for accessibility work: [WCAG 2.2 Recommendation](https://www.w3.org/TR/WCAG22/).
- 1EdTech identifies Edu-API for higher-education data exchange and LTI for secure LMS/tool integration; Edu-API's published page describes the specification as still progressing toward its first version, so institutional support should be confirmed: [1EdTech standards](https://standards.1edtech.org/), [Edu-API](https://www.1edtech.org/standards/edu-api), [LTI 1.3](https://www.1edtech.org/standards/lti).
- GDPR Article 5 includes data minimization and storage limitation principles: [EUR-Lex GDPR text](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng/).
- The U.S. Department of Education identifies grades, course schedules, and class lists as examples of education records under FERPA: [FERPA education-record FAQ](https://studentprivacy.ed.gov/faq/what-education-record).
