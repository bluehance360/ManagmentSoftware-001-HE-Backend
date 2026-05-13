const express = require('express');
const { body, param, validationResult } = require('express-validator');
const Job = require('../models/Job');
const JobType = require('../models/JobType');
const JobTypeSettings = require('../models/JobTypeSettings');
const User = require('../models/User');
const { authenticate, authorize } = require('../middleware/auth');
const { ROLES, JOB_STATUS } = require('../config/constants');
const JobService = require('../services/JobService');
const Customer = require('../models/Customer');
const TechTimeout = require('../models/TechTimeout');
const { createNotification } = require('../services/NotificationService');
const { getIO } = require('../socket');
const { normalizeDateOnly, isDateOnly, toLocalDateOnly } = require('../utils/dateOnly');
const {
  buildDocumentKey,
  getUploadUrl,
  getDownloadUrl,
  headObject,
  deleteObject,
} = require('../services/S3Service');

const router = express.Router();

function broadcastJobUpdate() {
  const io = getIO();
  if (io) io.emit('jobs:updated');
}

const TECH_VISIBLE_STATUSES = [
  JOB_STATUS.ASSIGNED,
  JOB_STATUS.IN_PROGRESS,
  JOB_STATUS.COMPLETED,
  JOB_STATUS.BILLED,
  JOB_STATUS.PAID,
  JOB_STATUS.CLOSED,
];

const PROGRAMMING_SUBTYPES = ['New Start-Up', 'Existing Start-Up'];
const EMPTY_PROGRAMMING_REQUIREMENT_DEFAULTS = {
  newStartup: [],
  existingStartup: [],
};

function normalizeJobType(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizeProgrammingSubtype(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function sanitizeDocumentRequirements(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      const label =
        typeof item === 'string'
          ? item.trim()
          : typeof item?.label === 'string'
            ? item.label.trim()
            : '';
      return label ? { label } : null;
    })
    .filter(Boolean)
    .slice(0, 30);
}

function toRequirementKey(label, fallbackIndex = 0) {
  const normalized = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `requirement-${fallbackIndex + 1}`;
}

function sanitizeProgrammingRequirements(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    newStartup: sanitizeDocumentRequirements(source.newStartup),
    existingStartup: sanitizeDocumentRequirements(source.existingStartup),
  };
}

async function getProgrammingRequirementDefaults() {
  const settings = await JobTypeSettings.findOne({ key: 'global' })
    .select('programmingDocumentRequirements')
    .lean();
  return sanitizeProgrammingRequirements(
    settings?.programmingDocumentRequirements || EMPTY_PROGRAMMING_REQUIREMENT_DEFAULTS
  );
}

function resolveJobTypeDocumentRequirements(type, programmingSubtype, programmingDefaults) {
  if (!type) return [];
  const generalRows = sanitizeDocumentRequirements(type.documentRequirements);
  if (!type.isProgramming) {
    return generalRows;
  }

  const isExisting = normalizeProgrammingSubtype(programmingSubtype) === 'Existing Start-Up';
  const override = sanitizeProgrammingRequirements(type.programmingDocumentRequirements);
  const overrideRows = isExisting ? override.existingStartup : override.newStartup;
  const defaultRows = isExisting
    ? programmingDefaults.existingStartup
    : programmingDefaults.newStartup;
  const subtypeRows = overrideRows.length ? overrideRows : defaultRows;
  return [...generalRows, ...subtypeRows];
}

function buildAssignmentRequirementRows(requirements, previousRows = []) {
  const previousByKey = new Map(
    (Array.isArray(previousRows) ? previousRows : [])
      .filter((row) => row && row.key && row.label)
      .map((row) => [String(row.key), row])
  );

  return sanitizeDocumentRequirements(requirements).map((row, index) => {
    const key = toRequirementKey(row.label, index);
    const previous = previousByKey.get(key);
    return {
      key,
      label: row.label,
      checked: Boolean(previous?.checked),
      textValue: String(previous?.textValue || '').trim(),
      document: previous?.document?.key
        ? {
            key: previous.document.key,
            fileName: previous.document.fileName || '',
            contentType: previous.document.contentType || 'application/octet-stream',
            size: Number(previous.document.size || 0),
            uploadedBy: previous.document.uploadedBy || null,
            uploadedAt: previous.document.uploadedAt || null,
          }
        : null,
    };
  });
}

async function resolveAssignmentRequirementsForJob(jobDoc) {
  const normalizedJobType = normalizeJobType(jobDoc?.jobType).toLowerCase();
  if (!normalizedJobType) return [];
  const type = await JobType.findOne({ normalizedName: normalizedJobType }).lean();
  if (!type) return [];
  const defaults = await getProgrammingRequirementDefaults();
  const resolved = resolveJobTypeDocumentRequirements(type, jobDoc?.programmingSubtype, defaults);
  return buildAssignmentRequirementRows(resolved, jobDoc?.assignmentDocumentRequirements || []);
}

/** Resolve whether the named job type is a programming type (from DB). */
async function jobTypeIsProgramming(jobTypeName) {
  const normalized = normalizeJobType(jobTypeName).toLowerCase();
  if (!normalized) return false;
  const doc = await JobType.findOne({ normalizedName: normalized }).select('isProgramming').lean();
  return Boolean(doc?.isProgramming);
}

async function ensureJobTypeSaved(name, opts = {}) {
  const normalizedName = normalizeJobType(name);
  if (!normalizedName) return null;

  const {
    certificationRequired,
    isProgramming,
    documentRequirements,
    programmingDocumentRequirements,
  } = opts;

  const setOnInsert = {
    name: normalizedName,
    normalizedName: normalizedName.toLowerCase(),
  };
  if (typeof certificationRequired === 'boolean') {
    setOnInsert.certificationRequired = certificationRequired;
  }
  if (typeof isProgramming === 'boolean') {
    setOnInsert.isProgramming = isProgramming;
  }
  if (documentRequirements !== undefined) {
    setOnInsert.documentRequirements = sanitizeDocumentRequirements(documentRequirements);
  }
  if (programmingDocumentRequirements !== undefined) {
    setOnInsert.programmingDocumentRequirements = sanitizeProgrammingRequirements(
      programmingDocumentRequirements
    );
  }

  return JobType.findOneAndUpdate(
    { normalizedName: normalizedName.toLowerCase() },
    { $setOnInsert: setOnInsert },
    { upsert: true, new: true }
  );
}

async function getJobTypeUsageMap() {
  const usage = await Job.aggregate([
    { $match: { jobType: { $exists: true, $ne: '' } } },
    {
      $group: {
        _id: { $toLower: '$jobType' },
        usageCount: { $sum: 1 },
        jobTitles: { $addToSet: '$title' },
      },
    },
  ]);

  const map = new Map();
  usage.forEach((item) => {
    map.set(item._id, {
      usageCount: item.usageCount,
      jobTitles: item.jobTitles || [],
    });
  });
  return map;
}

async function listJobTypesWithUsage() {
  const usageMap = await getJobTypeUsageMap();
  const types = await JobType.find({}).sort({ name: 1 }).lean();
  return types.map((type) => ({
    _id: type._id,
    name: type.name,
    certificationRequired: Boolean(type.certificationRequired),
    isProgramming: Boolean(type.isProgramming),
    documentRequirements: Array.isArray(type.documentRequirements) ? type.documentRequirements : [],
    programmingDocumentRequirements: sanitizeProgrammingRequirements(type.programmingDocumentRequirements),
    usageCount: usageMap.get(type.normalizedName)?.usageCount || 0,
    jobTitles: usageMap.get(type.normalizedName)?.jobTitles || [],
  }));
}

function canAccessJob(user, job) {
  if (!job) return false;
  if ([ROLES.ADMIN, ROLES.OFFICE_MANAGER].includes(user.role)) return true;
  if (user.role !== ROLES.TECHNICIAN) return false;
  if (!TECH_VISIBLE_STATUSES.includes(job.status)) return false;
  const primaryTechId = job.assignedTechnician?._id || job.assignedTechnician;
  const secondaryTechId = job.secondaryAssignedTechnician?._id || job.secondaryAssignedTechnician;
  const userId = user._id.toString();
  return primaryTechId?.toString() === userId || secondaryTechId?.toString() === userId;
}

function normalizeDocNote(note) {
  return typeof note === 'string' ? note.trim() : '';
}

function validateScheduledDate(value) {
  const normalized = normalizeDateOnly(value);
  if (!isDateOnly(normalized)) {
    throw new Error('Invalid date format. Use YYYY-MM-DD');
  }
  if (normalized < toLocalDateOnly()) {
    throw new Error('Scheduled date cannot be in the past');
  }
  return true;
}

function formatRoleLabel(role) {
  if (!role) return 'User';
  if (role === ROLES.OFFICE_MANAGER) return 'Office Manager';
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
}

function actorWithRole(user) {
  return `${user.name} (${formatRoleLabel(user.role)})`;
}

function notifyAssignmentDocumentChange({ job, documentFieldName, action, actorUser }) {
  if (!job || !documentFieldName || !action || !actorUser) return;
  const recipientIds = [];
  if (job.assignedTechnician) recipientIds.push(job.assignedTechnician);
  if (job.secondaryAssignedTechnician) recipientIds.push(job.secondaryAssignedTechnician);

  createNotification({
    type: 'JOB_DOCUMENTS_UPDATED',
    message: `Job "${job.title || 'Untitled'}": ${documentFieldName} is ${action} by ${actorWithRole(actorUser)}.`,
    jobId: job._id,
    recipientIds,
    recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
    excludeUserId: actorUser._id,
  });
}

function notifyAssignmentChecklistUpdated({ job, summaryLines, actorUser }) {
  if (!job || !actorUser) return;
  const recipientIds = [];
  if (job.assignedTechnician) recipientIds.push(job.assignedTechnician);
  if (job.secondaryAssignedTechnician) recipientIds.push(job.secondaryAssignedTechnician);
  const detail = summaryLines?.length ? summaryLines.join('; ') : 'checklist updated';
  createNotification({
    type: 'JOB_UPDATED',
    message: `Job "${job.title || 'Untitled'}": Assignment checklist updated (${detail}) by ${actorWithRole(actorUser)}.`,
    jobId: job._id,
    recipientIds,
    recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
    excludeUserId: actorUser._id,
  });
}

/** Compare saved rows to merged rows; notify when requirement text (textValue) changed. */
function collectAssignmentRequirementTextNoteChanges(beforeRows, afterRows) {
  const beforeByKey = new Map(
    (Array.isArray(beforeRows) ? beforeRows : [])
      .filter((row) => row && row.key)
      .map((row) => [String(row.key), String(row.textValue || '').trim()])
  );
  const entries = [];
  for (const row of Array.isArray(afterRows) ? afterRows : []) {
    if (!row?.key) continue;
    const key = String(row.key);
    const prevText = beforeByKey.has(key) ? beforeByKey.get(key) : '';
    const nextText = String(row.textValue || '').trim();
    if (prevText === nextText) continue;
    const label = String(row.label || key).trim() || key;
    let summary = 'text note updated';
    if (!prevText && nextText) summary = 'text note added';
    else if (prevText && !nextText) summary = 'text note removed';
    entries.push({ label, summary });
  }
  return entries;
}

function notifyAssignmentRequirementNoteChanges({ job, entries, actorUser }) {
  if (!job || !actorUser || !entries?.length) return;
  const recipientIds = [];
  if (job.assignedTechnician) recipientIds.push(job.assignedTechnician);
  if (job.secondaryAssignedTechnician) recipientIds.push(job.secondaryAssignedTechnician);
  const detail = entries.map((e) => `"${e.label}" — ${e.summary}`).join('; ');
  createNotification({
    type: 'JOB_DOCUMENTS_UPDATED',
    message: `Job "${job.title || 'Untitled'}": ${detail} by ${actorWithRole(actorUser)}.`,
    jobId: job._id,
    recipientIds,
    recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
    excludeUserId: actorUser._id,
  });
}

router.use(authenticate);

// ── GET /api/jobs ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, assignedTechnician, jobType, page = 1, limit = 20 } = req.query;
    const filter = {};

    if (req.user.role === ROLES.TECHNICIAN) {
      filter.$or = [
        { assignedTechnician: req.user._id },
        { secondaryAssignedTechnician: req.user._id },
      ];
      // Technicians see all assigned jobs immediately
      const techVisibleStatuses = [
        JOB_STATUS.ASSIGNED,
        JOB_STATUS.IN_PROGRESS,
        JOB_STATUS.COMPLETED,
        JOB_STATUS.BILLED,
        JOB_STATUS.PAID,
        JOB_STATUS.CLOSED,
      ];
      filter.status = status
        ? (techVisibleStatuses.includes(status) ? status : '__none__')
        : { $in: techVisibleStatuses };
    } else if (req.user.role === ROLES.OFFICE_MANAGER) {
      // Managers see everything including TENTATIVE
      const managerVisibleStatuses = [
        JOB_STATUS.TENTATIVE,
        JOB_STATUS.CONFIRMED,
        JOB_STATUS.ASSIGNED,
        JOB_STATUS.IN_PROGRESS,
        JOB_STATUS.COMPLETED,
        JOB_STATUS.BILLED,
        JOB_STATUS.PAID,
        JOB_STATUS.CLOSED,
      ];
      filter.status = status
        ? (managerVisibleStatuses.includes(status) ? status : '__none__')
        : { $in: managerVisibleStatuses };
    } else {
      // ADMIN sees everything
      if (status) filter.status = status;
    }
    if (assignedTechnician && req.user.role !== ROLES.TECHNICIAN) {
      filter.assignedTechnician = assignedTechnician;
    }
    if (jobType) {
      filter.jobType = normalizeJobType(jobType);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [jobs, total] = await Promise.all([
      Job.find(filter)
        .populate('assignedTechnician', 'name email')
        .populate('secondaryAssignedTechnician', 'name email')
        .populate('createdBy', 'name email')
        .populate('customer', 'name phone email address firstPageRequired')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Job.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: jobs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /api/jobs/job-types ─────────────────────────────────────────
router.get('/job-types', async (req, res) => {
  try {
    const [jobTypes, programmingRequirementDefaults] = await Promise.all([
      listJobTypesWithUsage(),
      getProgrammingRequirementDefaults(),
    ]);
    res.json({ success: true, data: jobTypes, programmingRequirementDefaults });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch(
  '/job-types/programming-defaults',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('newStartup').optional().isArray().withMessage('newStartup must be an array'),
    body('existingStartup').optional().isArray().withMessage('existingStartup must be an array'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    try {
      const programmingDocumentRequirements = sanitizeProgrammingRequirements(req.body);
      await JobTypeSettings.findOneAndUpdate(
        { key: 'global' },
        { $set: { key: 'global', programmingDocumentRequirements } },
        { upsert: true, new: true }
      );
      const jobTypes = await listJobTypesWithUsage();
      return res.json({ success: true, data: { jobTypes, programmingRequirementDefaults: programmingDocumentRequirements } });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/jobs/job-types (ADMIN, OFFICE_MANAGER) ───────────────
router.post(
  '/job-types',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('name').notEmpty().withMessage('Job type name is required').isString().withMessage('Job type name must be a string'),
    body('certificationRequired').optional().isBoolean().withMessage('certificationRequired must be true or false'),
    body('isProgramming').optional().isBoolean().withMessage('isProgramming must be true or false'),
    body('documentRequirements').optional().isArray().withMessage('documentRequirements must be an array'),
    body('programmingDocumentRequirements').optional().isObject().withMessage('programmingDocumentRequirements must be an object'),
    body('programmingDocumentRequirements.newStartup').optional().isArray().withMessage('newStartup must be an array'),
    body('programmingDocumentRequirements.existingStartup').optional().isArray().withMessage('existingStartup must be an array'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const normalizedName = normalizeJobType(req.body.name);
      if (!normalizedName) {
        return res.status(400).json({ success: false, error: 'Job type name is required' });
      }

      const defaults = await getProgrammingRequirementDefaults();
      const isProgramming = Boolean(req.body.isProgramming);
      await ensureJobTypeSaved(normalizedName, {
        certificationRequired: Boolean(req.body.certificationRequired),
        isProgramming,
        documentRequirements: sanitizeDocumentRequirements(req.body.documentRequirements),
        programmingDocumentRequirements: isProgramming
          ? sanitizeProgrammingRequirements(
              req.body.programmingDocumentRequirements || defaults
            )
          : sanitizeProgrammingRequirements(req.body.programmingDocumentRequirements),
      });
      const jobTypes = await listJobTypesWithUsage();
      const created = jobTypes.find((item) => item.name.toLowerCase() === normalizedName.toLowerCase());

      res.status(201).json({ success: true, data: { jobType: created, jobTypes } });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/jobs/job-types/:id (ADMIN, OFFICE_MANAGER) ───────────
router.patch(
  '/job-types/:id',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    param('id').isMongoId().withMessage('Invalid job type ID'),
    body('certificationRequired').optional().isBoolean().withMessage('certificationRequired must be true or false'),
    body('isProgramming').optional().isBoolean().withMessage('isProgramming must be true or false'),
    body('documentRequirements').optional().isArray().withMessage('documentRequirements must be an array'),
    body('programmingDocumentRequirements').optional().isObject().withMessage('programmingDocumentRequirements must be an object'),
    body('programmingDocumentRequirements.newStartup').optional().isArray().withMessage('newStartup must be an array'),
    body('programmingDocumentRequirements.existingStartup').optional().isArray().withMessage('existingStartup must be an array'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const type = await JobType.findById(req.params.id);
      if (!type) {
        return res.status(404).json({ success: false, error: 'Job type not found' });
      }

      const $set = {};
      if (req.body.certificationRequired !== undefined) {
        $set.certificationRequired = Boolean(req.body.certificationRequired);
      }
      if (req.body.isProgramming !== undefined) {
        $set.isProgramming = Boolean(req.body.isProgramming);
      }
      if (req.body.documentRequirements !== undefined) {
        $set.documentRequirements = sanitizeDocumentRequirements(req.body.documentRequirements);
      }
      if (req.body.programmingDocumentRequirements !== undefined) {
        $set.programmingDocumentRequirements = sanitizeProgrammingRequirements(
          req.body.programmingDocumentRequirements
        );
      } else if (req.body.isProgramming === true && !type.isProgramming) {
        $set.programmingDocumentRequirements = await getProgrammingRequirementDefaults();
      }

      if (Object.keys($set).length === 0) {
        const jobTypes = await listJobTypesWithUsage();
        const unchanged = jobTypes.find((t) => t._id.toString() === req.params.id);
        return res.json({ success: true, data: { jobType: unchanged, jobTypes } });
      }

      await JobType.findByIdAndUpdate(req.params.id, { $set });
      const jobTypes = await listJobTypesWithUsage();
      const updated = jobTypes.find((t) => t._id.toString() === req.params.id);

      broadcastJobUpdate();
      res.json({ success: true, data: { jobType: updated, jobTypes } });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── DELETE /api/jobs/job-types/:id (ADMIN, OFFICE_MANAGER) ─────────
router.delete(
  '/job-types/:id',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [param('id').isMongoId().withMessage('Invalid job type ID')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const type = await JobType.findById(req.params.id).lean();
      if (!type) {
        return res.status(404).json({ success: false, error: 'Job type not found' });
      }

      const usageCount = await Job.countDocuments({
        $expr: {
          $eq: [{ $toLower: '$jobType' }, type.normalizedName],
        },
      });
      await JobType.findByIdAndDelete(req.params.id);

      const jobTypes = await listJobTypesWithUsage();
      res.json({
        success: true,
        data: {
          deleted: { _id: type._id, name: type.name, usageCount },
          jobTypes,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── GET /api/jobs/:id ────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .populate('assignedTechnician', 'name email certificates')
      .populate('secondaryAssignedTechnician', 'name email certificates')
      .populate('createdBy', 'name email')
      .populate('customer', 'name phone email address firstPageRequired')
      .populate('statusHistory.changedBy', 'name email role')
      .populate('statusHistory.technician', 'name email')
      .populate('documents.uploadedBy', 'name email role');

    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    // TENTATIVE jobs are visible to ADMIN and OFFICE_MANAGER
    if (job.status === JOB_STATUS.TENTATIVE && ![ROLES.ADMIN, ROLES.OFFICE_MANAGER].includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Not authorized to view this job' });
    }

    // Technicians can only see ASSIGNED+ jobs
    if (req.user.role === ROLES.TECHNICIAN) {
      const techVisibleStatuses = [
        JOB_STATUS.ASSIGNED,
        JOB_STATUS.IN_PROGRESS,
        JOB_STATUS.COMPLETED,
        JOB_STATUS.BILLED,
        JOB_STATUS.PAID,
        JOB_STATUS.CLOSED,
      ];
      if (!techVisibleStatuses.includes(job.status)) {
        return res.status(403).json({ success: false, error: 'Not authorized to view this job' });
      }
      const primaryTechId = job.assignedTechnician?._id?.toString();
      const secondaryTechId = job.secondaryAssignedTechnician?._id?.toString();
      if (primaryTechId !== req.user._id.toString() && secondaryTechId !== req.user._id.toString()) {
        return res.status(403).json({ success: false, error: 'Not authorized to view this job' });
      }
    }

    const resolvedRequirements = await resolveAssignmentRequirementsForJob(job);
    if (resolvedRequirements.length > 0) {
      job.assignmentDocumentRequirements = resolvedRequirements;
    }

    res.json({ success: true, data: job });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /api/jobs (ADMIN, OFFICE_MANAGER) ──────────────────────────
router.post(
  '/',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('title').notEmpty().withMessage('Job title is required'),
    body('customerId').notEmpty().withMessage('Customer is required').isMongoId().withMessage('Invalid customer ID'),
    body('jobType').notEmpty().withMessage('Job type is required').isString().withMessage('Job type must be a string'),
    body('programmingSubtype').optional().isString().withMessage('Programming subtype must be a string'),
    body('scheduledDate').notEmpty().withMessage('Scheduled date is required').custom(validateScheduledDate),
    body('estimatedCost').optional().isFloat({ min: 0 }).withMessage('Must be a positive number'),
    body('companyName').optional().trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      // Verify customer exists
      const customer = await Customer.findById(req.body.customerId);
      if (!customer) {
        return res.status(404).json({ success: false, error: 'Customer not found' });
      }

      req.body.jobType = normalizeJobType(req.body.jobType);
      if (!req.body.jobType) {
        return res.status(400).json({ success: false, error: 'Job type is required' });
      }
      req.body.programmingSubtype = normalizeProgrammingSubtype(req.body.programmingSubtype);
      if (await jobTypeIsProgramming(req.body.jobType)) {
        if (!req.body.programmingSubtype) {
          return res.status(400).json({
            success: false,
            error: 'Programming subtype is required for selected job type',
          });
        }
        if (!PROGRAMMING_SUBTYPES.includes(req.body.programmingSubtype)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid programming subtype',
          });
        }
      } else {
        req.body.programmingSubtype = undefined;
      }
      await ensureJobTypeSaved(req.body.jobType);

      const job = await JobService.createJob(req.body, req.user._id);

      // Notify admins and managers
      createNotification({
        type: 'JOB_CREATED',
        message: `New job created by ${actorWithRole(req.user)}: "${job.title}" for ${customer.name}`,
        jobId: job._id,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      res.status(201).json({ success: true, data: job });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/jobs/:id/documents/presign ───────────────────────────
router.post(
  '/:id/documents/presign',
  [
    body('files').isArray({ min: 1 }).withMessage('files must be a non-empty array'),
    body('files.*.name').notEmpty().withMessage('file name is required'),
    body('files.*.contentType').optional().isString(),
    body('files.*.size').optional().isInt({ min: 0 }).withMessage('file size must be >= 0'),
    body('files.*.note').optional().isString().withMessage('file note must be a string'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const job = await Job.findById(req.params.id).select('_id title status assignedTechnician secondaryAssignedTechnician');
      if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to upload documents for this job' });
      }

      const files = req.body.files.slice(0, 10);

      const ALLOWED_EXT = new Set(['pdf', 'doc', 'docx', 'txt', 'xml']);
      const invalid = files.find((f) => {
        const ext = (f.name || '').split('.').pop().toLowerCase();
        return !ALLOWED_EXT.has(ext);
      });
      if (invalid) {
        return res.status(400).json({
          success: false,
          error: `File type not allowed: "${invalid.name}". Accepted: PDF, DOC, DOCX, TXT, XML`,
        });
      }

      const uploads = await Promise.all(
        files.map(async (file) => {
          const key = buildDocumentKey(job._id.toString(), file.name);
          const contentType = file.contentType || 'application/octet-stream';
          const presignedUrl = await getUploadUrl({ key, contentType, expiresIn: 300 });
          return {
            key,
            fileName: file.name,
            contentType,
            size: Number(file.size) || 0,
            note: normalizeDocNote(file.note),
            presignedUrl,
            expiresIn: 300,
          };
        })
      );

      res.json({ success: true, data: { uploads } });
    } catch (error) {
      const status = error.status || 500;
      res.status(status).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/jobs/:id/documents/complete ──────────────────────────
router.post(
  '/:id/documents/complete',
  [
    body('documents').isArray({ min: 1 }).withMessage('documents must be a non-empty array'),
    body('documents.*.key').notEmpty().withMessage('document key is required'),
    body('documents.*.fileName').notEmpty().withMessage('document fileName is required'),
    body('documents.*.note').optional().isString().withMessage('document note must be a string'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const job = await Job.findById(req.params.id)
        .select('_id title status assignedTechnician secondaryAssignedTechnician documents')
        .populate('assignedTechnician', 'name email');

      if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to add documents for this job' });
      }

      const incoming = req.body.documents.slice(0, 10);
      const createdDocs = [];

      for (const item of incoming) {
        if (!item.key.startsWith(`jobs/${job._id}/documents/`)) {
          return res.status(400).json({ success: false, error: 'Invalid document key for this job' });
        }

        const meta = await headObject(item.key);
        createdDocs.push({
          key: item.key,
          fileName: item.fileName,
          contentType: meta.ContentType || 'application/octet-stream',
          size: Number(meta.ContentLength) || 0,
          note: normalizeDocNote(item.note),
          uploadedBy: req.user._id,
          uploadedAt: new Date(),
        });
      }

      job.documents.push(...createdDocs);
      await job.save();
      await job.populate('documents.uploadedBy', 'name email role');

      const latest = job.documents.slice(-createdDocs.length);
      const firstFile = latest[0]?.fileName || 'document';
      const message = latest.length === 1
        ? `${actorWithRole(req.user)} uploaded "${firstFile}" to job "${job.title}"`
        : `${actorWithRole(req.user)} uploaded ${latest.length} documents to job "${job.title}"`;

      const recipientIds = [];
      if (job.assignedTechnician?._id) recipientIds.push(job.assignedTechnician._id);
      if (job.secondaryAssignedTechnician) recipientIds.push(job.secondaryAssignedTechnician);

      createNotification({
        type: 'JOB_DOCUMENT_UPLOADED',
        message,
        jobId: job._id,
        recipientIds,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      res.json({ success: true, data: { documents: latest } });
    } catch (error) {
      const status = error.status || 500;
      res.status(status).json({ success: false, error: error.message });
    }
  }
);

// ── GET /api/jobs/:id/documents/:docId/url ─────────────────────────
router.get('/:id/documents/:docId/url', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .select('_id status assignedTechnician secondaryAssignedTechnician documents');

    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    if (!canAccessJob(req.user, job)) {
      return res.status(403).json({ success: false, error: 'Not authorized to view documents for this job' });
    }

    const doc = job.documents.id(req.params.docId);
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });

    const url = await getDownloadUrl({
      key: doc.key,
      fileName: doc.fileName,
      expiresIn: 900,
    });

    res.json({
      success: true,
      data: {
        url,
        fileName: doc.fileName,
        contentType: doc.contentType,
      },
    });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// ── DELETE /api/jobs/:id/documents/:docId ───────────────────────────
router.delete('/:id/documents/:docId', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .select('_id title status assignedTechnician secondaryAssignedTechnician documents')
      .populate('assignedTechnician', 'name email');

    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    if (!canAccessJob(req.user, job)) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const doc = job.documents.id(req.params.docId);
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });

    // Only the uploader can delete their own documents
    if (doc.uploadedBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, error: 'You can only delete documents you uploaded' });
    }

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    const fileName = doc.fileName;

    // Delete from S3 (fire-and-forget, doc is removed from DB regardless)
    try { await deleteObject(doc.key); } catch { /* ignore S3 errors */ }

    // Remove from DB
    job.documents.pull(req.params.docId);
    await job.save();

    // Notify admins/managers + assigned tech
    const recipientIds = [];
    if (job.assignedTechnician?._id) recipientIds.push(job.assignedTechnician._id);
    if (job.secondaryAssignedTechnician) recipientIds.push(job.secondaryAssignedTechnician);

    let message = `${actorWithRole(req.user)} deleted "${fileName}" from job "${job.title}"`;
    if (reason) message += ` — Reason: ${reason}`;

    createNotification({
      type: 'JOB_DOCUMENT_DELETED',
      message,
      jobId: job._id,
      recipientIds,
      recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
      excludeUserId: req.user._id,
    });

    broadcastJobUpdate();
    res.json({ success: true });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// ── PATCH /api/jobs/:id/status ──────────────────────────────────────
router.patch(
  '/:id/status',
  [
    body('status')
      .isIn(Object.values(JOB_STATUS))
      .withMessage(`Status must be one of: ${Object.values(JOB_STATUS).join(', ')}`),
    body('notes').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const result = await JobService.transitionStatus(
        req.params.id,
        req.body.status,
        req.user,
        req.body.notes
      );

      if (result.error) {
        return res.status(result.status).json({ success: false, error: result.error });
      }

      // Build notification recipients based on new status
      const job = result.data;
      const notifRecipientIds = [];
      const notifRoles = [];
      const STATUS_MESSAGES = {
        CONFIRMED:   `Job "${job.title}" has been confirmed`,
        ASSIGNED:    `Job "${job.title}" has been assigned`,
        IN_PROGRESS: `Job "${job.title}" is now in progress`,
        COMPLETED:   `Job "${job.title}" has been completed`,
        BILLED:      `Job "${job.title}" has been billed`,
        PAID:        `Job "${job.title}" has been marked as paid`,
        CLOSED:      `Job "${job.title}" has been closed`,
      };

      // Notify the relevant people
      if ([JOB_STATUS.IN_PROGRESS, JOB_STATUS.COMPLETED].includes(req.body.status)) {
        const actorIsAdmin = [ROLES.ADMIN, ROLES.OFFICE_MANAGER].includes(req.user.role);
        const statusLabel  = req.body.status === JOB_STATUS.IN_PROGRESS ? 'In Progress' : 'Completed';
        const techName     = job.assignedTechnician?.name;

        if (actorIsAdmin && techName) {
     
          STATUS_MESSAGES[req.body.status] =
            `"${job.title}" marked as ${statusLabel} on behalf of ${techName}`;
          // Notify the assigned tech
          if (job.assignedTechnician?._id) notifRecipientIds.push(job.assignedTechnician._id);
          if (job.secondaryAssignedTechnician?._id) notifRecipientIds.push(job.secondaryAssignedTechnician._id);
        }
        // Notify admins and managers
        notifRoles.push(ROLES.ADMIN, ROLES.OFFICE_MANAGER);
      }
      if ([JOB_STATUS.BILLED, JOB_STATUS.PAID, JOB_STATUS.CLOSED].includes(req.body.status)) {
        notifRoles.push(ROLES.ADMIN, ROLES.OFFICE_MANAGER);
        // Technicians are NOT notified for PAID / CLOSED — those statuses are hidden from them
      }
      if (req.body.status === JOB_STATUS.CONFIRMED) {
        notifRoles.push(ROLES.ADMIN, ROLES.OFFICE_MANAGER);
      }

      createNotification({
        type: `JOB_${req.body.status === 'IN_PROGRESS' ? 'STARTED' : req.body.status}`,
        message: `${STATUS_MESSAGES[req.body.status] || `Job "${job.title}" status updated`} by ${actorWithRole(req.user)}`,
        jobId: job._id,
        recipientIds: notifRecipientIds,
        recipientRoles: notifRoles,
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      res.json({ success: true, data: result.data, message: `Status updated to ${req.body.status}` });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/jobs/:id/assign (ADMIN, OFFICE_MANAGER) ──────────────
router.patch(
  '/:id/assign',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('technicianId').isMongoId().withMessage('Valid technician ID required'),
    body('secondaryTechnicianId').optional({ values: 'falsy' }).isMongoId().withMessage('Valid secondary technician ID required'),
    body('notes').optional().isString(),
    body('assignmentChecklist').optional().isObject().withMessage('Assignment checklist must be an object'),
    body('assignmentChecklist.firstPageReceived').optional().isBoolean().withMessage('firstPageReceived must be true or false'),
    body('assignmentChecklist.printsDrawingsReceived').optional().isBoolean().withMessage('printsDrawingsReceived must be true or false'),
    body('assignmentChecklist.siteContactInfoReceived').optional().isBoolean().withMessage('siteContactInfoReceived must be true or false'),
    body('assignmentDocumentRequirements').optional().isArray().withMessage('assignmentDocumentRequirements must be an array'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const result = await JobService.assignTechnician(
        req.params.id,
        req.body.technicianId,
        req.user,
        req.body.notes,
        req.body.assignmentChecklist,
        req.body.secondaryTechnicianId || null,
        req.body.assignmentDocumentRequirements || []
      );

      if (result.error) {
        return res.status(result.status).json({ success: false, error: result.error });
      }

      // Notify the assigned technician immediately when assigned
      const assignedJob = result.data;
      createNotification({
        type: 'JOB_ASSIGNED',
        message: `Job "${assignedJob.title}" has been assigned to you by ${actorWithRole(req.user)}. Instructions: ${req.body.notes}`,
        jobId: assignedJob._id,
        recipientIds: [req.body.technicianId],
        excludeUserId: req.user._id,
      });
      if (req.body.secondaryTechnicianId) {
        createNotification({
          type: 'JOB_ASSIGNED',
          message: `Job "${assignedJob.title}" has been assigned to you as Secondary Technician by ${actorWithRole(req.user)}. Instructions: ${req.body.notes}`,
          jobId: assignedJob._id,
          recipientIds: [req.body.secondaryTechnicianId],
          excludeUserId: req.user._id,
        });
      }
      // Also notify admins and managers
      createNotification({
        type: 'JOB_ASSIGNED',
        message: `Job "${assignedJob.title}" has been assigned to ${assignedJob.assignedTechnician?.name || 'a technician'}${assignedJob.secondaryAssignedTechnician?.name ? ` and ${assignedJob.secondaryAssignedTechnician.name}` : ''} by ${actorWithRole(req.user)}`,
        jobId: assignedJob._id,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      res.json({ success: true, data: result.data, message: 'Technician assigned' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/jobs/:id/assignment-document-requirements ────────────
router.patch(
  '/:id/assignment-document-requirements',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [body('requirements').isArray().withMessage('requirements must be an array')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    try {
      const job = await Job.findById(req.params.id);
      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to update this job' });
      }

      const previousRows = Array.isArray(job.assignmentDocumentRequirements)
        ? job.assignmentDocumentRequirements.map((row) =>
            row?.toObject ? row.toObject() : { ...row }
          )
        : [];

      const merged = buildAssignmentRequirementRows(
        req.body.requirements.map((row) => ({ label: row?.label || '' })),
        req.body.requirements.map((row, idx) => ({
          key: row?.key || toRequirementKey(row?.label || '', idx),
          label: String(row?.label || '').trim(),
          checked: Boolean(row?.checked),
          textValue: String(row?.textValue || '').trim(),
          document: row?.document?.key
            ? {
                key: row.document.key,
                fileName: row.document.fileName || '',
                contentType: row.document.contentType || 'application/octet-stream',
                size: Number(row.document.size || 0),
                uploadedBy: row.document.uploadedBy || null,
                uploadedAt: row.document.uploadedAt || null,
              }
            : null,
        }))
      );

      const textNoteChanges = collectAssignmentRequirementTextNoteChanges(previousRows, merged);

      job.assignmentDocumentRequirements = merged;
      if (textNoteChanges.length) {
        const historyLine = textNoteChanges
          .map((e) => `"${e.label}" (${e.summary})`)
          .join('; ');
        job.statusHistory.push({
          fromStatus: job.status,
          toStatus: job.status,
          changedBy: req.user._id,
          changedAt: new Date(),
          notes: `Requirement notes updated by ${actorWithRole(req.user)}: ${historyLine}.`,
        });
        notifyAssignmentRequirementNoteChanges({
          job,
          entries: textNoteChanges,
          actorUser: req.user,
        });
      }
      await job.save();
      await job.populate('documents.uploadedBy', 'name email role');
      broadcastJobUpdate();
      return res.json({ success: true, data: job, message: 'Assignment document requirements updated' });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/jobs/:id/assignment-documents/presign ─────────────────
router.post(
  '/:id/assignment-documents/presign',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('requirementKey').isString().withMessage('requirementKey is required'),
    body('fileName').isString().withMessage('fileName is required'),
    body('contentType').optional().isString(),
    body('size').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    try {
      const job = await Job.findById(req.params.id).select('_id assignmentDocumentRequirements');
      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to update this job' });
      }

      const requirement = (job.assignmentDocumentRequirements || []).find(
        (row) => row?.key === req.body.requirementKey
      );
      if (!requirement) {
        return res.status(400).json({ success: false, error: 'Invalid requirement key' });
      }

      const key = buildDocumentKey(job._id.toString(), req.body.fileName);
      const presignedUrl = await getUploadUrl({
        key,
        contentType: req.body.contentType || 'application/octet-stream',
        expiresIn: 300,
      });

      return res.json({
        success: true,
        data: {
          requirementKey: req.body.requirementKey,
          key,
          fileName: req.body.fileName,
          contentType: req.body.contentType || 'application/octet-stream',
          size: Number(req.body.size || 0),
          presignedUrl,
          expiresIn: 300,
        },
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/jobs/:id/assignment-documents/complete ────────────────
router.post(
  '/:id/assignment-documents/complete',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('requirementKey').isString().withMessage('requirementKey is required'),
    body('key').isString().withMessage('key is required'),
    body('fileName').isString().withMessage('fileName is required'),
    body('contentType').optional().isString(),
    body('size').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    try {
      const head = await headObject(req.body.key);
      if (!head) {
        return res.status(400).json({ success: false, error: 'Uploaded file not found in storage' });
      }

      const job = await Job.findById(req.params.id);
      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to update this job' });
      }

      const rows = Array.isArray(job.assignmentDocumentRequirements)
        ? [...job.assignmentDocumentRequirements]
        : [];
      const rowIndex = rows.findIndex((row) => row?.key === req.body.requirementKey);
      if (rowIndex === -1) {
        return res.status(400).json({ success: false, error: 'Invalid requirement key' });
      }

      const currentRow = rows[rowIndex]?.toObject ? rows[rowIndex].toObject() : rows[rowIndex];
      const previousKey = currentRow?.document?.key;
      rows[rowIndex] = {
        ...currentRow,
        checked: true,
        document: {
          key: req.body.key,
          fileName: req.body.fileName,
          contentType: req.body.contentType || head.ContentType || 'application/octet-stream',
          size: Number(req.body.size || head.ContentLength || 0),
          uploadedBy: req.user._id,
          uploadedAt: new Date(),
        },
      };
      job.assignmentDocumentRequirements = rows;
      const changedFieldName = currentRow?.label || req.body.fileName || 'Document';
      job.statusHistory.push({
        fromStatus: job.status,
        toStatus: job.status,
        changedBy: req.user._id,
        changedAt: new Date(),
        notes: `${changedFieldName} is ${previousKey ? 'updated' : 'uploaded'} by ${actorWithRole(req.user)}.`,
      });
      await job.save();

      if (previousKey && previousKey !== req.body.key) {
        await deleteObject(previousKey).catch(() => {});
      }
      notifyAssignmentDocumentChange({
        job,
        documentFieldName: changedFieldName,
        action: previousKey ? 'updated' : 'uploaded',
        actorUser: req.user,
      });
      broadcastJobUpdate();

      return res.json({
        success: true,
        data: {
          assignmentDocumentRequirements: job.assignmentDocumentRequirements,
        },
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── GET /api/jobs/:id/assignment-documents/:requirementKey/url ──────
router.get(
  '/:id/assignment-documents/:requirementKey/url',
  async (req, res) => {
    try {
      const job = await Job.findById(req.params.id).select(
        '_id status assignedTechnician secondaryAssignedTechnician assignmentDocumentRequirements'
      );
      if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to view this job' });
      }
      const row = (job.assignmentDocumentRequirements || []).find(
        (item) => item?.key === req.params.requirementKey
      );
      if (!row?.document?.key) {
        return res.status(404).json({ success: false, error: 'Document not found' });
      }
      const url = await getDownloadUrl({
        key: row.document.key,
        fileName: row.document.fileName || 'document',
        expiresIn: 900,
      });
      return res.json({ success: true, data: { url } });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── DELETE /api/jobs/:id/assignment-documents/:requirementKey ───────
router.delete(
  '/:id/assignment-documents/:requirementKey',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const job = await Job.findById(req.params.id);
      if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to update this job' });
      }
      const rows = Array.isArray(job.assignmentDocumentRequirements)
        ? [...job.assignmentDocumentRequirements]
        : [];
      const rowIndex = rows.findIndex((row) => row?.key === req.params.requirementKey);
      if (rowIndex === -1) {
        return res.status(404).json({ success: false, error: 'Requirement not found' });
      }
      const currentRow = rows[rowIndex]?.toObject ? rows[rowIndex].toObject() : rows[rowIndex];
      const oldKey = currentRow?.document?.key;
      const changedFieldName = currentRow?.label || 'Document';
      rows[rowIndex] = {
        ...currentRow,
        document: null,
      };
      job.assignmentDocumentRequirements = rows;
      job.statusHistory.push({
        fromStatus: job.status,
        toStatus: job.status,
        changedBy: req.user._id,
        changedAt: new Date(),
        notes: `${changedFieldName} is deleted by ${actorWithRole(req.user)}.`,
      });
      await job.save();
      if (oldKey) {
        await deleteObject(oldKey).catch(() => {});
      }
      notifyAssignmentDocumentChange({
        job,
        documentFieldName: changedFieldName,
        action: 'deleted',
        actorUser: req.user,
      });
      broadcastJobUpdate();
      return res.json({
        success: true,
        data: { assignmentDocumentRequirements: job.assignmentDocumentRequirements },
        message: 'Assignment document deleted',
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/jobs/:id/reassign (ADMIN, OFFICE_MANAGER) ────────────
router.patch(
  '/:id/reassign',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('technicianId').isMongoId().withMessage('Valid technician ID required'),
    body('secondaryTechnicianId').optional({ values: 'falsy' }).isMongoId().withMessage('Valid secondary technician ID required'),
    body('notes').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const job = await Job.findById(req.params.id)
        .populate('assignedTechnician', 'name email certificates')
        .populate('secondaryAssignedTechnician', 'name email certificates');

      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }

      // Must be in ASSIGNED or IN_PROGRESS to reassign
      const reassignableStatuses = [JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS];
      if (!reassignableStatuses.includes(job.status)) {
        return res.status(400).json({
          success: false,
          error: `Cannot reassign a job in ${job.status} status. Job must be in ASSIGNED or IN_PROGRESS.`,
        });
      }

      const oldTechId = job.assignedTechnician?._id?.toString();
      const oldSecondaryTechId = job.secondaryAssignedTechnician?._id?.toString();
      const oldTechName = job.assignedTechnician?.name || 'previous technician';
      const oldSecondaryTechName = job.secondaryAssignedTechnician?.name || '';
      const previousStatus = job.status;
      const nextTechId = req.body.technicianId.toString();
      const nextSecondaryTechId = req.body.secondaryTechnicianId
        ? req.body.secondaryTechnicianId.toString()
        : null;

      if (nextSecondaryTechId && nextSecondaryTechId === nextTechId) {
        return res.status(400).json({
          success: false,
          error: 'Primary and secondary technicians must be different',
        });
      }

      // Check new tech availability on scheduled date
      if (job.scheduledDate) {
        const unavailReason = await JobService.checkTechAvailability(
          req.body.technicianId,
          job.scheduledDate,
          job._id
        );
        if (unavailReason) {
          const newTech = await User.findById(req.body.technicianId).select('name');
          return res.status(400).json({
            success: false,
            error: `Technician ${newTech?.name || ''} is unavailable on this date: ${unavailReason}`,
          });
        }
        if (nextSecondaryTechId) {
          const secondaryUnavailReason = await JobService.checkTechAvailability(
            nextSecondaryTechId,
            job.scheduledDate,
            job._id
          );
          if (secondaryUnavailReason) {
            const secondaryTech = await User.findById(nextSecondaryTechId).select('name');
            return res.status(400).json({
              success: false,
              error: `Secondary technician ${secondaryTech?.name || ''} is unavailable on this date: ${secondaryUnavailReason}`,
            });
          }
        }
      }

      // Fetch new technician's name
      const newTech = await User.findById(req.body.technicianId).select('name');
      const newTechName = newTech?.name || 'new technician';
      let newSecondaryTechName = '';
      if (nextSecondaryTechId) {
        const newSecondaryTech = await User.findById(nextSecondaryTechId).select('name role');
        if (!newSecondaryTech || newSecondaryTech.role !== ROLES.TECHNICIAN) {
          return res.status(400).json({ success: false, error: 'Secondary technician not found' });
        }
        newSecondaryTechName = newSecondaryTech.name;
      }

      // Enforce certification for cert-required job types on primary only
      const reassignCertError = await JobService.ensureTechCertifiedForJobType(
        job.jobType,
        [req.body.technicianId]
      );
      if (reassignCertError) {
        return res.status(400).json({ success: false, error: reassignCertError });
      }

      // Update job: new technician, reset status to ASSIGNED
      job.assignedTechnician = req.body.technicianId;
      job.secondaryAssignedTechnician = nextSecondaryTechId;
      job.status = JOB_STATUS.ASSIGNED;
      job.statusHistory.push({
        fromStatus: previousStatus,
        toStatus: JOB_STATUS.ASSIGNED,
        changedBy: req.user._id,
        notes: req.body.notes || `Reassigned from ${oldTechName} to ${newTechName}`,
      });
      await job.save();

      // Re-populate for response
      await job.populate('assignedTechnician', 'name email certificates');
      await job.populate('secondaryAssignedTechnician', 'name email certificates');
      await job.populate('createdBy', 'name email');

      // Reassign notifications: notify only affected technicians.
      // 1) Secondary changed -> notify new secondary + old secondary + unchanged primary
      if (oldSecondaryTechId !== nextSecondaryTechId) {
        if (nextSecondaryTechId) {
          createNotification({
            type: 'JOB_REASSIGNED',
            message: `You have been assigned to this job as the secondary technician. The primary technician is ${newTechName}.${req.body.notes ? ` Assignment note: ${req.body.notes}` : ''}`,
            jobId: job._id,
            recipientIds: [nextSecondaryTechId],
            excludeUserId: req.user._id,
          });
        }
        if (oldSecondaryTechId && oldSecondaryTechId !== nextTechId) {
          createNotification({
            type: 'JOB_REASSIGNED',
            message: `You have been unassigned from ${job.title}.`,
            jobId: job._id,
            recipientIds: [oldSecondaryTechId],
            excludeUserId: req.user._id,
          });
        }
        if (oldTechId && oldTechId === nextTechId && oldSecondaryTechName) {
          const secondaryChangeMessage = newSecondaryTechName
            ? `The secondary technician for this job has been changed from ${oldSecondaryTechName} to ${newSecondaryTechName}.`
            : `Secondary tech ${oldSecondaryTechName} is removed from job.`;
          createNotification({
            type: 'JOB_REASSIGNED',
            message: `${secondaryChangeMessage}${req.body.notes ? ` Assignment note: ${req.body.notes}` : ''}`,
            jobId: job._id,
            recipientIds: [oldTechId],
            excludeUserId: req.user._id,
          });
        }
      }

      // 2) Primary changed -> notify new primary + old primary + unchanged secondary
      if (oldTechId !== nextTechId) {
        const primaryContext = newSecondaryTechName
          ? ` The secondary technician is ${newSecondaryTechName}.`
          : '';
        createNotification({
          type: 'JOB_REASSIGNED',
          message: `You have been assigned to this job as the primary technician.${primaryContext}${req.body.notes ? ` Assignment note: ${req.body.notes}` : ''}`,
          jobId: job._id,
          recipientIds: [nextTechId],
          excludeUserId: req.user._id,
        });
        if (oldTechId && oldTechId !== nextSecondaryTechId) {
          createNotification({
            type: 'JOB_REASSIGNED',
            message: `You have been unassigned from ${job.title}.`,
            jobId: job._id,
            recipientIds: [oldTechId],
            excludeUserId: req.user._id,
          });
        }
        if (oldSecondaryTechId && oldSecondaryTechId === nextSecondaryTechId && oldTechName) {
          createNotification({
            type: 'JOB_REASSIGNED',
            message: `The primary technician for this job has been changed from ${oldTechName} to ${newTechName}.${req.body.notes ? ` Assignment note: ${req.body.notes}` : ''}`,
            jobId: job._id,
            recipientIds: [oldSecondaryTechId],
            excludeUserId: req.user._id,
          });
        }
      }
      // Also notify admins and managers
      createNotification({
        type: 'JOB_REASSIGNED',
        message: `Job "${job.title}" reassigned from ${oldTechName}${oldSecondaryTechName ? ` + ${oldSecondaryTechName}` : ''} to ${newTechName}${newSecondaryTechName ? ` + ${newSecondaryTechName}` : ''} by ${actorWithRole(req.user)}.${req.body.notes ? ` Notes: ${req.body.notes}` : ''}`,
        jobId: job._id,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      res.json({ success: true, data: job, message: `Reassigned to ${newTechName}` });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/jobs/:id/assignment-checklist (ADMIN, OFFICE_MANAGER) ──
router.patch(
  '/:id/assignment-checklist',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('firstPageReceived').optional().isBoolean().withMessage('firstPageReceived must be true or false'),
    body('printsDrawingsReceived').optional().isBoolean().withMessage('printsDrawingsReceived must be true or false'),
    body('siteContactInfoReceived').optional().isBoolean().withMessage('siteContactInfoReceived must be true or false'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const job = await Job.findById(req.params.id);
      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }

      const prevChecklist = {
        firstPageReceived: Boolean(job.assignmentChecklist?.firstPageReceived),
        printsDrawingsReceived: Boolean(job.assignmentChecklist?.printsDrawingsReceived),
        siteContactInfoReceived: Boolean(job.assignmentChecklist?.siteContactInfoReceived),
      };

      const nextChecklist = {
        firstPageReceived: Boolean(req.body.firstPageReceived ?? job.assignmentChecklist?.firstPageReceived),
        printsDrawingsReceived: Boolean(req.body.printsDrawingsReceived ?? job.assignmentChecklist?.printsDrawingsReceived),
        siteContactInfoReceived: Boolean(req.body.siteContactInfoReceived ?? job.assignmentChecklist?.siteContactInfoReceived),
      };

      const labelByKey = {
        firstPageReceived: 'First page received',
        printsDrawingsReceived: 'Prints/drawings received',
        siteContactInfoReceived: 'Site contact info received',
      };
      const summaryLines = [];
      for (const key of Object.keys(labelByKey)) {
        if (prevChecklist[key] !== nextChecklist[key]) {
          summaryLines.push(`${labelByKey[key]}: ${nextChecklist[key] ? 'yes' : 'no'}`);
        }
      }

      if (!summaryLines.length) {
        await job.populate('assignedTechnician', 'name email certificates');
        await job.populate('secondaryAssignedTechnician', 'name email certificates');
        await job.populate('createdBy', 'name email');
        return res.json({ success: true, data: job, message: 'Assignment checklist unchanged' });
      }

      job.assignmentChecklist = nextChecklist;
      for (let i = job.statusHistory.length - 1; i >= 0; i -= 1) {
        if (job.statusHistory[i]?.toStatus === JOB_STATUS.ASSIGNED) {
          job.statusHistory[i].assignmentChecklist = nextChecklist;
          break;
        }
      }
      if (summaryLines.length) {
        job.statusHistory.push({
          fromStatus: job.status,
          toStatus: job.status,
          changedBy: req.user._id,
          changedAt: new Date(),
          notes: `Assignment checklist updated by ${actorWithRole(req.user)}: ${summaryLines.join('; ')}.`,
        });
        notifyAssignmentChecklistUpdated({
          job,
          summaryLines,
          actorUser: req.user,
        });
      }
      await job.save();
      await job.populate('assignedTechnician', 'name email certificates');
      await job.populate('secondaryAssignedTechnician', 'name email certificates');
      await job.populate('createdBy', 'name email');

      broadcastJobUpdate();
      res.json({ success: true, data: job, message: 'Assignment checklist updated' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/jobs/:id/revert (ADMIN, OFFICE_MANAGER) ─────────────
router.patch(
  '/:id/revert',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const beforeRevertJob = await Job.findById(req.params.id)
        .select('assignedTechnician secondaryAssignedTechnician status title')
        .lean();

      const result = await JobService.revertStatus(req.params.id, req.user);
      if (result.error) {
        return res.status(result.status).json({ success: false, error: result.error });
      }

      const job = result.data;
      const message = `Job "${job.title}" status reverted from ${result.revertedFrom} to ${result.revertedTo} by ${actorWithRole(req.user)}`;
      const previousAssignedTechId = beforeRevertJob?.assignedTechnician?.toString();
      const previousSecondaryAssignedTechId = beforeRevertJob?.secondaryAssignedTechnician?.toString();

      // Notify the assigned technician only if the revert involves statuses visible to them
      // (PAID/CLOSED are hidden from techs, so don't notify them when reverting those)
      const techHiddenStatuses = [JOB_STATUS.PAID, JOB_STATUS.CLOSED];
      if (job.assignedTechnician && !techHiddenStatuses.includes(result.revertedFrom)) {
        createNotification({
          type: 'JOB_UPDATED',
          message,
          jobId: job._id,
          recipientIds: [job.assignedTechnician._id],
          excludeUserId: req.user._id,
        });
      }
      if (result.revertedFrom === JOB_STATUS.ASSIGNED && previousAssignedTechId) {
        createNotification({
          type: 'JOB_UPDATED',
          message: `Job "${job.title}" was reverted from ASSIGNED to CONFIRMED by ${actorWithRole(req.user)}. You have been unassigned.`,
          jobId: job._id,
          recipientIds: [previousAssignedTechId],
          excludeUserId: req.user._id,
        });
      }
      if (
        result.revertedFrom === JOB_STATUS.ASSIGNED &&
        previousSecondaryAssignedTechId &&
        previousSecondaryAssignedTechId !== previousAssignedTechId
      ) {
        createNotification({
          type: 'JOB_UPDATED',
          message: `Job "${job.title}" was reverted from ASSIGNED to CONFIRMED by ${actorWithRole(req.user)}. You have been unassigned.`,
          jobId: job._id,
          recipientIds: [previousSecondaryAssignedTechId],
          excludeUserId: req.user._id,
        });
      }
      // Notify all admins and managers
      createNotification({
        type: 'JOB_UPDATED',
        message,
        jobId: job._id,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      res.json({
        success: true,
        data: job,
        message: `Status reverted to ${result.revertedTo}`,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── DELETE /api/jobs/:id (ADMIN, OFFICE_MANAGER) ────────────────────
router.delete(
  '/:id',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const job = await Job.findById(req.params.id)
        .populate('assignedTechnician', 'name email');

      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }

      if (job.status === JOB_STATUS.BILLED) {
        return res.status(400).json({ success: false, error: 'Billed jobs cannot be deleted' });
      }

      const jobTitle = job.title;
      const techId = job.assignedTechnician?._id;
      const secondaryTechId = job.secondaryAssignedTechnician?._id;

      await Job.findByIdAndDelete(req.params.id);

      // Notify relevant people based on job visibility
      const notifRecipientIds = [];
      const notifRoles = [];

      // Notify tech if the job was already visible to them (ASSIGNED+)
      const techVisibleStatuses = [JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS, JOB_STATUS.COMPLETED];
      if (techId && techVisibleStatuses.includes(job.status)) {
        notifRecipientIds.push(techId);
      }
      if (secondaryTechId && techVisibleStatuses.includes(job.status)) {
        notifRecipientIds.push(secondaryTechId);
      }

      // Notify admins and managers (both can see all jobs including TENTATIVE)
      notifRoles.push(ROLES.ADMIN, ROLES.OFFICE_MANAGER);

      if (notifRecipientIds.length > 0 || notifRoles.length > 0) {
        createNotification({
          type: 'JOB_DELETED',
          message: `Job "${jobTitle}" has been deleted by ${actorWithRole(req.user)}`,
          jobId: null,
          recipientIds: notifRecipientIds,
          recipientRoles: notifRoles,
          excludeUserId: req.user._id,
        });
      }

      broadcastJobUpdate();
      res.json({ success: true, message: `Job "${jobTitle}" deleted` });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PUT /api/jobs/:id (ADMIN, OFFICE_MANAGER) ───────────────────────
router.put(
  '/:id',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('title').optional().notEmpty().withMessage('Title cannot be empty'),
    body('jobType').optional().isString().withMessage('Job type must be a string'),
    body('programmingSubtype').optional().isString().withMessage('Programming subtype must be a string'),
    body('customerEmail').optional().isEmail().withMessage('Invalid customer email'),
    body('scheduledDate').optional().custom(validateScheduledDate),
    body('estimatedCost').optional().isFloat({ min: 0 }).withMessage('Must be positive'),
    body('actualCost').optional().isFloat({ min: 0 }).withMessage('Must be positive'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      // Prevent editing BILLED jobs
      const existingJob = await Job.findById(req.params.id).lean();
      if (!existingJob) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }
      if (existingJob.status === JOB_STATUS.BILLED) {
        return res.status(400).json({ success: false, error: 'Billed jobs cannot be edited' });
      }

      if (req.body.jobType !== undefined) {
        req.body.jobType = normalizeJobType(req.body.jobType);
        if (!req.body.jobType) {
          return res.status(400).json({ success: false, error: 'Job type cannot be empty' });
        }
        await ensureJobTypeSaved(req.body.jobType);
      }

      if (req.body.jobType !== undefined || req.body.programmingSubtype !== undefined) {
        const finalJobType = normalizeJobType(
          req.body.jobType !== undefined ? req.body.jobType : existingJob.jobType,
        );
        const normSubtype = normalizeProgrammingSubtype(
          req.body.programmingSubtype !== undefined
            ? req.body.programmingSubtype
            : (existingJob.programmingSubtype || ''),
        );
        if (await jobTypeIsProgramming(finalJobType)) {
          if (!normSubtype || !PROGRAMMING_SUBTYPES.includes(normSubtype)) {
            return res.status(400).json({
              success: false,
              error:
                'Programming subtype is required and must be "New Start-Up" or "Existing Start-Up" for programming job types',
            });
          }
          req.body.programmingSubtype = normSubtype;
        } else {
          req.body.programmingSubtype = undefined;
        }
      }

      const result = await JobService.updateJobDetails(req.params.id, req.body);
      if (result.error) {
        return res.status(result.status).json({ success: false, error: result.error });
      }

      // Notify relevant people based on job visibility
      const updatedJob = result.data;
      const notifRecipientIds = [];
      const notifRoles = [ROLES.ADMIN, ROLES.OFFICE_MANAGER];

      // Notify tech if the job is already visible to them (ASSIGNED+)
      const techVisible = [JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS, JOB_STATUS.COMPLETED];
      if (updatedJob.assignedTechnician && techVisible.includes(updatedJob.status)) {
        notifRecipientIds.push(updatedJob.assignedTechnician._id || updatedJob.assignedTechnician);
      }
      if (updatedJob.secondaryAssignedTechnician && techVisible.includes(updatedJob.status)) {
        notifRecipientIds.push(updatedJob.secondaryAssignedTechnician._id || updatedJob.secondaryAssignedTechnician);
      }

      createNotification({
        type: 'JOB_UPDATED',
        message: `Job "${updatedJob.title}" details have been updated by ${actorWithRole(req.user)}`,
        jobId: updatedJob._id,
        recipientIds: notifRecipientIds,
        recipientRoles: notifRoles,
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      res.json({ success: true, data: result.data });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── GET /api/jobs/:id/history ───────────────────────────────────────
router.get('/:id/history', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .select('statusHistory status title')
      .populate('statusHistory.changedBy', 'name email role')
      .populate('statusHistory.technician', 'name email');

    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    res.json({
      success: true,
      data: {
        jobId: job._id,
        title: job.title,
        currentStatus: job.status,
        history: job.statusHistory,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
