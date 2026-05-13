const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        'JOB_CREATED',
        'JOB_CONFIRMED',
        'JOB_ASSIGNED',
        'JOB_REASSIGNED',
        'JOB_STARTED',
        'JOB_COMPLETED',
        'JOB_BILLED',
        'JOB_PAID',
        'JOB_CLOSED',
        'JOB_DOCUMENT_UPLOADED',
        'JOB_DOCUMENT_DELETED',
        'JOB_DOCUMENTS_UPDATED',
        'JOB_UPDATED',
        'JOB_DELETED',
        'JOB_RETURN_VISIT_CREATED',
        'JOB_RETURN_WORKFLOW_UPDATED',
        'JOB_RETURN_REVIEW_REQUESTED',
        'JOB_RETURN_REVIEW_RESOLVED',
        'JOB_INCOMPLETE_RETURN_REQUESTED',
        'JOB_INCOMPLETE_RETURN_APPROVED',
        'JOB_INCOMPLETE_RETURN_REJECTED',
        'TEAM_MEMBER_JOINED',
        'TECH_TIMEOUT',
        'TECH_TIMEOUT_REQUESTED',
        'TECH_TIMEOUT_APPROVED',
        'TECH_TIMEOUT_REJECTED',
        'TECH_TIMEOUT_CANCELLED',
      ],
      required: true,
    },
    message: { type: String, required: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job' },
    meta: { type: mongoose.Schema.Types.Mixed },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
