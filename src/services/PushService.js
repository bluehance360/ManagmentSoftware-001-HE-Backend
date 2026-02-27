const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');

// Configure VAPID details on module load
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@hosannaelectric.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

/**
 * Send a Web Push notification to a single user (all their devices).
 * Automatically cleans up stale/invalid subscriptions (410 Gone, 404).
 */
async function sendPushToUser(userId, payload) {
  try {
    const subscriptions = await PushSubscription.find({ user: userId }).lean();
    if (subscriptions.length === 0) return;

    const payloadStr = JSON.stringify(payload);

    const results = await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            payloadStr
          );
        } catch (err) {
          // 410 Gone or 404 means the subscription is no longer valid
          if (err.statusCode === 410 || err.statusCode === 404) {
            await PushSubscription.deleteOne({ _id: sub._id });
            console.log(`Cleaned up stale push subscription: ${sub.endpoint.slice(0, 60)}...`);
          } else {
            console.error(`Push failed for ${sub.endpoint.slice(0, 60)}:`, err.statusCode || err.message);
          }
        }
      })
    );

    return results;
  } catch (error) {
    console.error('sendPushToUser error:', error.message);
  }
}

/**
 * Send a Web Push notification to multiple users.
 * Fire-and-forget — does not throw.
 */
async function sendPushToUsers(userIds, payload) {
  if (!userIds || userIds.length === 0) return;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;

  try {
    await Promise.allSettled(
      userIds.map((userId) => sendPushToUser(userId, payload))
    );
  } catch (error) {
    console.error('sendPushToUsers error:', error.message);
  }
}

module.exports = { sendPushToUser, sendPushToUsers };
