const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Customer name is required'],
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      default: '',
    },
    address: {
      type: String,
      trim: true,
      default: '',
    },
    /** When true, assigning a tech requires "First page received" on the assignment checklist. */
    firstPageRequired: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// Text index for search / autocomplete
customerSchema.index({ name: 1 });

module.exports = mongoose.model('Customer', customerSchema);
