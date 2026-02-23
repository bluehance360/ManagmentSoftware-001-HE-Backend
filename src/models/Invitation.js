const mongoose = require('mongoose');
const crypto = require('crypto');
const { ROLES } = require('../config/constants');

const invitationSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
    },
    role: {
      type: String,
      enum: Object.values(ROLES),
      required: [true, 'Role is required'],
    },
    token: {
      type: String,
      required: true,
      unique: true,
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    accepted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

invitationSchema.index({ token: 1 });
invitationSchema.index({ email: 1 });
invitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Generate a secure invitation token.
 */
invitationSchema.statics.generateToken = function () {
  return crypto.randomBytes(32).toString('hex');
};

module.exports = mongoose.model('Invitation', invitationSchema);
