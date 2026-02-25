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

const router = express.Router();

function broadcastJobUpdate() {
  const io = getIO();
  if (io) io.emit('jobs:updated');
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
      .populate('statusHistory.changedBy', 'name email role');

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
    body('scheduledDate').notEmpty().withMessage('Scheduled date is required').isISO8601().withMessage('Invalid date format')
      .custom((value) => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (new Date(value) < today) throw new Error('Scheduled date cannot be in the past');
        return true;
      }),
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
      };

      // Notify the relevant people
      if ([JOB_STATUS.IN_PROGRESS, JOB_STATUS.COMPLETED].includes(req.body.status)) {
        // Notify admins and managers
        notifRoles.push(ROLES.ADMIN, ROLES.OFFICE_MANAGER);
      }
      if (req.body.status === JOB_STATUS.BILLED) {
        notifRoles.push(ROLES.ADMIN, ROLES.OFFICE_MANAGER);
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
    body('scheduledDate').optional().isISO8601().withMessage('Invalid date format')
      .custom((value) => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (new Date(value) < today) throw new Error('Scheduled date cannot be in the past');
        return true;
      }),
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
      .populate('statusHistory.changedBy', 'name email role');

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
