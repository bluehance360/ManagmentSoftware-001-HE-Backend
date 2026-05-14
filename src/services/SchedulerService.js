/**
 * SchedulerService — automated, time-based job notifications.
 *
 * A single node-cron task runs every 30 minutes and evaluates three rules:
 *
 *   Rule 1  Job ASSIGNED but not COMPLETED within 24 hours
 *           → notify admin, office manager, assigned + secondary technician.
 *           The 24h clock is measured from the most recent ASSIGNED entry in
 *           statusHistory, so reassigning a job resets the clock.
 *
 *   Rule 2  Required documents missing while the scheduled date approaches
 *           → reminders at 24h / 12h / 6h / 3h / 1h before the scheduled time
 *           (08:00 America/Los_Angeles on scheduledDate). Notifies admin +
 *           office manager only.
 *
 *   Rule 3  Job is IN_PROGRESS but required documents are still pending
 *           → notify admin + office manager once.
 *
 * Deduplication is handled by the NotificationLog collection (claim-before-send
 * against a unique index), so notifications survive restarts without duplicates.
 */

const cron = require('node-cron');
const Job = require('../models/Job');
const NotificationLog = require('../models/NotificationLog');
const { createNotification } = require('./NotificationService');
const { JOB_STATUS, ROLES } = require('../config/constants');

// ── Configuration ──────────────────────────────────────────────────
const TIMEZONE = 'America/Los_Angeles';
const SCHEDULED_HOUR_LOCAL = 8; // jobs are treated as starting at 08:00 LA time
const CRON_EXPRESSION = '*/30 * * * *'; // every 30 minutes
const OVERDUE_HOURS = 24;
const DOC_REMINDER_THRESHOLDS = [24, 12, 6, 3, 1]; // hours before scheduled time
// A reminder is eligible for one 35-min window — slightly wider than the cron
// interval so a tick is never missed; the NotificationLog still guarantees
// it is only sent once.
const REMINDER_WINDOW_MS = 35 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// ── Timezone helpers ───────────────────────────────────────────────

/**
 * Offset (ms) between `timeZone` wall-clock and UTC at the given instant.
 * e.g. America/Los_Angeles in PST → -8h, in PDT → -7h.
 * Uses Intl.formatToParts so it is correct across DST with no dependencies.
 */
function getTimezoneOffsetMs(timeZone, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUTC - date.getTime();
}

/**
 * The UTC instant for 08:00 America/Los_Angeles on a YYYY-MM-DD string.
 * Returns null for an invalid/empty date.
 */
function scheduledStartUtc(dateOnly) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateOnly || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Use 20:00 UTC (~midday LA) as the reference — always safely past the 02:00
  // DST switch, so the offset we read applies to our 08:00 target.
  const reference = new Date(Date.UTC(y, mo - 1, d, 20, 0, 0));
  const offsetMs = getTimezoneOffsetMs(TIMEZONE, reference);
  return new Date(Date.UTC(y, mo - 1, d, SCHEDULED_HOUR_LOCAL, 0, 0) - offsetMs);
}

// ── Domain helpers ─────────────────────────────────────────────────

/**
 * True if the job has at least one required document that is checked but has
 * neither an uploaded file nor a text value. Matches the validation used in
 * JobService.assignTechnician.
 */
function jobHasMissingRequiredDocuments(job) {
  const rows = Array.isArray(job.assignmentDocumentRequirements)
    ? job.assignmentDocumentRequirements
    : [];
  return rows.some(
    (row) => row && row.checked && !row.document?.key && !String(row.textValue || '').trim()
  );
}

/**
 * Timestamp of the most recent transition into ASSIGNED. Reassignment pushes a
 * fresh ASSIGNED entry, so this naturally returns the latest assignment time.
 * Returns null if the job has never been assigned.
 */
function lastAssignedAt(job) {
  const history = Array.isArray(job.statusHistory) ? job.statusHistory : [];
  let latest = null;
  for (const entry of history) {
    if (entry && entry.toStatus === JOB_STATUS.ASSIGNED && entry.changedAt) {
      const t = new Date(entry.changedAt).getTime();
      if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
    }
  }
  return latest === null ? null : new Date(latest);
}

/**
 * Atomically claim the right to send a (job, type, ref) notification.
 * Returns true the first time (caller should send), false if already claimed.
 */
async function claimNotification(jobId, type, ref = '') {
  try {
    await NotificationLog.create({ job: jobId, type, ref });
    return true;
  } catch (err) {
    if (err && err.code === 11000) return false; // duplicate key — already sent
    throw err;
  }
}

// ── Rule 1: assigned but not completed within 24h ──────────────────
async function checkOverdueAssignedJobs() {
  // ASSIGNED or IN_PROGRESS = assigned to a tech but not yet COMPLETED+.
  const jobs = await Job.find({
    status: { $in: [JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS] },
  }).select('_id title status statusHistory assignedTechnician secondaryAssignedTechnician');

  const now = Date.now();
  let sent = 0;

  for (const job of jobs) {
    const assignedAt = lastAssignedAt(job);
    if (!assignedAt) continue;
    if (now - assignedAt.getTime() < OVERDUE_HOURS * HOUR_MS) continue;

    // ref = assignment timestamp → a later reassignment yields a new ref and
    // is allowed to fire its own overdue notification.
    const claimed = await claimNotification(job._id, 'OVERDUE_24H', assignedAt.toISOString());
    if (!claimed) continue;

    const recipientIds = [job.assignedTechnician, job.secondaryAssignedTechnician].filter(Boolean);
    await createNotification({
      type: 'JOB_OVERDUE_INCOMPLETE',
      message: `Job "${job.title}" has been assigned for over 24 hours and is still not completed.`,
      jobId: job._id,
      recipientIds,
      recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
    });
    sent += 1;
  }

  return sent;
}

// ── Rule 2: missing documents, scheduled date approaching ──────────
async function checkMissingDocumentReminders() {
  // Only jobs that have not started yet can be "approaching their scheduled date".
  const jobs = await Job.find({
    status: { $in: [JOB_STATUS.TENTATIVE, JOB_STATUS.CONFIRMED, JOB_STATUS.ASSIGNED] },
    scheduledDate: { $exists: true, $nin: [null, ''] },
  }).select('_id title status scheduledDate assignmentDocumentRequirements');

  const now = Date.now();
  let sent = 0;

  for (const job of jobs) {
    if (!jobHasMissingRequiredDocuments(job)) continue;

    const start = scheduledStartUtc(job.scheduledDate);
    if (!start) continue;

    for (const hours of DOC_REMINDER_THRESHOLDS) {
      const reminderMoment = start.getTime() - hours * HOUR_MS;
      // Eligible only inside this reminder's window. A job created later than a
      // given window simply skips that (now-impossible) reminder.
      if (now < reminderMoment || now >= reminderMoment + REMINDER_WINDOW_MS) continue;

      // ref = scheduledDate → rescheduling the job re-arms all reminders.
      const claimed = await claimNotification(
        job._id,
        `DOC_REMINDER_${hours}H`,
        job.scheduledDate
      );
      if (!claimed) continue;

      await createNotification({
        type: 'JOB_DOCS_MISSING_REMINDER',
        message: `Reminder: Job "${job.title}" is scheduled in ~${hours} hour(s) and still has missing required documents.`,
        jobId: job._id,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
      });
      sent += 1;
    }
  }

  return sent;
}

// ── Rule 3: job started but documents still pending ────────────────
async function checkStartedJobsWithPendingDocuments() {
  const jobs = await Job.find({
    status: JOB_STATUS.IN_PROGRESS,
  }).select('_id title status assignmentDocumentRequirements');

  let sent = 0;

  for (const job of jobs) {
    if (!jobHasMissingRequiredDocuments(job)) continue;

    // ref = '' → fire exactly once per job.
    const claimed = await claimNotification(job._id, 'DOC_STARTED_PENDING', '');
    if (!claimed) continue;

    await createNotification({
      type: 'JOB_STARTED_DOCS_PENDING',
      message: `Job "${job.title}" has started but required documents are still pending.`,
      jobId: job._id,
      recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
    });
    sent += 1;
  }

  return sent;
}

// ── Runner ─────────────────────────────────────────────────────────

/**
 * Run all three checks. Each is isolated so one failing query never blocks the
 * others. Returns a per-rule count of notifications sent (useful for testing).
 */
async function runAllChecks() {
  const result = { overdue: 0, docReminders: 0, startedPendingDocs: 0 };

  try {
    result.overdue = await checkOverdueAssignedJobs();
  } catch (err) {
    console.error('[Scheduler] checkOverdueAssignedJobs failed:', err.message);
  }
  try {
    result.docReminders = await checkMissingDocumentReminders();
  } catch (err) {
    console.error('[Scheduler] checkMissingDocumentReminders failed:', err.message);
  }
  try {
    result.startedPendingDocs = await checkStartedJobsWithPendingDocuments();
  } catch (err) {
    console.error('[Scheduler] checkStartedJobsWithPendingDocuments failed:', err.message);
  }

  return result;
}

let task = null;

/** Register the cron task. Idempotent — safe to call once on server startup. */
function start() {
  if (task) return task;
  task = cron.schedule(CRON_EXPRESSION, runAllChecks, {
    timezone: TIMEZONE,
    name: 'notification-scheduler',
    noOverlap: true, // skip a tick if the previous run is still in progress
  });
  console.log(
    `[Scheduler] Notification scheduler started (cron "${CRON_EXPRESSION}", tz ${TIMEZONE})`
  );
  return task;
}

/** Stop the cron task (used in tests / graceful shutdown). */
function stop() {
  if (task) {
    task.stop();
    task = null;
  }
}

module.exports = {
  start,
  stop,
  runAllChecks,
  // individual checks + helpers exported for testing
  checkOverdueAssignedJobs,
  checkMissingDocumentReminders,
  checkStartedJobsWithPendingDocuments,
  scheduledStartUtc,
  getTimezoneOffsetMs,
  jobHasMissingRequiredDocuments,
  lastAssignedAt,
  CRON_EXPRESSION,
  TIMEZONE,
};
