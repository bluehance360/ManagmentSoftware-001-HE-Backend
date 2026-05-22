const mongoose = require('mongoose');

const requirementRowSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 200 },
  },
  { _id: false }
);

const jobTypeSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    programmingDocumentRequirements: {
      newStartup: { type: [requirementRowSchema], default: [] },
      existingStartup: { type: [requirementRowSchema], default: [] },
    },
  },
  { timestamps: false }
);

module.exports = mongoose.model('JobTypeSettings', jobTypeSettingsSchema);
