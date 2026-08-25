const Notification = require('../models/Notification');
const User = require('../models/User');
const { ROLES } = require('../config/constants');
const { emitToUsers } = require('../socket');
const { sendPushToUsers } = require('./PushService');
const { sendJobEventEmails, TECH_TARGETED_EMAIL_TYPES } = require('./EmailNotificationService');

/**
 * Create notification(s) for relevant users.
 * @param {Object} opts
 * @param {string} opts.type - notification type
 * @param {string} opts.message - human-readable message
 * @param {string} opts.jobId - related job id
 * @param {Object} [opts.meta] - additional metadata for notification actions
 * @param {string[]} [opts.recipientIds] - explicit recipient user ids
 * @param {string[]} [opts.recipientRoles] - send to all users with these roles
 * @param {string} [opts.excludeUserId] - exclude this user (the actor)
 * @param {string} [opts.dedupeKey] - optional idempotency key per recipient
 */
async function createNotification({
  type,
  message,
  jobId,
  meta,
  recipientIds,
  recipientRoles,
  excludeUserId,
  dedupeKey,
}) {
  try {
    let recipients = [];

    if (recipientIds && recipientIds.length > 0) {
      recipients = recipientIds.map((id) => id.toString());
    }

    // Explicitly targeted users (used to scope assignment emails to techs only)
    const idTargeted = new Set(recipients);

    if (recipientRoles && recipientRoles.length > 0) {
      const users = await User.find({
        role: { $in: recipientRoles },
        isActive: true,
      }).select('_id');
      users.forEach((u) => {
        const id = u._id.toString();
        if (!recipients.includes(id)) recipients.push(id);
      });
    }

    // Exclude the actor
    if (excludeUserId) {
      recipients = recipients.filter((id) => id !== excludeUserId.toString());
    }

    if (recipients.length === 0) return;

    let notifiedRecipients = recipients;

    if (dedupeKey) {
      const operations = recipients.map((recipientId) => ({
        updateOne: {
          filter: { recipient: recipientId, dedupeKey },
          update: {
            $setOnInsert: {
              recipient: recipientId,
              type,
              message,
              job: jobId,
              meta,
              dedupeKey,
              read: false,
            },
          },
          upsert: true,
        },
      }));

      const result = await Notification.bulkWrite(operations, { ordered: false });
      const insertedIndexes = Object.keys(result.upsertedIds || {}).map((key) => Number(key));
      notifiedRecipients = insertedIndexes.map((index) => recipients[index]).filter(Boolean);
    } else {
      const docs = recipients.map((recipientId) => ({
        recipient: recipientId,
        type,
        message,
        job: jobId,
        meta,
      }));

      await Notification.insertMany(docs);
    }

    if (notifiedRecipients.length === 0) return;

    // Emit real-time socket event to recipients
    emitToUsers({
      event: 'notification',
      data: { type, message, jobId, meta },
      recipientIds: notifiedRecipients,
      excludeUserId,
    });

    const timeoutRouteTypes = new Set([
      'TECH_TIMEOUT',
      'TECH_TIMEOUT_REQUESTED',
      'TECH_TIMEOUT_APPROVED',
      'TECH_TIMEOUT_REJECTED',
      'TECH_TIMEOUT_CANCELLED',
    ]);

    // Send Web Push to offline users (fire-and-forget)
    sendPushToUsers(notifiedRecipients, {
      title: 'Hosanna Electric',
      body: message,
      icon: '/Hosanna-logo.webp',
      badge: '/Hosanna-logo.webp',
      data: {
        url: jobId
          ? `/jobs?openJob=${jobId}`
          : type === 'TEAM_MEMBER_JOINED'
            ? '/team'
            : timeoutRouteTypes.has(type)
              ? '/timeout'
              : '/dashboard',
        jobId,
        type,
        meta,
      },
    }).catch(() => {}); // non-blocking

    // Send email for allowlisted job events (fire-and-forget).
    // JOB_ASSIGNED / JOB_REASSIGNED email only the targeted technicians -
    // the Admin/Office Manager broadcast copy stays in-app/push only.
    const emailRecipients = TECH_TARGETED_EMAIL_TYPES.has(type)
      ? notifiedRecipients.filter((id) => idTargeted.has(id))
      : notifiedRecipients;
    sendJobEventEmails(emailRecipients, { type, message, jobId, meta }).catch(() => {});
  } catch (error) {
    console.error('Failed to create notifications:', error.message);
    // Non-blocking - don't throw
  }
}

module.exports = { createNotification };
