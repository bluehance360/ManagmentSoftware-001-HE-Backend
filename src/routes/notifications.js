const express = require('express');
const Notification = require('../models/Notification');
const PushSubscription = require('../models/PushSubscription');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

function protectedPendingRequestFilter(userId) {
  return {
    recipient: userId,
    type: 'TECH_TIMEOUT_REQUESTED',
    'meta.timeoutStatus': 'PENDING',
  };
}

// ══════════════════════════════════════════════════════════════════════
// Push subscription endpoints (must come before /:id param routes)
// ══════════════════════════════════════════════════════════════════════

// ── GET /api/notifications/push/vapid-key ───────────────────────────
router.get('/push/vapid-key', (req, res) => {
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
  if (!vapidPublicKey) {
    return res.status(500).json({ success: false, error: 'VAPID public key not configured' });
  }
  res.json({ success: true, data: { vapidPublicKey } });
});

router.post('/push/subscribe', async (req, res) => {
  try {
    const { endpoint, keys } = req.body;

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ success: false, error: 'Invalid subscription data' });
    }

    // Upsert: update if same user+endpoint exists, insert otherwise
    await PushSubscription.findOneAndUpdate(
      { user: req.user._id, endpoint },
      {
        user: req.user._id,
        endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
        userAgent: req.headers['user-agent'] || '',
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, message: 'Push subscription registered' });
  } catch (error) {
    // Handle duplicate key errors gracefully
    if (error.code === 11000) {
      return res.json({ success: true, message: 'Push subscription already registered' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});


router.delete('/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ success: false, error: 'Endpoint is required' });
    }

    await PushSubscription.deleteOne({ user: req.user._id, endpoint });
    res.json({ success: true, message: 'Push subscription removed' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
// In-app notification endpoints
// ══════════════════════════════════════════════════════════════════════

// ── GET /api/notifications ──────────────────────────────────────────
// Get user's notifications (most recent first, limit 50)
router.get('/', async (req, res) => {
  try {
    const notifications = await Notification.find({ recipient: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ success: true, data: notifications });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /api/notifications/unread-count ─────────────────────────────
router.get('/unread-count', async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      recipient: req.user._id,
      read: false,
    });
    res.json({ success: true, data: { count } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── PATCH /api/notifications/:id/read ───────────────────────────────
router.patch('/:id/read', async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.user._id },
      { read: true },
      { new: true }
    );
    if (!notification) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }
    res.json({ success: true, data: notification });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── PATCH /api/notifications/read-all ───────────────────────────────
router.patch('/read-all', async (req, res) => {
  try {
    await Notification.updateMany(
      { recipient: req.user._id, read: false },
      { read: true }
    );
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── DELETE /api/notifications/all ───────────────────────────────────
router.delete('/all', async (req, res) => {
  try {
    const [result, preservedCount] = await Promise.all([
      Notification.deleteMany({
        recipient: req.user._id,
        $nor: [
          {
            type: 'TECH_TIMEOUT_REQUESTED',
            'meta.timeoutStatus': 'PENDING',
          },
        ],
      }),
      Notification.countDocuments(protectedPendingRequestFilter(req.user._id)),
    ]);

    const message = preservedCount > 0
      ? `Deleted ${result.deletedCount} notifications. ${preservedCount} pending timeout request notification${preservedCount === 1 ? '' : 's'} ${preservedCount === 1 ? 'was' : 'were'} kept because action is still required.`
      : `Deleted ${result.deletedCount} notifications`;

    res.json({
      success: true,
      message,
      data: {
        deletedCount: result.deletedCount,
        preservedCount,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── DELETE /api/notifications/:id ───────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const protectedNotification = await Notification.findOne({
      _id: req.params.id,
      ...protectedPendingRequestFilter(req.user._id),
    }).lean();

    if (protectedNotification) {
      return res.status(400).json({
        success: false,
        error: 'Pending timeout request notifications cannot be deleted while action is still required',
      });
    }

    const notification = await Notification.findOneAndDelete({
      _id: req.params.id,
      recipient: req.user._id,
    });
    if (!notification) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }
    res.json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
