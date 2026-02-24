const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Otp = require('../models/Otp');
const { authenticate } = require('../middleware/auth');
const { ROLES } = require('../config/constants');
const { sendOtpEmail } = require('../services/EmailService');

const router = express.Router();

/**
 * @route   POST /api/auth/register
 * @desc    Register a new user (Admin only in production)
 * @access  Public (for initial setup) or Admin only
 */
router.post(
  '/register',
  [
    body('email').isEmail().withMessage('Please provide a valid email'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
    body('name').notEmpty().withMessage('Name is required'),
    body('role')
      .optional()
      .isIn(Object.values(ROLES))
      .withMessage(`Role must be one of: ${Object.values(ROLES).join(', ')}`),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array(),
        });
      }

      const { email, password, name, role } = req.body;

      // Check if user exists
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          error: 'User already exists with this email',
        });
      }

      // Create user
      const user = await User.create({
        email,
        password,
        name,
        role: role || ROLES.TECHNICIAN,
      });

      // Generate token
      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN,
      });

      res.status(201).json({
        success: true,
        data: {
          user,
          token,
        },
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
 * @route   POST /api/auth/login
 * @desc    Login user
 * @access  Public
 */
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Please provide a valid email'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array(),
        });
      }

      const { email, password } = req.body;

      // Check if user exists and get password
      const user = await User.findOne({ email }).select('+password');
      if (!user) {
        return res.status(401).json({
          success: false,
          error: 'Invalid credentials',
        });
      }

      // Check password
      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        return res.status(401).json({
          success: false,
          error: 'Invalid credentials',
        });
      }

      // Check if user is active
      if (!user.isActive) {
        return res.status(401).json({
          success: false,
          error: 'Account is deactivated',
        });
      }

      // Generate token
      const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN,
      });

      res.json({
        success: true,
        data: {
          user,
          token,
        },
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
 * @route   GET /api/auth/me
 * @desc    Get current user
 * @access  Private
 */
router.get('/me', authenticate, async (req, res) => {
  res.json({
    success: true,
    data: req.user,
  });
});

// ── POST /api/auth/forgot-password ──────────────────────────────────
// Send a 6-digit OTP to the user's email if it exists
router.post(
  '/forgot-password',
  [body('email').isEmail().withMessage('Valid email is required')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { email } = req.body;

      const user = await User.findOne({ email });
      if (!user) {
        return res.status(404).json({ success: false, error: 'No account found with this email' });
      }

      // Delete any existing OTPs for this email
      await Otp.deleteMany({ email });

      // Generate 6-digit code
      const code = crypto.randomInt(100000, 999999).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      await Otp.create({ email, code, expiresAt });

      await sendOtpEmail({ to: email, code });

      res.json({ success: true, message: 'OTP sent to your email' });
    } catch (error) {
      console.error('Forgot password error:', error);
      res.status(500).json({ success: false, error: 'Failed to send OTP' });
    }
  }
);

// ── POST /api/auth/verify-otp ───────────────────────────────────────
// Verify the OTP code — returns a one-time reset token
router.post(
  '/verify-otp',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('code').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { email, code } = req.body;

      const otp = await Otp.findOne({
        email,
        code,
        used: false,
        expiresAt: { $gt: new Date() },
      });

      if (!otp) {
        return res.status(400).json({ success: false, error: 'Invalid or expired OTP' });
      }

      // Mark as used
      otp.used = true;
      await otp.save();

      // Generate a short-lived reset token (5 min)
      const resetToken = jwt.sign(
        { email, purpose: 'password-reset' },
        process.env.JWT_SECRET,
        { expiresIn: '5m' }
      );

      res.json({ success: true, resetToken });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/auth/reset-password ───────────────────────────────────
// Set a new password using the reset token from verify-otp
router.post(
  '/reset-password',
  [
    body('resetToken').notEmpty().withMessage('Reset token is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { resetToken, password } = req.body;

      let decoded;
      try {
        decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
      } catch {
        return res.status(400).json({ success: false, error: 'Reset link has expired. Please try again.' });
      }

      if (decoded.purpose !== 'password-reset') {
        return res.status(400).json({ success: false, error: 'Invalid token' });
      }

      const user = await User.findOne({ email: decoded.email });
      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      user.password = password;
      await user.save();

      // Clean up any remaining OTPs for this email
      await Otp.deleteMany({ email: decoded.email });

      res.json({ success: true, message: 'Password reset successfully. Please sign in.' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

module.exports = router;
