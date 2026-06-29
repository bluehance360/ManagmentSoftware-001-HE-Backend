const mongoose = require('mongoose');

const FSR_TEMPLATE_KEYS = ['STANDARD', 'WATTSTOPPER', 'LEVITON_EXTERNAL', 'KORE'];
const FSR_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED'];
const FSR_TEMPLATE_SOURCES = ['AUTO', 'MANUAL_OVERRIDE'];

const fsrAssetSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
    },
    fileName: {
      type: String,
      required: true,
      trim: true,
    },
    contentType: {
      type: String,
      trim: true,
      default: 'application/octet-stream',
    },
    size: {
      type: Number,
      min: 0,
      default: 0,
    },
    caption: {
      type: String,
      trim: true,
      default: '',
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const fsrJobSnapshotSchema = new mongoose.Schema(
  {
    projectName: { type: String, trim: true, default: '' },
    siteAddress: { type: String, trim: true, default: '' },
    date: { type: String, trim: true, default: '' },
    technicianName: { type: String, trim: true, default: '' },
    secondaryTechnicianName: { type: String, trim: true, default: '' },
    companyName: { type: String, trim: true, default: '' },
    customerName: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const fsrDocumentSchema = new mongoose.Schema(
  {
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Job',
      required: true,
      unique: true,
      index: true,
    },
    templateKey: {
      type: String,
      enum: FSR_TEMPLATE_KEYS,
      required: true,
    },
    templateSource: {
      type: String,
      enum: FSR_TEMPLATE_SOURCES,
      default: 'AUTO',
    },
    status: {
      type: String,
      enum: FSR_STATUSES,
      default: 'NOT_STARTED',
      index: true,
    },
    technicianVisible: {
      type: Boolean,
      default: false,
    },
    technicianVisibleAt: {
      type: Date,
      default: null,
    },
    levitonExternalLink: {
      type: String,
      trim: true,
      default: '',
    },
    jobSnapshot: {
      type: fsrJobSnapshotSchema,
      default: undefined,
    },
    submissionData: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },
    draftSignatures: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    assets: {
      type: [fsrAssetSchema],
      default: [],
    },
    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    submittedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

fsrDocumentSchema.index({ templateKey: 1, status: 1, submittedAt: -1 });

module.exports = mongoose.model('FsrDocument', fsrDocumentSchema);
