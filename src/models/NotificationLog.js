const mongoose = require('mongoose');

/**
 * Deduplication ledger for automated/scheduled notifications.
 *
 * The scheduler (SchedulerService) runs every 30 minutes and re-evaluates every
 * eligible job. Before sending an automated notification it "claims" a row here;
 * the unique { job, type, ref } index makes the claim atomic, so a given
 * notification can only ever be sent once - even across server restarts or if
 * two cron ticks overlap.
 *
 * `ref` is a discriminator that lets the same notification type fire again when
 * the underlying trigger genuinely changes:
 *   - Rule 1 (OVERDUE_24H):      ref = the assignment timestamp (ISO). A
 *                                reassignment pushes a new ASSIGNED history
 *                                entry → new ref → the 24h clock resets.
 *   - Rule 2 (DOC_REMINDER_*H):  ref = the job's scheduledDate. Rescheduling a
 *                                job → new ref → reminders re-evaluate.
 *   - Rule 3 (DOC_STARTED_PENDING): ref = '' (fire exactly once per job).
 */
const notificationLogSchema = new mongoose.Schema(
  {
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Job',
      required: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
    },
    ref: {
      type: String,
      default: '',
    },
    sentAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// The atomic dedup guarantee: one notification per (job, type, ref) tuple.
notificationLogSchema.index({ job: 1, type: 1, ref: 1 }, { unique: true });

module.exports = mongoose.model('NotificationLog', notificationLogSchema);
