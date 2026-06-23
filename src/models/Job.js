const mongoose = require('mongoose');
const { JOB_STATUS } = require('../config/constants');
const { DATE_ONLY_RE } = require('../utils/dateOnly');

// Sub-schema for status history
const statusHistorySchema = new mongoose.Schema(
  {
    fromStatus: {
      type: String,
      enum: [...Object.values(JOB_STATUS), null],
    },
    toStatus: {
      type: String,
      enum: Object.values(JOB_STATUS),
      required: true,
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    changedAt: {
      type: Date,
      default: Date.now,
    },
    notes: {
      type: String,
      trim: true,
    },
    technician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    assignmentChecklist: {
      firstPageReceived: { type: Boolean, default: false },
      printsDrawingsReceived: { type: Boolean, default: false },
      siteContactInfoReceived: { type: Boolean, default: false },
    },
  },
  { _id: true }
);

const documentSchema = new mongoose.Schema(
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
    note: {
      type: String,
      trim: true,
      default: '',
    },
    isSiteInfo: {
      type: Boolean,
      default: false,
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

const assignmentDocumentRequirementSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    checked: { type: Boolean, default: false },
    textValue: { type: String, trim: true, default: '' },
    document: {
      key: { type: String, trim: true },
      fileName: { type: String, trim: true },
      contentType: { type: String, trim: true, default: 'application/octet-stream' },
      size: { type: Number, min: 0, default: 0 },
      uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      uploadedAt: { type: Date },
    },
  },
  { _id: false }
);

const RETURN_WORKFLOW_REASONS = ['NONE', 'RETURN_VISIT', 'MANUFACTURER', 'OUR_ISSUE'];
const RMA_STATUSES = ['ORDERED', 'WAITING', 'RECEIVED'];
const OUR_ISSUE_REVIEW_STATUSES = ['NONE', 'PENDING', 'APPROVED', 'REJECTED'];
const JOB_VISIT_KINDS = ['STANDARD', 'RETURN'];

/** Technician submits → admin approves → admin schedules return child job. */
const incompleteReturnRequestSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED'],
      default: 'NONE',
    },
    reasonType: {
      type: String,
      enum: ['MANUFACTURER', 'OUR_ISSUE'],
    },
    manufacturer: {
      partsNeeded: { type: String, trim: true, default: '' },
      rmaStatus: {
        type: String,
        enum: RMA_STATUSES,
        default: 'WAITING',
      },
    },
    describeReason: { type: String, trim: true, default: '' },
    /** UI-only for now (no server-side behavior). */
    needsManagerContactStatic: { type: Boolean, default: false },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedAt: { type: Date },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    adminReviewNotes: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const returnWorkflowSchema = new mongoose.Schema(
  {
    reason: {
      type: String,
      enum: RETURN_WORKFLOW_REASONS,
      default: 'NONE',
    },
    manufacturer: {
      partsNeeded: { type: String, trim: true, default: '' },
      rmaStatus: {
        type: String,
        enum: RMA_STATUSES,
        default: 'WAITING',
      },
    },
    ourIssue: {
      techRequestedAdminContact: { type: Boolean, default: false },
      reviewStatus: {
        type: String,
        enum: OUR_ISSUE_REVIEW_STATUSES,
        default: 'NONE',
      },
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      reviewedAt: { type: Date, default: null },
      reviewNotes: { type: String, trim: true, default: '' },
    },
    returnNotes: { type: String, trim: true, default: '' },
    paymentDiscussionNeeded: { type: Boolean, default: true },
  },
  { _id: false }
);

const jobSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Job title is required'],
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
    },
    companyName: {
      type: String,
      trim: true,
    },
    customerName: {
      type: String,
      trim: true,
    },
    customerPhone: {
      type: String,
      trim: true,
    },
    customerEmail: {
      type: String,
      lowercase: true,
      trim: true,
    },
    address: {
      type: String,
      trim: true,
    },
    // ── Job-site info (shown to technicians in place of the customer address) ──
    // TEXT  → siteInfoText is shown.
    // PDF   → documents flagged isSiteInfo are shown.
    siteInfoMode: {
      type: String,
      enum: ['TEXT', 'PDF'],
      default: 'TEXT',
    },
    siteInfoText: {
      type: String,
      trim: true,
      default: '',
    },
    scheduledDate: {
      type: String,
      match: [DATE_ONLY_RE, 'scheduledDate must be in YYYY-MM-DD format'],
    },
    status: {
      type: String,
      enum: Object.values(JOB_STATUS),
      default: JOB_STATUS.TENTATIVE,
    },
    assignedTechnician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    secondaryAssignedTechnician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    statusHistory: [statusHistorySchema],
    documents: [documentSchema],
    estimatedCost: {
      type: Number,
      min: 0,
    },
    jobType: {
      type: String,
      trim: true,
    },
    programmingSubtype: {
      type: String,
      enum: ['New Start-Up', 'Existing Start-Up'],
      trim: true,
    },
    assignmentChecklist: {
      firstPageReceived: { type: Boolean, default: false },
      printsDrawingsReceived: { type: Boolean, default: false },
      siteContactInfoReceived: { type: Boolean, default: false },
    },
    assignmentDocumentRequirements: {
      type: [assignmentDocumentRequirementSchema],
      default: [],
    },
    actualCost: {
      type: Number,
      min: 0,
    },
    completedAt: {
      type: Date,
    },
    billedAt: {
      type: Date,
    },
    notes: {
      type: String,
      trim: true,
    },
    /** Parent job when this row is a return visit (child). */
    parentJob: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Job',
      default: null,
    },
    /** STANDARD job vs RETURN visit row (child linked to parentJob). */
    jobVisitKind: {
      type: String,
      enum: JOB_VISIT_KINDS,
      default: 'STANDARD',
    },
    /** Incomplete-job / return / manufacturer / our-issue context (stored on the root job, not the return child). */
    returnWorkflow: {
      type: returnWorkflowSchema,
      default: () => ({}),
    },
    incompleteReturnRequest: {
      type: incompleteReturnRequestSchema,
      default: undefined,
    },
  },
  {
    timestamps: true,
  }
);

// Index for common queries
jobSchema.index({ status: 1, assignedTechnician: 1 });
jobSchema.index({ createdAt: -1 });
jobSchema.index({ scheduledDate: 1 });
jobSchema.index({ jobType: 1 });
jobSchema.index({ parentJob: 1 });
jobSchema.index({ jobVisitKind: 1 });

module.exports = mongoose.model('Job', jobSchema);
