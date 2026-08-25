/**
 * JobService - hardened job lifecycle operations.
 *
 * Every status transition uses findOneAndUpdate with the current status
 * in the filter. If the document's status changed between the time the
 * client read it and the time this update runs, the filter won't match
 * and we return null → "conflict / stale" error.
 *
 * This eliminates the classic find-then-save race condition.
 */

const mongoose = require('mongoose');
const Job = require('../models/Job');
const User = require('../models/User');
const Customer = require('../models/Customer');
const JobType = require('../models/JobType');
const TechTimeout = require('../models/TechTimeout');
const { ROLES, JOB_STATUS, STATUS_TRANSITIONS, TIMEOUT_REQUEST_STATUS } = require('../config/constants');
const { normalizeDateOnly, toLocalDateOnly } = require('../utils/dateOnly');
const { getFsrDocumentByJobId, FSR_STATUS } = require('./FsrService');

/**
 * Look up the JobType doc matching a job's stored jobType name (case-insensitive).
 * Returns null if not found in the JobType collection (e.g. legacy free-text type).
 */
async function findJobTypeByName(jobTypeName) {
  if (!jobTypeName || typeof jobTypeName !== 'string') return null;
  const normalized = jobTypeName.trim().toLowerCase();
  if (!normalized) return null;
  return JobType.findOne({ normalizedName: normalized }).lean();
}

/**
 * If the job's type requires certification, ensure each listed technician id is certified.
 * Used for primary assignment only; secondary does not require certification for the job type.
 * Returns an error string if any technician is missing the cert, otherwise null.
 */
async function ensureTechCertifiedForJobType(jobTypeName, technicianIds) {
  const ids = (technicianIds || []).filter(Boolean);
  if (!ids.length) return null;
  const type = await findJobTypeByName(jobTypeName);
  if (!type || !type.certificationRequired) return null;

  const techs = await User.find({ _id: { $in: ids } })
    .select('name certificates')
    .lean();
  for (const tech of techs) {
    const hasCert = (tech.certificates || []).some(
      (c) => c.jobTypeId?.toString() === type._id.toString()
    );
    if (!hasCert) {
      return `Technician ${tech.name} is not certified for ${type.name}`;
    }
  }
  return null;
}

/**
 * Check if a technician is unavailable on a given date.
 * Returns a reason string if unavailable, or null if available.
 */
async function checkTechAvailability(technicianId, scheduledDate, excludeJobId = null) {
  // 1) Block if the tech already has any active job (ASSIGNED or IN_PROGRESS).
  // A technician must finish their current job before being assigned a new one.
  const activeJobQuery = {
    $or: [
      { assignedTechnician: technicianId },
      { secondaryAssignedTechnician: technicianId },
    ],
    status: { $in: [JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS] },
  };
  if (excludeJobId) {
    activeJobQuery._id = { $ne: excludeJobId };
  }
  const activeJob = await Job.findOne(activeJobQuery).select('title status').lean();

  if (activeJob) {
    return `Already has an active job: "${activeJob.title}" (${activeJob.status})`;
  }

  // 2) Check if the tech is on time-off on the target schedule day.
  const targetDay = normalizeDateOnly(scheduledDate) || toLocalDateOnly();

  const timeout = await TechTimeout.findOne({
    technician: technicianId,
    $or: [
      { status: TIMEOUT_REQUEST_STATUS.APPROVED },
      { status: { $exists: false } },
    ],
    startDate: { $lte: targetDay },
    endDate: { $gte: targetDay },
  }).lean();

  if (timeout) {
    return timeout.reason || 'Currently on time-off / leave';
  }

  return null;
}

// ── helpers ──────────────────────────────────────────────────────────

const POPULATE_FIELDS = [
  { path: 'assignedTechnician', select: 'name email' },
  { path: 'secondaryAssignedTechnician', select: 'name email' },
  { path: 'createdBy', select: 'name email' },
  { path: 'statusHistory.changedBy', select: 'name email role' },
  { path: 'statusHistory.technician', select: 'name email' },
  { path: 'documents.uploadedBy', select: 'name email role' },
  { path: 'customer', select: 'name phone email address firstPageRequired' },
  {
    path: 'parentJob',
    select: 'title scheduledDate status assignedTechnician secondaryAssignedTechnician',
    populate: [
      { path: 'assignedTechnician', select: 'name email' },
      { path: 'secondaryAssignedTechnician', select: 'name email' },
    ],
  },
];

/**
 * Validate whether role + currentStatus → newStatus is legal.
 * Pure function - no DB calls.
 */
function validateTransition(currentStatus, newStatus, role) {
  if (currentStatus === newStatus) {
    return 'Job is already in this status';
  }

  const allowed = STATUS_TRANSITIONS[currentStatus];
  if (!allowed || !(newStatus in allowed)) {
    const valid = allowed ? Object.keys(allowed) : [];
    return `Invalid transition from ${currentStatus} to ${newStatus}. Valid: ${valid.length ? valid.join(', ') : 'none (terminal state)'}`;
  }

  if (!allowed[newStatus].includes(role)) {
    return `Role ${role} cannot move job from ${currentStatus} to ${newStatus}. Allowed: ${allowed[newStatus].join(', ')}`;
  }

  return null; // no error
}

// ── public API ───────────────────────────────────────────────────────

/**
 * Create a new job. Only ADMIN.
 */
async function createJob(data, userId) {
  const normalizedScheduledDate = normalizeDateOnly(data.scheduledDate);
  const jobData = {
    title: data.title,
    description: data.description,
    scheduledDate: normalizedScheduledDate,
    jobType: typeof data.jobType === 'string' ? data.jobType.trim() : undefined,
    programmingSubtype:
      typeof data.programmingSubtype === 'string'
        ? data.programmingSubtype.trim()
        : undefined,
    estimatedCost: data.estimatedCost,
    notes: data.notes,
    createdBy: userId,
    status: JOB_STATUS.TENTATIVE,
    statusSeenBy: [userId],
    statusHistory: [
      {
        fromStatus: null,
        toStatus: JOB_STATUS.TENTATIVE,
        changedBy: userId,
        notes: 'Job created',
      },
    ],
  };

  // New flow: customer reference + optional companyName
  if (data.customerId) {
    jobData.customer = data.customerId;
  }
  if (data.companyName) {
    jobData.companyName = data.companyName;
  }
  // Job-site info (text or PDF mode)
  if (data.siteInfoMode === 'PDF' || data.siteInfoMode === 'TEXT') {
    jobData.siteInfoMode = data.siteInfoMode;
  }
  if (typeof data.siteInfoText === 'string') {
    jobData.siteInfoText = data.siteInfoText.trim();
  }
  // Legacy fields (backward compat for old jobs)
  if (data.customerName) jobData.customerName = data.customerName;
  if (data.customerPhone) jobData.customerPhone = data.customerPhone;
  if (data.customerEmail) jobData.customerEmail = data.customerEmail;
  if (data.address) jobData.address = data.address;

  const job = await Job.create(jobData);

  return Job.populate(job, POPULATE_FIELDS);
}

/**
 * Transition job status atomically.
 *
 * The key trick: the filter includes { status: currentStatus }.
 * If another request already changed the status, the filter won't
 * match, findOneAndUpdate returns null, and we know there was a
 * race / stale read.
 */
async function transitionStatus(jobId, newStatus, user, notes) {
  // 1) Read current job to validate business rules
  const job = await Job.findById(jobId);
  if (!job) return { error: 'Job not found', status: 404 };

  const currentStatus = job.status;

  // 2) Validate transition + role
  const err = validateTransition(currentStatus, newStatus, user.role);
  if (err) return { error: err, status: 400 };

  // 2b) Notes are required when moving to IN_PROGRESS (tech starting work)
  if (newStatus === JOB_STATUS.IN_PROGRESS && (!notes || !notes.trim())) {
    return { error: 'Notes are required when starting a job', status: 400 };
  }

  // 2b2) Incomplete / Return: cannot start work while request is pending or approved (OK again after REJECTED / cleared)
  if (currentStatus === JOB_STATUS.ASSIGNED && newStatus === JOB_STATUS.IN_PROGRESS) {
    const irs = job.incompleteReturnRequest?.status;
    if (irs === 'PENDING' || irs === 'APPROVED') {
      return {
        error:
          'Start work is disabled while an Incomplete / Return request is pending or approved. It becomes available again if that request is rejected.',
        status: 400,
      };
    }
  }

  // 2c) Our-issue path: cannot complete until Admin/Manager approves
  if (currentStatus === JOB_STATUS.IN_PROGRESS && newStatus === JOB_STATUS.COMPLETED) {
    const ow = job.returnWorkflow?.ourIssue;
    if (ow?.techRequestedAdminContact && ow.reviewStatus !== 'APPROVED') {
      return {
        error:
          'This job is flagged for an internal (our) issue review. An Admin or Office Manager must approve before it can be marked completed.',
        status: 400,
      };
    }
  }

  if (currentStatus === JOB_STATUS.IN_PROGRESS && newStatus === JOB_STATUS.COMPLETED) {
    const fsrDoc = await getFsrDocumentByJobId(jobId);
    if (fsrDoc && fsrDoc.status !== FSR_STATUS.SUBMITTED) {
      return {
        error: 'FSR must be submitted before this job can be marked completed.',
        status: 400,
      };
    }
  }

  // 3) Technician must be the one assigned
  if (user.role === ROLES.TECHNICIAN) {
    const isPrimary = job.assignedTechnician?.toString() === user._id.toString();
    const isSecondary = job.secondaryAssignedTechnician?.toString() === user._id.toString();
    if (!isPrimary && !isSecondary) {
      return { error: 'You are not assigned to this job', status: 403 };
    }
  }

  // 4) Build atomic update
  const $set = { status: newStatus };
  if (newStatus === JOB_STATUS.COMPLETED) $set.completedAt = new Date();
  if (newStatus === JOB_STATUS.BILLED) $set.billedAt = new Date();

  const historyEntry = {
    _id: new mongoose.Types.ObjectId(),
    fromStatus: currentStatus,
    toStatus: newStatus,
    changedBy: user._id,
    changedAt: new Date(),
    notes: notes || `Status changed from ${currentStatus} to ${newStatus}`,
  };

  // 5) Atomic update - status in filter prevents race condition
  const updated = await Job.findOneAndUpdate(
    { _id: jobId, status: currentStatus },
    {
      $set,
      $push: { statusHistory: historyEntry },
    },
    { new: true }
  ).populate(POPULATE_FIELDS);

  if (!updated) {
    return {
      error: 'Conflict: job status was changed by another request. Please refresh and retry.',
      status: 409,
    };
  }

  return { data: updated };
}

/**
 * Assign a technician (CONFIRMED → ASSIGNED) atomically.
 * Notes are required so the manager provides assignment instructions.
 */
async function assignTechnician(
  jobId,
  technicianId,
  user,
  notes,
  assignmentChecklist = {},
  secondaryTechnicianId = null,
  assignmentDocumentRequirements = []
) {
  const jobForSchedule = await Job.findById(jobId).select('scheduledDate jobType customer').lean();
  if (!jobForSchedule) return { error: 'Job not found', status: 404 };

  // 1) Verify technician exists and has correct role
  const technician = await User.findById(technicianId);
  if (!technician) return { error: 'Technician not found', status: 404 };
  if (technician.role !== ROLES.TECHNICIAN) {
    return { error: 'User is not a technician', status: 400 };
  }
  let secondaryTechnician = null;
  if (secondaryTechnicianId) {
    if (secondaryTechnicianId.toString() === technicianId.toString()) {
      return { error: 'Primary and secondary technicians must be different', status: 400 };
    }
    secondaryTechnician = await User.findById(secondaryTechnicianId);
    if (!secondaryTechnician) return { error: 'Secondary technician not found', status: 404 };
    if (secondaryTechnician.role !== ROLES.TECHNICIAN) {
      return { error: 'Secondary user is not a technician', status: 400 };
    }
  }

  // 2) Notes are required when assigning
  if (!notes || !notes.trim()) {
    return { error: 'Notes / instructions are required when assigning a technician', status: 400 };
  }

  // 2b) Validate transition
  const err = validateTransition(JOB_STATUS.CONFIRMED, JOB_STATUS.ASSIGNED, user.role);
  if (err) return { error: err, status: 400 };

  // 2c) Check technician availability:
  //  - blocks if tech has any active (ASSIGNED/IN_PROGRESS) job
  //  - blocks if tech is on time-off today
  const unavailReason = await checkTechAvailability(technicianId, jobForSchedule.scheduledDate);
  if (unavailReason) {
    return {
      error: `Technician ${technician.name} is unavailable: ${unavailReason}`,
      status: 400,
    };
  }
  if (secondaryTechnicianId) {
    const secondaryUnavailReason = await checkTechAvailability(
      secondaryTechnicianId,
      jobForSchedule.scheduledDate
    );
    if (secondaryUnavailReason) {
      return {
        error: `Secondary technician ${secondaryTechnician.name} is unavailable: ${secondaryUnavailReason}`,
        status: 400,
      };
    }
  }

  // 2d) If the job type requires certification, only the primary must be certified.
  const certError = await ensureTechCertifiedForJobType(jobForSchedule.jobType, [technicianId]);
  if (certError) return { error: certError, status: 400 };

  // 2e) Customer may require first page on file before assignment
  if (jobForSchedule?.customer) {
    const cust = await Customer.findById(jobForSchedule.customer).select('firstPageRequired').lean();
    if (cust?.firstPageRequired && !Boolean(assignmentChecklist?.firstPageReceived)) {
      return {
        error:
          'This customer requires first page on file - check "First page received" on the assignment checklist before assigning.',
        status: 400,
      };
    }
  }

  // 3) Atomic: only matches if status is still CONFIRMED
  const checklist = {
    firstPageReceived: Boolean(assignmentChecklist?.firstPageReceived),
    printsDrawingsReceived: Boolean(assignmentChecklist?.printsDrawingsReceived),
    siteContactInfoReceived: Boolean(assignmentChecklist?.siteContactInfoReceived),
  };

  const normalizedAssignmentRequirements = Array.isArray(assignmentDocumentRequirements)
    ? assignmentDocumentRequirements.map((row) => ({
        key: String(row?.key || '').trim(),
        label: String(row?.label || '').trim(),
        checked: Boolean(row?.checked),
        textValue: String(row?.textValue || '').trim(),
        document: row?.document?.key
          ? {
              key: String(row.document.key).trim(),
              fileName: String(row.document.fileName || '').trim(),
              contentType: String(row.document.contentType || 'application/octet-stream').trim(),
              size: Number(row.document.size || 0),
              uploadedBy: row.document.uploadedBy || null,
              uploadedAt: row.document.uploadedAt || null,
            }
          : null,
      }))
    : [];
  const missingDoc = normalizedAssignmentRequirements.find(
    (row) => row.checked && (!row.document || !row.document.key) && !row.textValue
  );
  if (missingDoc) {
    return {
      error: `Provide document or text for "${missingDoc.label}" before assigning`,
      status: 400,
    };
  }

  const historyEntry = {
    _id: new mongoose.Types.ObjectId(),
    fromStatus: JOB_STATUS.CONFIRMED,
    toStatus: JOB_STATUS.ASSIGNED,
    changedBy: user._id,
    technician: technicianId,
    changedAt: new Date(),
    notes: notes || `Assigned to ${technician.name}`,
    assignmentChecklist: checklist,
  };

  const updated = await Job.findOneAndUpdate(
    { _id: jobId, status: JOB_STATUS.CONFIRMED },
    {
      $set: {
        status: JOB_STATUS.ASSIGNED,
        assignedTechnician: technicianId,
        secondaryAssignedTechnician: secondaryTechnicianId || null,
        assignmentChecklist: checklist,
        assignmentDocumentRequirements: normalizedAssignmentRequirements,
      },
      $push: { statusHistory: historyEntry },
    },
    { new: true }
  ).populate(POPULATE_FIELDS);

  if (!updated) {
    // Figure out why it didn't match
    const current = await Job.findById(jobId).select('status').lean();
    if (!current) return { error: 'Job not found', status: 404 };
    return {
      error: `Job must be CONFIRMED to assign. Current status: ${current.status}`,
      status: 400,
    };
  }

  return { data: updated };
}

/**
 * Update non-status fields on a job.
 */
async function updateJobDetails(jobId, data) {
  // Strip status-related fields - never allow status changes through this path
  const { status, statusHistory, assignedTechnician, createdBy, ...safeData } = data;
  if (safeData.scheduledDate !== undefined) {
    safeData.scheduledDate = normalizeDateOnly(safeData.scheduledDate);
  }
  if (safeData.jobType !== undefined) {
    safeData.jobType = typeof safeData.jobType === 'string' ? safeData.jobType.trim() : safeData.jobType;
  }

  const job = await Job.findByIdAndUpdate(jobId, safeData, {
    new: true,
    runValidators: true,
  }).populate(POPULATE_FIELDS);

  if (!job) return { error: 'Job not found', status: 404 };
  return { data: job };
}

/**
 * Revert a job's status one step backward in the pipeline.
 * Only ADMIN / OFFICE_MANAGER may do this.
 * If reverting FROM ASSIGNED, the technician assignment is also cleared.
 */
const STATUS_ORDER = [
  JOB_STATUS.TENTATIVE,
  JOB_STATUS.CONFIRMED,
  JOB_STATUS.ASSIGNED,
  JOB_STATUS.IN_PROGRESS,
  JOB_STATUS.COMPLETED,
  JOB_STATUS.BILLED,
  JOB_STATUS.PAID,
  JOB_STATUS.CLOSED,
];

async function revertStatus(jobId, user) {
  const job = await Job.findById(jobId).lean();
  if (!job) return { error: 'Job not found', status: 404 };

  const currentIdx = STATUS_ORDER.indexOf(job.status);
  if (currentIdx <= 0) {
    return { error: 'Cannot revert - job is already at the initial status', status: 400 };
  }

  const previousStatus = STATUS_ORDER[currentIdx - 1];

  const $set = { status: previousStatus };

  // Reverting FROM ASSIGNED clears the technician so it can be reassigned cleanly
  if (job.status === JOB_STATUS.ASSIGNED) {
    $set.assignedTechnician = null;
    $set.secondaryAssignedTechnician = null;
  }
  // Clear timestamp fields when stepping back past them
  if (job.status === JOB_STATUS.COMPLETED) $set.completedAt = null;
  if (job.status === JOB_STATUS.BILLED)    $set.billedAt    = null;

  const historyEntry = {
    _id: new mongoose.Types.ObjectId(),
    fromStatus: job.status,
    toStatus: previousStatus,
    changedBy: user._id,
    changedAt: new Date(),
    notes: `Status reverted from ${job.status} to ${previousStatus} by ${user.name}`,
  };

  const updated = await Job.findOneAndUpdate(
    { _id: jobId, status: job.status },
    { $set, $push: { statusHistory: historyEntry } },
    { new: true }
  ).populate(POPULATE_FIELDS);

  if (!updated) {
    const current = await Job.findById(jobId).select('status').lean();
    if (!current) return { error: 'Job not found', status: 404 };
    return {
      error: `Conflict: job status was changed by another request (current: ${current.status}). Refresh and retry.`,
      status: 409,
    };
  }

  return { data: updated, revertedFrom: job.status, revertedTo: previousStatus };
}

module.exports = {
  createJob,
  transitionStatus,
  assignTechnician,
  updateJobDetails,
  revertStatus,
  validateTransition,
  checkTechAvailability,
  ensureTechCertifiedForJobType,
  findJobTypeByName,
};
