const mongoose = require('mongoose');

const techTimeoutSchema = new mongoose.Schema(
  {
    technician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    startDate: {
      type: Date,
      required: [true, 'Start date is required'],
    },
    endDate: {
      type: Date,
      required: [true, 'End date is required'],
    },
    reason: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

// Compound index for efficient date-range lookups
techTimeoutSchema.index({ technician: 1, startDate: 1, endDate: 1 });

module.exports = mongoose.model('TechTimeout', techTimeoutSchema);
