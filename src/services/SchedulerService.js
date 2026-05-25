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
const FsrDocument = require('../models/FsrDocument');
const NotificationLog = require('../models/NotificationLog');
const { createNotification } = require('./NotificationService');
const { JOB_STATUS, ROLES } = require('../config/constants');
const { FSR_STATUS } = require('./FsrService');

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

// FSR reminder schedule (Rules 4 & 5)
// Tech  : first at +12h after FSR visibility, then every 24h.
// Admin : first at 11:00 AM LA on the *next calendar day* after visibility,
//         then +12h (= 11:00 PM that same day), then every 24h from there.
const FSR_TECH_FIRST_REMINDER_HOURS = 12;
const FSR_ADMIN_REMINDER_HOUR_LOCAL = 11; // 11:00 AM LA for the first admin reminder

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

// ── Notification Format Helpers ────────────────────────────────────
//
// Centralised payload builders for all scheduler-issued notifications.
// Every builder calls buildScheduledPayload() so the shape is always
// consistent. To add a new scheduled notification:
//   1. Add its type to src/models/Notification.js enum.
//   2. Add a builder function here.
//   3. Call claimNotification() + createNotification(build…()) in the rule.

/**
 * Core builder — every scheduler notification goes through this so the
 * structure (type, message, jobId, optional ids/roles, optional dedupeKey)
 * is always consistent.
 */
function buildScheduledPayload({ type, message, jobId, recipientIds = [], recipientRoles = [], dedupeKey }) {
  const payload = { type, message, jobId };
  const ids = recipientIds.filter(Boolean);
  if (ids.length) payload.recipientIds = ids;
  if (recipientRoles.length) payload.recipientRoles = recipientRoles;
  if (dedupeKey) payload.dedupeKey = dedupeKey;
  return payload;
}

/** Rule 4 — FSR tech reminder: sent to the assigned technician(s). */
function buildFsrTechReminderPayload(job, hoursElapsed, dedupeKey) {
  return buildScheduledPayload({
    type: 'JOB_FSR_REMINDER_TECH',
    message: `Reminder: The FSR for job "${job.title}" has been open for over ${hoursElapsed} hours and has not been submitted yet.`,
    jobId: job._id,
    recipientIds: [job.assignedTechnician, job.secondaryAssignedTechnician],
    dedupeKey,
  });
}

/** Rule 5 — FSR admin/manager reminder: broadcast to Admin + Office Manager roles. */
function buildFsrAdminReminderPayload(job, dedupeKey) {
  return buildScheduledPayload({
    type: 'JOB_FSR_REMINDER_ADMIN',
    message: `Reminder: The FSR for job "${job.title}" has not been submitted. Please follow up with the assigned technician.`,
    jobId: job._id,
    recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
    dedupeKey,
  });
}

// ── FSR reminder timing helpers ────────────────────────────────────

/**
 * Returns the UTC instant for FSR_ADMIN_REMINDER_HOUR_LOCAL on the *next*
 * calendar day (in America/Los_Angeles) after `fromDate`.
 * Reuses getTimezoneOffsetMs for DST-correct conversion.
 */
function nextDayAtAdminHourUtc(fromDate) {
  // Determine the LA local date for fromDate
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(fromDate)) parts[p.type] = p.value;

  // Advance by one calendar day (safe across month / year boundaries)
  const laDateMs = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const nextDayStr = new Date(laDateMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const [y, mo, d] = nextDayStr.split('-').map(Number);
  // Use ~midday UTC as the DST reference (same pattern as scheduledStartUtc)
  const reference = new Date(Date.UTC(y, mo - 1, d, 20, 0, 0));
  const offsetMs = getTimezoneOffsetMs(TIMEZONE, reference);
  return new Date(Date.UTC(y, mo - 1, d, FSR_ADMIN_REMINDER_HOUR_LOCAL, 0, 0) - offsetMs);
}

/**
 * Returns the due-time checkpoints (if any) that fall inside the current
 * 35-minute reminder window for the tech FSR reminder schedule:
 *   first at visibleAt + 12h, then every 24h.
 * Each entry is { dueMs, hoursElapsed } — at most one per tick.
 */
function getFsrTechCheckpoints(visibleAt, now) {
  const vMs = visibleAt.getTime();

  // First reminder: T + 12h
  const due12h = vMs + FSR_TECH_FIRST_REMINDER_HOURS * HOUR_MS;
  if (now >= due12h && now < due12h + REMINDER_WINDOW_MS) {
    return [{ dueMs: due12h, hoursElapsed: FSR_TECH_FIRST_REMINDER_HOURS }];
  }

  // Subsequent: every 24h starting at T + 24h.
  // Math.floor gives the current 24h round (1 = 24-48h, 2 = 48-72h, …).
  const elapsedMs = now - vMs;
  if (elapsedMs >= 24 * HOUR_MS) {
    const round = Math.floor(elapsedMs / (24 * HOUR_MS));
    const dueMs = vMs + round * 24 * HOUR_MS;
    if (now >= dueMs && now < dueMs + REMINDER_WINDOW_MS) {
      return [{ dueMs, hoursElapsed: round * 24 }];
    }
  }

  return [];
}

/**
 * Returns the due-time checkpoints (if any) that fall inside the current
 * 35-minute reminder window for the admin FSR reminder schedule:
 *   first at next-day 11:00 AM LA, then +12h, then every 24h.
 * Each entry is { dueMs } — at most one per tick.
 */
function getFsrAdminCheckpoints(visibleAt, now) {
  const firstDueMs = nextDayAtAdminHourUtc(visibleAt).getTime();

  // First reminder (next day at 11 AM LA)
  if (now >= firstDueMs && now < firstDueMs + REMINDER_WINDOW_MS) {
    return [{ dueMs: firstDueMs }];
  }

  // Second reminder: +12h from first (= 11 PM same day)
  // Third+: every 24h from that 11 PM mark.
  const baseDueMs = firstDueMs + 12 * HOUR_MS;
  if (now >= baseDueMs) {
    const round = Math.floor((now - baseDueMs) / (24 * HOUR_MS)); // 0, 1, 2, …
    const dueMs = baseDueMs + round * 24 * HOUR_MS;
    if (now >= dueMs && now < dueMs + REMINDER_WINDOW_MS) {
      return [{ dueMs }];
    }
  }

  return [];
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
      dedupeKey: `overdue-24h:${job._id}:${assignedAt.toISOString()}`,
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
        dedupeKey: `docs-missing:${job._id}:${job.scheduledDate}:${hours}`,
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
      dedupeKey: `started-docs-pending:${job._id}`,
    });
    sent += 1;
  }

  return sent;
}

// ── Rule 4: FSR visible but not submitted — remind tech ────────────
//
// Fires for every IN_PROGRESS job whose FSR is visible to the technician
// (technicianVisible: true) but has not been submitted yet.
//
// Schedule: +12h after visibility, then every 24h (+24h, +48h, …).
// Recipients: assigned technician + secondary technician.
async function checkFsrTechReminders() {
  const fsrDocs = await FsrDocument.find({
    technicianVisible: true,
    technicianVisibleAt: { $exists: true, $ne: null },
    status: { $ne: FSR_STATUS.SUBMITTED },
  })
    .select('_id job technicianVisibleAt')
    .populate('job', '_id title status assignedTechnician secondaryAssignedTechnician');

  const now = Date.now();
  let sent = 0;

  for (const fsrDoc of fsrDocs) {
    const job = fsrDoc.job;
    if (!job || job.status !== JOB_STATUS.IN_PROGRESS) continue;
    if (!job.assignedTechnician) continue;

    const checkpoints = getFsrTechCheckpoints(fsrDoc.technicianVisibleAt, now);
    for (const { dueMs, hoursElapsed } of checkpoints) {
      const ref = new Date(dueMs).toISOString();
      const claimed = await claimNotification(job._id, 'FSR_TECH_REMINDER', ref);
      if (!claimed) continue;

      const dedupeKey = `fsr-tech-reminder:${job._id}:${ref}`;
      await createNotification(buildFsrTechReminderPayload(job, hoursElapsed, dedupeKey));
      sent += 1;
    }
  }

  return sent;
}

// ── Rule 5: FSR visible but not submitted — remind admin/manager ───
//
// Fires for the same unsubmitted-FSR set as Rule 4, but targets Admins and
// Office Managers instead of the technician.
//
// Schedule: next calendar day at 11:00 AM LA, then +12h (11:00 PM), then
//           every 24h.
async function checkFsrAdminReminders() {
  const fsrDocs = await FsrDocument.find({
    technicianVisible: true,
    technicianVisibleAt: { $exists: true, $ne: null },
    status: { $ne: FSR_STATUS.SUBMITTED },
  })
    .select('_id job technicianVisibleAt')
    .populate('job', '_id title status assignedTechnician');

  const now = Date.now();
  let sent = 0;

  for (const fsrDoc of fsrDocs) {
    const job = fsrDoc.job;
    if (!job || job.status !== JOB_STATUS.IN_PROGRESS) continue;

    const checkpoints = getFsrAdminCheckpoints(fsrDoc.technicianVisibleAt, now);
    for (const { dueMs } of checkpoints) {
      const ref = new Date(dueMs).toISOString();
      const claimed = await claimNotification(job._id, 'FSR_ADMIN_REMINDER', ref);
      if (!claimed) continue;

      const dedupeKey = `fsr-admin-reminder:${job._id}:${ref}`;
      await createNotification(buildFsrAdminReminderPayload(job, dedupeKey));
      sent += 1;
    }
  }

  return sent;
}

// ── Runner ─────────────────────────────────────────────────────────

/**
 * Run all three checks. Each is isolated so one failing query never blocks the
 * others. Returns a per-rule count of notifications sent (useful for testing).
 */
async function runAllChecks() {
  const result = {
    overdue: 0,
    docReminders: 0,
    startedPendingDocs: 0,
    fsrTechReminders: 0,
    fsrAdminReminders: 0,
  };

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
  try {
    result.fsrTechReminders = await checkFsrTechReminders();
  } catch (err) {
    console.error('[Scheduler] checkFsrTechReminders failed:', err.message);
  }
  try {
    result.fsrAdminReminders = await checkFsrAdminReminders();
  } catch (err) {
    console.error('[Scheduler] checkFsrAdminReminders failed:', err.message);
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
  checkFsrTechReminders,
  checkFsrAdminReminders,
  scheduledStartUtc,
  nextDayAtAdminHourUtc,
  getTimezoneOffsetMs,
  jobHasMissingRequiredDocuments,
  lastAssignedAt,
  getFsrTechCheckpoints,
  getFsrAdminCheckpoints,
  CRON_EXPRESSION,
  TIMEZONE,
};
