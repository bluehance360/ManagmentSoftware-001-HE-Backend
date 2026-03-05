/**
 * JobService — hardened job lifecycle operations.
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
const TechTimeout = require('../models/TechTimeout');
const { ROLES, JOB_STATUS, STATUS_TRANSITIONS } = require('../config/constants');

/**
 * Check if a technician is unavailable on a given date.
 * Returns a reason string if unavailable, or null if available.
 */
async function checkTechAvailability(technicianId) {
  // 1) Block if the tech already has any active job (ASSIGNED or IN_PROGRESS).
  // A technician must finish their current job before being assigned a new one.
  const activeJob = await Job.findOne({
    assignedTechnician: technicianId,
    status: { $in: [JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS] },
  }).select('title status').lean();

  if (activeJob) {
    return `Already has an active job: "${activeJob.title}" (${activeJob.status})`;
  }

  // 2) Check if the tech is on time-off TODAY (the day the assignment is being made).
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const nowEnd = new Date(now);
  nowEnd.setHours(23, 59, 59, 999);

  const timeout = await TechTimeout.findOne({
    technician: technicianId,
    startDate: { $lte: nowEnd },
    endDate:   { $gte: now },
  }).lean();

  if (timeout) {
    return timeout.reason || 'Currently on time-off / leave';
  }

  return null;
}

// ── helpers ──────────────────────────────────────────────────────────

const POPULATE_FIELDS = [
  { path: 'assignedTechnician', select: 'name email' },
  { path: 'createdBy', select: 'name email' },
  { path: 'statusHistory.changedBy', select: 'name email role' },
  { path: 'statusHistory.technician', select: 'name email' },
  { path: 'documents.uploadedBy', select: 'name email role' },
  { path: 'customer', select: 'name phone email address' },
];

/**
 * Validate whether role + currentStatus → newStatus is legal.
 * Pure function — no DB calls.
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
  const jobData = {
    title: data.title,
    description: data.description,
    scheduledDate: data.scheduledDate,
    estimatedCost: data.estimatedCost,
    notes: data.notes,
    createdBy: userId,
    status: JOB_STATUS.TENTATIVE,
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

  // 3) Technician must be the one assigned
  if (user.role === ROLES.TECHNICIAN) {
    if (!job.assignedTechnician || job.assignedTechnician.toString() !== user._id.toString()) {
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

  // 5) Atomic update — status in filter prevents race condition
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
async function assignTechnician(jobId, technicianId, user, notes) {
  // 1) Verify technician exists and has correct role
  const technician = await User.findById(technicianId);
  if (!technician) return { error: 'Technician not found', status: 404 };
  if (technician.role !== ROLES.TECHNICIAN) {
    return { error: 'User is not a technician', status: 400 };
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
  const unavailReason = await checkTechAvailability(technicianId);
  if (unavailReason) {
    return {
      error: `Technician ${technician.name} is unavailable: ${unavailReason}`,
      status: 400,
    };
  }

  // 3) Atomic: only matches if status is still CONFIRMED
  const historyEntry = {
    _id: new mongoose.Types.ObjectId(),
    fromStatus: JOB_STATUS.CONFIRMED,
    toStatus: JOB_STATUS.ASSIGNED,
    changedBy: user._id,
    technician: technicianId,
    changedAt: new Date(),
    notes: notes || `Assigned to ${technician.name}`,
  };

  const updated = await Job.findOneAndUpdate(
    { _id: jobId, status: JOB_STATUS.CONFIRMED },
    {
      $set: {
        status: JOB_STATUS.ASSIGNED,
        assignedTechnician: technicianId,
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
  // Strip status-related fields — never allow status changes through this path
  const { status, statusHistory, assignedTechnician, createdBy, ...safeData } = data;

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
    return { error: 'Cannot revert — job is already at the initial status', status: 400 };
  }

  const previousStatus = STATUS_ORDER[currentIdx - 1];

  const $set = { status: previousStatus };

  // Reverting FROM ASSIGNED clears the technician so it can be reassigned cleanly
  if (job.status === JOB_STATUS.ASSIGNED) {
    $set.assignedTechnician = null;
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
};
