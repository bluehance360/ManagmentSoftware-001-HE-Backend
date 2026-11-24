const mongoose = require('mongoose');
const {
  RECEIPT_STATUS,
  RECEIPT_MAX_PHOTOS,
  RECEIPT_MAX_AMOUNT_CENTS,
} = require('../config/constants');

const receiptPhotoSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    fileName: { type: String, required: true, trim: true },
    contentType: { type: String, trim: true, default: 'application/octet-stream' },
    size: { type: Number, min: 0, default: 0 },
  },
  { _id: true }
);

const receiptStatusHistorySchema = new mongoose.Schema(
  {
    // SUBMIT | EDIT | RESUBMIT | AMOUNT | APPROVE | REIMBURSE | REJECT | UNDO
    action: { type: String, required: true },
    fromStatus: { type: String, enum: [...Object.values(RECEIPT_STATUS), null], default: null },
    toStatus: { type: String, enum: Object.values(RECEIPT_STATUS), required: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    changedAt: { type: Date, default: Date.now },
    note: { type: String, trim: true, default: '' },
    // REJECT clears the receipt's amount; the cleared amount is kept here so UNDO can restore it.
    clearedAmountCents: { type: Number, default: undefined },
    clearedAmountSetBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: undefined },
    clearedAmountSetAt: { type: Date, default: undefined },
  },
  { _id: false }
);

const receiptSchema = new mongoose.Schema(
  {
    /** The job (or return visit) the receipt was uploaded on. */
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    /** The original job of the family, so a job and its return visits share one receipt list. */
    rootJob: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /**
     * Receipt total in whole cents (no floating-point rounding in totals). Technicians only
     * upload photos, so this stays null until office staff read the photo and enter it.
     */
    amountCents: {
      type: Number,
      default: null,
      min: [1, 'Amount must be greater than 0'],
      max: [RECEIPT_MAX_AMOUNT_CENTS, 'Amount is too large'],
      validate: {
        validator: (value) => value === null || Number.isInteger(value),
        message: 'Amount must be in whole cents',
      },
    },
    amountSetBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    amountSetAt: { type: Date, default: null },
    photos: {
      type: [receiptPhotoSchema],
      validate: {
        validator: (list) => Array.isArray(list) && list.length >= 1 && list.length <= RECEIPT_MAX_PHOTOS,
        message: `A receipt needs 1 to ${RECEIPT_MAX_PHOTOS} photos`,
      },
    },
    status: {
      type: String,
      enum: Object.values(RECEIPT_STATUS),
      default: RECEIPT_STATUS.SUBMITTED,
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    reimbursedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reimbursedAt: { type: Date, default: null },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, maxlength: 500, default: '' },
    statusHistory: { type: [receiptStatusHistorySchema], default: [] },
  },
  {
    timestamps: true,
    // Two office users acting on the same receipt at once: the second save fails
    // with a VersionError instead of silently overwriting the first.
    optimisticConcurrency: true,
  }
);

receiptSchema.index({ rootJob: 1, createdAt: -1 });

module.exports = mongoose.model('Receipt', receiptSchema);
