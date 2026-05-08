const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { ROLES } = require('../config/constants');

const certificateSchema = new mongoose.Schema(
  {
    jobTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JobType',
      required: true,
    },
    jobTypeName: {
      type: String,
      required: true,
      trim: true,
    },
    document: {
      key: { type: String, required: true },
      fileName: { type: String, required: true },
      contentType: { type: String, default: 'application/octet-stream' },
      size: { type: Number, default: 0 },
    },
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { _id: true }
);

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: 6,
      select: false, // Don't include password by default in queries
    },
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    role: {
      type: String,
      enum: Object.values(ROLES),
      default: ROLES.TECHNICIAN,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Per-job-type certifications. One entry per certified jobTypeId.
    certificates: {
      type: [certificateSchema],
      default: [],
    },
  },
  {
    timestamps: true,
  }
);

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Remove password from JSON output
userSchema.methods.toJSON = function () {
  const user = this.toObject();
  delete user.password;
  return user;
};

module.exports = mongoose.model('User', userSchema);
