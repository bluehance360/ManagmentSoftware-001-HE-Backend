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
        'JOB_FSR_OPENED',
        'JOB_FSR_TEMPLATE_CHANGED',
        'JOB_FSR_LINK_UPDATED',
        'JOB_FSR_SUBMITTED',
        'JOB_FSR_SIGNATURE_REQUESTED',
        'JOB_FSR_SIGNATURE_COMPLETED',
        'JOB_DELETED',
        'JOB_RETURN_VISIT_CREATED',
        'JOB_RETURN_WORKFLOW_UPDATED',
        'JOB_RETURN_REVIEW_REQUESTED',
        'JOB_RETURN_REVIEW_RESOLVED',
        'JOB_INCOMPLETE_RETURN_REQUESTED',
        'JOB_INCOMPLETE_RETURN_APPROVED',
        'JOB_INCOMPLETE_RETURN_REJECTED',
        'JOB_OVERDUE_INCOMPLETE',
        'JOB_DOCS_MISSING_REMINDER',
        'JOB_STARTED_DOCS_PENDING',
        'JOB_FSR_REMINDER_TECH',
        'JOB_FSR_REMINDER_ADMIN',
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
    dedupeKey: { type: String, default: undefined },
    meta: { type: mongoose.Schema.Types.Mixed },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });
notificationSchema.index(
  { recipient: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } }
);

module.exports = mongoose.model('Notification', notificationSchema);
