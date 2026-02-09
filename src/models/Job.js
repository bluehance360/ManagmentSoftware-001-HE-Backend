const mongoose = require('mongoose');
const { JOB_STATUS } = require('../config/constants');

// Sub-schema for status history
const statusHistorySchema = new mongoose.Schema(
  {
    fromStatus: {
      type: String,
      enum: [...Object.values(JOB_STATUS), null],
    },
    toStatus: {
      type: String,
      enum: Object.values(JOB_STATUS),
      required: true,
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    changedAt: {
      type: Date,
      default: Date.now,
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  { _id: true }
);

const jobSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Job title is required'],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    customerName: {
      type: String,
      required: [true, 'Customer name is required'],
      trim: true,
    },
    customerPhone: {
      type: String,
      trim: true,
    },
    customerEmail: {
      type: String,
      lowercase: true,
      trim: true,
    },
    address: {
      type: String,
      trim: true,
    },
    scheduledDate: {
      type: Date,
    },
    status: {
      type: String,
      enum: Object.values(JOB_STATUS),
      default: JOB_STATUS.TENTATIVE,
    },
    assignedTechnician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    statusHistory: [statusHistorySchema],
    estimatedCost: {
      type: Number,
      min: 0,
    },
    actualCost: {
      type: Number,
      min: 0,
    },
    completedAt: {
      type: Date,
    },
    billedAt: {
      type: Date,
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Index for common queries
jobSchema.index({ status: 1, assignedTechnician: 1 });
jobSchema.index({ createdAt: -1 });
jobSchema.index({ scheduledDate: 1 });

module.exports = mongoose.model('Job', jobSchema);
