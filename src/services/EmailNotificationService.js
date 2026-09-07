/**
 * Email channel for job notifications.
 *
 * Mirrors the in-app / push notification pipeline: createNotification() calls
 * sendJobEventEmails() with the recipients that actually received a new
 * notification (already deduped and actor-excluded), and this module decides
 * whether the event type warrants an email, resolves recipients to addresses,
 * enriches the email with job context, and fans out via the shared transporter.
 *
 * Only types listed in EMAIL_EVENT_LABELS produce emails - everything else
 * (document churn, intermediate status steps, FSR editing activity) stays
 * in-app/push only so inboxes aren't flooded.
 */
const User = require('../models/User');
const Job = require('../models/Job');
require('../models/Customer'); // register schema for the populate below
const { sendJobEventEmail } = require('./EmailService');

// type -> human-readable email heading. Doubles as the email allowlist.
const EMAIL_EVENT_LABELS = {
  JOB_CREATED: 'New Job Created',
  JOB_ASSIGNED: 'Job Assigned to You',
  JOB_REASSIGNED: 'Job Assignment Changed',
  JOB_STARTED: 'Job In Progress',
  JOB_COMPLETED: 'Job Completed',
  JOB_DELETED: 'Job Deleted',
  JOB_FSR_SIGNATURE_REQUESTED: 'FSR Signature Requested',
  JOB_FSR_SUBMITTED: 'FSR Submitted',
  JOB_FSR_SIGNATURE_COMPLETED: 'FSR Signature Completed',
  JOB_INCOMPLETE_RETURN_REQUESTED: 'Incomplete / Return Request Submitted',
  JOB_INCOMPLETE_RETURN_APPROVED: 'Return Request Approved',
  JOB_INCOMPLETE_RETURN_REJECTED: 'Return Request Rejected',
  JOB_RETURN_VISIT_CREATED: 'Return Visit Scheduled',
  JOB_RETURN_REVIEW_REQUESTED: 'Internal Issue Review Requested',
  JOB_RETURN_REVIEW_RESOLVED: 'Internal Issue Review Resolved',
  JOB_OVERDUE_INCOMPLETE: 'Job Overdue - Not Completed',
  JOB_DOCS_MISSING_REMINDER: 'Missing Documents Reminder',
  JOB_STARTED_DOCS_PENDING: 'Job Started - Documents Pending',
  JOB_FSR_REMINDER_TECH: 'FSR Pending Reminder',
  JOB_FSR_REMINDER_ADMIN: 'FSR Pending Reminder',
};

// For these types, only the explicitly targeted users (recipientIds) are
// emailed - the Admin/Office Manager broadcast copy stays in-app/push only.
const TECH_TARGETED_EMAIL_TYPES = new Set(['JOB_ASSIGNED', 'JOB_REASSIGNED']);

// In-flight email sends. Long-lived processes never need this, but short-lived
// scripts (the cron r-nner) must drain it before exiting, or fire-and-forget
// emails are killed mid-send.
const inFlight = new Set();

/** Resolves when every email send started so far has settled. */
async function waitForEmailQueue() {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

function isSmtpConfigured() {
  // Auth is optional — a local catch-all like Mailpit runs without credentials.
  return Boolean(process.env.SMTP_HOST);
}

function prettifyStatus(status) {
  if (!status) return '';
  return String(status)
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

/** Build the [label, value] summary rows shown in the email. */
function buildJobDetails(job) {
  if (!job) return [];
  return [
    ['Job', job.title],
    ['Customer', [job.companyName, job.customerName || job.customer?.name].filter(Boolean).join(' / ')],
    ['Address', job.address],
    ['Job Type', job.jobType],
    ['Status', prettifyStatus(job.status)],
    ['Scheduled', job.scheduledDate],
  ];
}

/**
 * Send job event emails to the given users. Fire-and-forget safe: never throws.
 * @param {string[]} recipientIds - user ids that received the in-app notification
 * @param {Object} opts
 * @param {string} opts.type    - notification type
 * @param {string} opts.message - notification message text
 * @param {string|null} [opts.jobId] - related job id (null e.g. for JOB_DELETED)
 * @param {Object} [opts.meta] - notification meta (meta.jobTitle used when the job is gone)
 */
function sendJobEventEmails(recipientIds, payload) {
  const promise = sendJobEventEmailsInner(recipientIds, payload).finally(() => {
    inFlight.delete(promise);
  });
  inFlight.add(promise);
  return promise;
}

async function sendJobEventEmailsInner(recipientIds, { type, message, jobId, meta }) {
  try {
    const eventLabel = EMAIL_EVENT_LABELS[type];
    if (!eventLabel) return; // type not allowlisted for email
    if (!isSmtpConfigured()) return;
    if (!recipientIds || recipientIds.length === 0) return;

    const users = await User.find({
      _id: { $in: recipientIds },
      isActive: true,
    }).select('email name');
    if (users.length === 0) return;

    // Job context is best-effort — a deleted or missing job still emails the message.
    let job = null;
    if (jobId) {
      job = await Job.findById(jobId)
        .select('title companyName customerName customer address jobType status scheduledDate')
        .populate('customer', 'name')
        .lean()
        .catch(() => null);
    }
    const details = buildJobDetails(job);
    const subjectSuffix = job?.title || meta?.jobTitle || undefined;
    const results = await Promise.allSettled(
      users.map((user) =>
        sendJobEventEmail({
          to: user.email,
          recipientName: user.name,
          eventLabel,
          message,
          details,
          jobId: jobId ? String(jobId) : null,
          subjectSuffix,
        })
      )
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[Email] ${type} -> ${users[i].email} failed:`, r.reason?.message);
      }
    });
  } catch (error) {
    console.error('[Email] sendJobEventEmails error:', error.message);
    // Non-blocking — never throw into the notification pipeline
  }
}

module.exports = { sendJobEventEmails, waitForEmailQueue, EMAIL_EVENT_LABELS, TECH_TARGETED_EMAIL_TYPES };
