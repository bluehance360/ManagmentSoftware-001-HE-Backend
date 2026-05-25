const mongoose = require('mongoose');
const crypto = require('crypto');

const FSR_SIGNATURE_REQUEST_STATUSES = [
  'PENDING',
  'COMPLETED',
  'REPLACED',
  'CANCELLED',
  'EXPIRED',
];

const fsrSignatureRequestSchema = new mongoose.Schema(
  {
    fsrDocument: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FsrDocument',
      required: true,
      index: true,
    },
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Job',
      required: true,
      index: true,
    },
    templateKey: {
      type: String,
      required: true,
      trim: true,
    },
    signatureFieldKey: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    signatureFieldLabel: {
      type: String,
      required: true,
      trim: true,
    },
    recipientEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: FSR_SIGNATURE_REQUEST_STATUSES,
      default: 'PENDING',
      index: true,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    requestedByName: {
      type: String,
      required: true,
      trim: true,
    },
    requestedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    sendCount: {
      type: Number,
      min: 1,
      default: 1,
    },
    lastSentAt: {
      type: Date,
      default: Date.now,
    },
    nextSendAllowedAt: {
      type: Date,
      required: true,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    fieldContext: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    jobSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

fsrSignatureRequestSchema.index({ fsrDocument: 1, signatureFieldKey: 1, createdAt: -1 });

fsrSignatureRequestSchema.statics.generateToken = function generateToken() {
  return crypto.randomBytes(32).toString('hex');
};

module.exports = mongoose.model('FsrSignatureRequest', fsrSignatureRequestSchema);
