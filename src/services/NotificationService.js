const Notification = require('../models/Notification');
const User = require('../models/User');
const { ROLES } = require('../config/constants');
const { emitToUsers } = require('../socket');

/**
 * Create notification(s) for relevant users.
 * @param {Object} opts
 * @param {string} opts.type - notification type
 * @param {string} opts.message - human-readable message
 * @param {string} opts.jobId - related job id
 * @param {string[]} [opts.recipientIds] - explicit recipient user ids
 * @param {string[]} [opts.recipientRoles] - send to all users with these roles
 * @param {string} [opts.excludeUserId] - exclude this user (the actor)
 */
async function createNotification({ type, message, jobId, recipientIds, recipientRoles, excludeUserId }) {
  try {
    let recipients = [];

    if (recipientIds && recipientIds.length > 0) {
      recipients = recipientIds.map((id) => id.toString());
    }

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

    const docs = recipients.map((recipientId) => ({
      recipient: recipientId,
      type,
      message,
      job: jobId,
    }));

    await Notification.insertMany(docs);

    // Emit real-time socket event to recipients
    emitToUsers({
      event: 'notification',
      data: { type, message, jobId },
      recipientIds: recipients,
      excludeUserId,
    });
  } catch (error) {
    console.error('Failed to create notifications:', error.message);
    // Non-blocking — don't throw
  }
}

module.exports = { createNotification };
