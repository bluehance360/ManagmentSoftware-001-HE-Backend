const express = require('express');
const { body, validationResult } = require('express-validator');
const Invitation = require('../models/Invitation');
const User = require('../models/User');
const { authenticate, authorize } = require('../middleware/auth');
const { ROLES } = require('../config/constants');
const { sendInvitationEmail } = require('../services/EmailService');

const router = express.Router();

// ── POST /api/invitations  (ADMIN only) ─────────────────────────────
// Send an invitation email to a new team member
router.post(
  '/',
  authenticate,
  authorize(ROLES.ADMIN),
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('role')
      .isIn(Object.values(ROLES))
      .withMessage(`Role must be one of: ${Object.values(ROLES).join(', ')}`),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { email, role } = req.body;

      // Check if user already exists
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          error: 'A user with this email already exists',
        });
      }

      // Check for unexpired pending invitation
      const existingInvite = await Invitation.findOne({
        email,
        accepted: false,
        expiresAt: { $gt: new Date() },
      });
      if (existingInvite) {
        return res.status(400).json({
          success: false,
          error: 'An invitation has already been sent to this email',
        });
      }

      // Create invitation
      const token = Invitation.generateToken();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      const invitation = await Invitation.create({
        email,
        role,
        token,
        invitedBy: req.user._id,
        expiresAt,
      });

      // Send email
      await sendInvitationEmail({
        to: email,
        role,
        token,
        invitedByName: req.user.name,
      });

      res.status(201).json({
        success: true,
        message: 'Invitation sent successfully',
        data: {
          email: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expiresAt,
        },
      });
    } catch (error) {
      console.error('Invitation error:', error);
      res.status(500).json({ success: false, error: 'Failed to send invitation' });
    }
  }
);

// ── GET /api/invitations/verify/:token  (Public) ────────────────────
// Verify an invitation token and return the pre-filled email + role
router.get('/verify/:token', async (req, res) => {
  try {
    const invitation = await Invitation.findOne({
      token: req.params.token,
      accepted: false,
      expiresAt: { $gt: new Date() },
    });

    if (!invitation) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired invitation link',
      });
    }

    res.json({
      success: true,
      data: {
        email: invitation.email,
        role: invitation.role,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /api/invitations/accept  (Public) ──────────────────────────
// Accept an invitation — creates the user account
router.post(
  '/accept',
  [
    body('token').notEmpty().withMessage('Token is required'),
    body('name').notEmpty().withMessage('Name is required'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { token, name, password } = req.body;

      const invitation = await Invitation.findOne({
        token,
        accepted: false,
        expiresAt: { $gt: new Date() },
      });

      if (!invitation) {
        return res.status(400).json({
          success: false,
          error: 'Invalid or expired invitation link',
        });
      }

      // Double-check no user was created in the meantime
      const existingUser = await User.findOne({ email: invitation.email });
      if (existingUser) {
        invitation.accepted = true;
        await invitation.save();
        return res.status(400).json({
          success: false,
          error: 'An account with this email already exists. Please sign in.',
        });
      }

      // Create the user
      await User.create({
        email: invitation.email,
        password,
        name,
        role: invitation.role,
      });

      // Mark invitation as accepted
      invitation.accepted = true;
      await invitation.save();

      res.json({
        success: true,
        message: 'Account created successfully. Please sign in.',
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

module.exports = router;
