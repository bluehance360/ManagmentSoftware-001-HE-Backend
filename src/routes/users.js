const express = require('express');
const User = require('../models/User');
const { authenticate, authorize } = require('../middleware/auth');
const { ROLES } = require('../config/constants');

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

module.exports = router;
