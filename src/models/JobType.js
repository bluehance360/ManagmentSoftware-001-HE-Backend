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
  },
  { timestamps: false }
);

jobTypeSchema.pre('validate', function setNormalizedName(next) {
  this.name = typeof this.name === 'string' ? this.name.trim() : this.name;
  this.normalizedName = typeof this.name === 'string' ? this.name.toLowerCase() : this.normalizedName;
  next();
});

module.exports = mongoose.model('JobType', jobTypeSchema);