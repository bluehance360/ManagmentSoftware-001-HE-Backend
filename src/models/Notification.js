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
        'JOB_DISPATCHED',
        'JOB_STARTED',
        'JOB_COMPLETED',
        'JOB_BILLED',
        'JOB_UPDATED',
        'JOB_DELETED',
      ],
      required: true,
    },
    message: { type: String, required: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job' },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
