const express = require('express');
const { body, validationResult } = require('express-validator');
const Job = require('../models/Job');
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

function canAccessJob(user, job) {
  if (!job) return false;
  if ([ROLES.ADMIN, ROLES.OFFICE_MANAGER].includes(user.role)) return true;
  if (user.role !== ROLES.TECHNICIAN) return false;
  if (!TECH_VISIBLE_STATUSES.includes(job.status)) return false;
  const techId = job.assignedTechnician?._id || job.assignedTechnician;
  return techId?.toString() === user._id.toString();
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

router.use(authenticate);

// ── GET /api/jobs ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, assignedTechnician, page = 1, limit = 20 } = req.query;
    const filter = {};

    if (req.user.role === ROLES.TECHNICIAN) {
      filter.assignedTechnician = req.user._id;
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

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [jobs, total] = await Promise.all([
      Job.find(filter)
        .populate('assignedTechnician', 'name email')
        .populate('createdBy', 'name email')
        .populate('customer', 'name phone email address')
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

// ── GET /api/jobs/:id ────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .populate('assignedTechnician', 'name email')
      .populate('createdBy', 'name email')
      .populate('customer', 'name phone email address')
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
      if (job.assignedTechnician?._id.toString() !== req.user._id.toString()) {
        return res.status(403).json({ success: false, error: 'Not authorized to view this job' });
      }
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

      const job = await JobService.createJob(req.body, req.user._id);

      // Notify admins and managers
      createNotification({
        type: 'JOB_CREATED',
        message: `New job created by ${req.user.name}: "${job.title}" for ${customer.name}`,
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
      const job = await Job.findById(req.params.id).select('_id title status assignedTechnician');
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
        .select('_id title status assignedTechnician documents')
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
        ? `${req.user.name} uploaded "${firstFile}" to job "${job.title}"`
        : `${req.user.name} uploaded ${latest.length} documents to job "${job.title}"`;

      const recipientIds = [];
      if (job.assignedTechnician?._id) recipientIds.push(job.assignedTechnician._id);

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
      .select('_id status assignedTechnician documents');

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
      .select('_id title status assignedTechnician documents')
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

    let message = `${req.user.name} deleted "${fileName}" from job "${job.title}"`;
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
            `"${job.title}" marked as ${statusLabel} by ${req.user.name} on behalf of ${techName}`;
          // Notify the assigned tech
          notifRecipientIds.push(job.assignedTechnician._id);
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
        message: `${STATUS_MESSAGES[req.body.status] || `Job "${job.title}" status updated`} by ${req.user.name}`,
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
    body('notes').optional().isString(),
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
        req.body.notes
      );

      if (result.error) {
        return res.status(result.status).json({ success: false, error: result.error });
      }

      // Notify the assigned technician immediately when assigned
      const assignedJob = result.data;
      createNotification({
        type: 'JOB_ASSIGNED',
        message: `Job "${assignedJob.title}" has been assigned to you by ${req.user.name}. Instructions: ${req.body.notes}`,
        jobId: assignedJob._id,
        recipientIds: [req.body.technicianId],
        excludeUserId: req.user._id,
      });
      // Also notify admins and managers
      createNotification({
        type: 'JOB_ASSIGNED',
        message: `Job "${assignedJob.title}" has been assigned to ${assignedJob.assignedTechnician?.name || 'a technician'} by ${req.user.name}`,
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

// ── PATCH /api/jobs/:id/reassign (ADMIN, OFFICE_MANAGER) ────────────
router.patch(
  '/:id/reassign',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('technicianId').isMongoId().withMessage('Valid technician ID required'),
    body('notes').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const job = await Job.findById(req.params.id)
        .populate('assignedTechnician', 'name email');

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
      const oldTechName = job.assignedTechnician?.name || 'previous technician';
      const previousStatus = job.status;

      // Check new tech availability on scheduled date
      if (job.scheduledDate) {
        const unavailReason = await JobService.checkTechAvailability(req.body.technicianId, job.scheduledDate);
        if (unavailReason) {
          const newTech = await User.findById(req.body.technicianId).select('name');
          return res.status(400).json({
            success: false,
            error: `Technician ${newTech?.name || ''} is unavailable on this date: ${unavailReason}`,
          });
        }
      }

      // Fetch new technician's name
      const newTech = await User.findById(req.body.technicianId).select('name');
      const newTechName = newTech?.name || 'new technician';

      // Update job: new technician, reset status to ASSIGNED
      job.assignedTechnician = req.body.technicianId;
      job.status = JOB_STATUS.ASSIGNED;
      job.statusHistory.push({
        fromStatus: previousStatus,
        toStatus: JOB_STATUS.ASSIGNED,
        changedBy: req.user._id,
        notes: req.body.notes || `Reassigned from ${oldTechName} to ${newTechName}`,
      });
      await job.save();

      // Re-populate for response
      await job.populate('assignedTechnician', 'name email');
      await job.populate('createdBy', 'name email');

      // Notify the new technician immediately
      createNotification({
        type: 'JOB_REASSIGNED',
        message: `Job "${job.title}" has been reassigned to you by ${req.user.name}`,
        jobId: job._id,
        recipientIds: [req.body.technicianId],
        excludeUserId: req.user._id,
      });
      // Also notify admins and managers
      createNotification({
        type: 'JOB_REASSIGNED',
        message: `Job "${job.title}" reassigned from ${oldTechName} to ${newTechName} by ${req.user.name}`,
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

// ── PATCH /api/jobs/:id/revert (ADMIN, OFFICE_MANAGER) ─────────────
router.patch(
  '/:id/revert',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const result = await JobService.revertStatus(req.params.id, req.user);
      if (result.error) {
        return res.status(result.status).json({ success: false, error: result.error });
      }

      const job = result.data;
      const message = `Job "${job.title}" status reverted from ${result.revertedFrom} to ${result.revertedTo} by ${req.user.name}`;

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

      await Job.findByIdAndDelete(req.params.id);

      // Notify relevant people based on job visibility
      const notifRecipientIds = [];
      const notifRoles = [];

      // Notify tech if the job was already visible to them (ASSIGNED+)
      const techVisibleStatuses = [JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS, JOB_STATUS.COMPLETED];
      if (techId && techVisibleStatuses.includes(job.status)) {
        notifRecipientIds.push(techId);
      }

      // Notify admins and managers (both can see all jobs including TENTATIVE)
      notifRoles.push(ROLES.ADMIN, ROLES.OFFICE_MANAGER);

      if (notifRecipientIds.length > 0 || notifRoles.length > 0) {
        createNotification({
          type: 'JOB_DELETED',
          message: `Job "${jobTitle}" has been deleted by ${req.user.name}`,
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
      const existingJob = await Job.findById(req.params.id);
      if (existingJob && existingJob.status === JOB_STATUS.BILLED) {
        return res.status(400).json({ success: false, error: 'Billed jobs cannot be edited' });
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

      createNotification({
        type: 'JOB_UPDATED',
        message: `Job "${updatedJob.title}" details have been updated by ${req.user.name}`,
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
