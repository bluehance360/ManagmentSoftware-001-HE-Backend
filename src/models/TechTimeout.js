const mongoose = require('mongoose');
const { DATE_ONLY_RE } = require('../utils/dateOnly');

const techTimeoutSchema = new mongoose.Schema(
  {
    technician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    startDate: {
      type: String,
      required: [true, 'Start date is required'],
      match: [DATE_ONLY_RE, 'startDate must be in YYYY-MM-DD format'],
    },
    endDate: {
      type: String,
      required: [true, 'End date is required'],
      match: [DATE_ONLY_RE, 'endDate must be in YYYY-MM-DD format'],
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
