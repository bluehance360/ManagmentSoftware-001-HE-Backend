const express = require('express');
const User = require('../models/User');
const { authenticate, authorize } = require('../middleware/auth');
const { ROLES } = require('../config/constants');
const { sendAccountDeletedEmail } = require('../services/EmailService');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

/**
 * @route   GET /api/users
 * @desc    Get all users (Admin only)
 * @access  Private (ADMIN)
 */
router.get('/', authorize(ROLES.ADMIN), async (req, res) => {
  try {
    const { role, isActive } = req.query;

    let filter = {};
    if (role) filter.role = role;
    if (isActive !== undefined) filter.isActive = isActive === 'true';

    const users = await User.find(filter).sort({ createdAt: -1 });

    res.json({
      success: true,
      data: users,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @route   GET /api/users/technicians
 * @desc    Get all technicians (for job assignment)
 * @access  Private (ADMIN, OFFICE_MANAGER)
 */
router.get(
  '/technicians',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const technicians = await User.find({
        role: ROLES.TECHNICIAN,
        isActive: true,
      }).select('name email');

      res.json({
        success: true,
        data: technicians,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

/**
 * @route   GET /api/users/:id
 * @desc    Get user by ID
 * @access  Private (ADMIN)
 */
router.get('/:id', authorize(ROLES.ADMIN), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @route   DELETE /api/users/:id
 * @desc    Delete a user account (Admin only)
 * @access  Private (ADMIN)
 */
router.delete('/:id', authorize(ROLES.ADMIN), async (req, res) => {
  try {
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ success: false, error: 'You cannot delete your own account' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    await User.findByIdAndDelete(req.params.id);

    // Notify the deleted user — non-blocking
    sendAccountDeletedEmail({ to: user.email, name: user.name }).catch((err) =>
      console.error('Failed to send account deleted email:', err.message)
    );

    res.json({ success: true, message: `Account for ${user.name} has been deleted` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
