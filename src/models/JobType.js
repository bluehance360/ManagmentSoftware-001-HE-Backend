const mongoose = require('mongoose');

const jobTypeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    normalizedName: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
    },
    certificationRequired: {
      type: Boolean,
      default: false,
    },
    /** When true, jobs of this type require programmingSubtype (New / Existing Start-Up). */
    isProgramming: {
      type: Boolean,
      default: false,
    },
    /** Labels shown in assign flow; future enforcement will use these keys/labels. */
    documentRequirements: {
      type: [
        {
          label: { type: String, required: true, trim: true, maxlength: 200 },
        },
      ],
      default: [],
    },
    programmingDocumentRequirements: {
      newStartup: {
        type: [
          {
            label: { type: String, required: true, trim: true, maxlength: 200 },
          },
        ],
        default: [],
      },
      existingStartup: {
        type: [
          {
            label: { type: String, required: true, trim: true, maxlength: 200 },
          },
        ],
        default: [],
      },
    },
  },
  { timestamps: false }
);

jobTypeSchema.pre('validate', function setNormalizedName(next) {
  this.name = typeof this.name === 'string' ? this.name.trim() : this.name;
  this.normalizedName = typeof this.name === 'string' ? this.name.toLowerCase() : this.normalizedName;
  next();
});

module.exports = mongoose.model('JobType', jobTypeSchema);