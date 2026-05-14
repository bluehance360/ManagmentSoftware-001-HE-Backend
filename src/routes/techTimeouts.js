const express = require('express');
const { body, validationResult } = require('express-validator');
const TechTimeout = require('../models/TechTimeout');
const Job = require('../models/Job');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { authenticate, authorize } = require('../middleware/auth');
const { ROLES, JOB_STATUS, TIMEOUT_REQUEST_STATUS } = require('../config/constants');
const { createNotification } = require('../services/NotificationService');
const { emitToUsers, getIO } = require('../socket');
const {
  normalizeDateOnly,
  isDateOnly,
  toLocalDateOnly,
  formatDateOnly,
} = require('../utils/dateOnly');

const router = express.Router();
router.use(authenticate);

function roleLabel(role) {
  if (role === ROLES.ADMIN) return 'Admin';
  if (role === ROLES.OFFICE_MANAGER) return 'Office Manager';
  if (role === ROLES.TECHNICIAN) return 'Technician';
  return role || 'User';
}

function actorWithRole(user) {
  return `${user.name} (${roleLabel(user.role)})`;
}

function formatTimeoutRange(start, end) {
  return start === end
    ? formatDateOnly(start)
    : `${formatDateOnly(start)} to ${formatDateOnly(end)}`;
}

async function updateRequestNotifications({
  timeoutId,
  message,
  timeoutStatus,
  reviewMessage,
  actorUserId,
  reviewedByUser,
  reason,
  technicianId,
  startDate,
  endDate,
}) {
  const filter = {
    type: 'TECH_TIMEOUT_REQUESTED',
    'meta.timeoutRequestId': timeoutId.toString(),
  };

  const update = {
    $set: {
      message,
      read: false,
      'meta.timeoutStatus': timeoutStatus,
      'meta.reason': reason,
      'meta.technicianId': technicianId?.toString(),
      'meta.startDate': startDate,
      'meta.endDate': endDate,
    },
    $currentDate: {
      updatedAt: true,
    },
  };

  if (reviewMessage) {
    update.$set['meta.reviewMessage'] = reviewMessage;
  } else {
    update.$unset = { 'meta.reviewMessage': 1 };
  }

  if (reviewedByUser) {
    update.$set['meta.reviewedByName'] = reviewedByUser.name;
    update.$set['meta.reviewedByRole'] = reviewedByUser.role;
  } else {
    update.$unset = {
      ...(update.$unset || {}),
      'meta.reviewedByName': 1,
      'meta.reviewedByRole': 1,
    };
  }

  await Notification.updateMany(filter, update);

  if (actorUserId) {
    await Notification.updateMany(
      {
        ...filter,
        recipient: actorUserId,
      },
      {
        $set: { read: true },
      }
    );
  }
}

function emitJobUpdate() {
  const io = getIO();
  if (io) io.emit('jobs:updated');
}

function approvedTimeoutQuery(extra = {}) {
  return {
    ...extra,
    $or: [
      { status: TIMEOUT_REQUEST_STATUS.APPROVED },
      { status: { $exists: false } },
    ],
  };
}

// ── Helper: get unavailable technicians for a date ──────────────────
async function getUnavailableTechs(date) {
  const day = normalizeDateOnly(date);
  if (!isDateOnly(day)) return [];

  // 1) Techs with active jobs (ASSIGNED or IN_PROGRESS) on this date
  const activeJobs = await Job.find({
    status: { $in: [JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS] },
    scheduledDate: day,
    assignedTechnician: { $ne: null },
  })
    .populate('assignedTechnician', 'name email')
    .select('assignedTechnician title status scheduledDate')
    .lean();

  // 2) Techs with timeout entries overlapping this date
  const timeouts = await TechTimeout.find(approvedTimeoutQuery({
    startDate: { $lte: day },
    endDate: { $gte: day },
  }))
    .populate('technician', 'name email')
    .lean();

  // Build map: techId → { technician, reasons[] }
  const map = {};

  for (const job of activeJobs) {
    const id = job.assignedTechnician?._id?.toString();
    if (!id) continue;
    if (!map[id]) {
      map[id] = { technician: job.assignedTechnician, reasons: [] };
    }
    map[id].reasons.push({
      type: 'ACTIVE_JOB',
      detail: `Assigned to "${job.title}" (${job.status})`,
    });
  }

  for (const t of timeouts) {
    const id = t.technician?._id?.toString();
    if (!id) continue;
    if (!map[id]) {
      map[id] = { technician: t.technician, reasons: [] };
    }
    map[id].reasons.push({
      type: 'TIMEOUT',
      detail: t.reason || 'Timeout / leave',
    });
  }

  return Object.values(map);
}

// ── GET /api/tech-timeouts/availability?date=YYYY-MM-DD ─────────────
// Returns unavailable-tech list for a given date (ADMIN, OFFICE_MANAGER)
router.get(
  '/availability',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const { date } = req.query;
      if (!date) return res.status(400).json({ success: false, error: 'date query param is required' });
      const normalizedDate = normalizeDateOnly(date);
      if (!isDateOnly(normalizedDate)) {
        return res.status(400).json({ success: false, error: 'date must be in YYYY-MM-DD format' });
      }

      const allTechs = await User.find({ role: ROLES.TECHNICIAN, isActive: true })
        .select('name email')
        .lean();

      const unavailable = await getUnavailableTechs(normalizedDate);
      const unavailableIds = unavailable.map((u) => u.technician._id.toString());

      res.json({
        success: true,
        data: {
          total: allTechs.length,
          unavailableCount: unavailable.length,
          availableCount: allTechs.length - unavailable.length,
          unavailable, // [{ technician: { _id, name, email }, reasons: [...] }]
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── GET /api/tech-timeouts/my  ──────────────────────────────────────
// Technicians fetch their own timeouts
router.get('/my', async (req, res) => {
  try {
    const timeouts = await TechTimeout.find({ technician: req.user._id })
      .sort({ createdAt: -1, startDate: -1 })
      .lean();
    res.json({
      success: true,
      data: timeouts.map((timeout) => ({
        ...timeout,
        status: timeout.status || TIMEOUT_REQUEST_STATUS.APPROVED,
      })),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch(
  '/:id/request-list-dismiss',
  authorize(ROLES.TECHNICIAN),
  async (req, res) => {
    try {
      const timeout = await TechTimeout.findOneAndUpdate(
        {
          _id: req.params.id,
          technician: req.user._id,
          status: { $in: [TIMEOUT_REQUEST_STATUS.APPROVED, TIMEOUT_REQUEST_STATUS.REJECTED] },
          requestListDismissedAt: { $exists: false },
        },
        {
          $set: { requestListDismissedAt: new Date() },
        },
        { new: true }
      );

      if (!timeout) {
        return res.status(404).json({
          success: false,
          error: 'Request item not found or cannot be removed from requests',
        });
      }

      res.json({ success: true, message: 'Request removed from list', data: timeout });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── GET /api/tech-timeouts/technician/:id  ──────────────────────────
// Admin/manager fetch a specific technician's timeouts + jobs
router.get(
  '/technician/:id',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const tech = await User.findById(req.params.id).select('name email role certificates');
      if (!tech || tech.role !== ROLES.TECHNICIAN) {
        return res.status(404).json({ success: false, error: 'Technician not found' });
      }

      const [timeouts, jobs] = await Promise.all([
        TechTimeout.find(approvedTimeoutQuery({
          technician: req.params.id,
        })).sort({ startDate: -1 }).lean(),
        Job.find({ assignedTechnician: req.params.id })
          .populate('customer', 'name phone email address')
          .sort({ scheduledDate: -1 })
          .lean(),
      ]);

      const rootIds = jobs.filter((job) => !job.parentJob).map((job) => job._id);
      const parentIds = rootIds.length > 0
        ? await Job.find({ parentJob: { $in: rootIds }, jobVisitKind: 'RETURN' }).distinct('parentJob')
        : [];
      const parentIdSet = new Set(parentIds.map((id) => String(id)));
      const jobsWithLinkedReturnFlag = jobs.map((job) => ({
        ...job,
        hasLinkedReturnVisit: !job.parentJob && parentIdSet.has(String(job._id)),
      }));

      res.json({
        success: true,
        data: { technician: tech, timeouts, jobs: jobsWithLinkedReturnFlag },
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/tech-timeouts  ────────────────────────────────────────
// Create timeout — technician for themselves, admin/manager for any tech
router.post(
  '/',
  [
    body('startDate').notEmpty().withMessage('Start date is required').custom((value) => {
      const normalized = normalizeDateOnly(value);
      if (!isDateOnly(normalized)) throw new Error('Invalid startDate format. Use YYYY-MM-DD');
      return true;
    }),
    body('endDate').optional({ values: 'falsy' }).custom((value) => {
      const normalized = normalizeDateOnly(value);
      if (!isDateOnly(normalized)) throw new Error('Invalid endDate format. Use YYYY-MM-DD');
      return true;
    }),
    body('reason').optional({ values: 'falsy' }).trim(),
    body('technicianId').optional().isMongoId(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      let techId = req.user._id;
      let techName = req.user.name;

      // Admin/Manager can create timeout for a specific tech
      if (req.body.technicianId && [ROLES.ADMIN, ROLES.OFFICE_MANAGER].includes(req.user.role)) {
        const tech = await User.findById(req.body.technicianId).select('name role');
        if (!tech || tech.role !== ROLES.TECHNICIAN) {
          return res.status(404).json({ success: false, error: 'Technician not found' });
        }
        techId = tech._id;
        techName = tech.name;
      } else if (req.user.role !== ROLES.TECHNICIAN) {
        // Non-technician must specify technicianId
        if (!req.body.technicianId) {
          return res.status(400).json({ success: false, error: 'technicianId is required for admin/manager' });
        }
      }

      const start = normalizeDateOnly(req.body.startDate);
      const end = normalizeDateOnly(req.body.endDate) || start;
      const normalizedReason = req.body.reason?.trim() || undefined;
      const createdByManager = [ROLES.ADMIN, ROLES.OFFICE_MANAGER].includes(req.user.role);

      if (end < start) {
        return res.status(400).json({ success: false, error: 'End date must be on or after start date' });
      }

      if (req.user.role === ROLES.TECHNICIAN) {
        const blockingJob = await Job.findOne({
          $and: [
            {
              $or: [
                { assignedTechnician: req.user._id },
                { secondaryAssignedTechnician: req.user._id },
              ],
            },
            {
              $or: [
                { status: JOB_STATUS.IN_PROGRESS },
                {
                  status: JOB_STATUS.ASSIGNED,
                  $or: [
                    { scheduledDate: { $lte: end } },
                    { scheduledDate: null },
                    { scheduledDate: { $exists: false } },
                  ],
                },
              ],
            },
          ],
        })
          .select('title scheduledDate status')
          .lean();

        if (blockingJob) {
          return res.status(400).json({
            success: false,
            error: `You already have an active ${blockingJob.status.toLowerCase().replace('_', ' ')} job from ${formatDateOnly(blockingJob.scheduledDate)} for "${blockingJob.title}". Complete or reassign it before requesting timeout.`,
          });
        }
      }

      const overlappingTimeout = await TechTimeout.findOne({
        technician: techId,
        $or: [
          { status: TIMEOUT_REQUEST_STATUS.PENDING },
          { status: TIMEOUT_REQUEST_STATUS.APPROVED },
          { status: { $exists: false } },
        ],
        startDate: { $lte: end },
        endDate: { $gte: start },
      }).lean();

      if (overlappingTimeout) {
        return res.status(400).json({
          success: false,
          error: 'A pending or approved timeout already overlaps those dates',
        });
      }

      const timeout = await TechTimeout.create({
        technician: techId,
        startDate: start,
        endDate: end,
        reason: normalizedReason,
        status: createdByManager ? TIMEOUT_REQUEST_STATUS.APPROVED : TIMEOUT_REQUEST_STATUS.PENDING,
        reviewedBy: createdByManager ? req.user._id : undefined,
        reviewedAt: createdByManager ? new Date() : undefined,
      });

      const rangeLabel = formatTimeoutRange(start, end);

      if (createdByManager) {
        await createNotification({
          type: 'TECH_TIMEOUT_APPROVED',
          message: `A timeout was added for you for ${rangeLabel} by ${actorWithRole(req.user)}.`,
          jobId: null,
          recipientIds: [techId],
          meta: {
            timeoutRequestId: timeout._id.toString(),
            timeoutStatus: TIMEOUT_REQUEST_STATUS.APPROVED,
          },
          excludeUserId: req.user._id,
        });

        emitJobUpdate();
        return res.status(201).json({
          success: true,
          data: timeout,
          message: 'Timeout created successfully',
        });
      }

      await createNotification({
        type: 'TECH_TIMEOUT_REQUESTED',
        message: `${actorWithRole(req.user)} requested timeout for ${rangeLabel}.`,
        jobId: null,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        meta: {
          timeoutRequestId: timeout._id.toString(),
          timeoutStatus: TIMEOUT_REQUEST_STATUS.PENDING,
          technicianId: techId.toString(),
          startDate: start,
          endDate: end,
          reason: normalizedReason,
        },
        excludeUserId: req.user._id,
      });

      res.status(201).json({
        success: true,
        data: timeout,
        message: 'Timeout request submitted for approval',
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/tech-timeouts/:id/review  ───────────────────────────
// Admin/manager approve or reject a technician timeout request
router.patch(
  '/:id/review',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('decision')
      .isIn(['APPROVE', 'REJECT'])
      .withMessage('decision must be APPROVE or REJECT'),
    body('reviewMessage').optional({ values: 'falsy' }).trim(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const timeout = await TechTimeout.findById(req.params.id).populate('technician', 'name role');
      if (!timeout) {
        return res.status(404).json({ success: false, error: 'Timeout request not found' });
      }

      if (timeout.status !== TIMEOUT_REQUEST_STATUS.PENDING) {
        return res.status(400).json({
          success: false,
          error: `This timeout request is already ${timeout.status.toLowerCase()}`,
        });
      }

      const reviewMessage = req.body.reviewMessage?.trim() || undefined;
      const rangeLabel = formatTimeoutRange(timeout.startDate, timeout.endDate);

      if (req.body.decision === 'APPROVE') {
        const overlappingApprovedTimeout = await TechTimeout.findOne({
          _id: { $ne: timeout._id },
          technician: timeout.technician._id,
          $or: [
            { status: TIMEOUT_REQUEST_STATUS.APPROVED },
            { status: { $exists: false } },
          ],
          startDate: { $lte: timeout.endDate },
          endDate: { $gte: timeout.startDate },
        }).lean();

        if (overlappingApprovedTimeout) {
          return res.status(400).json({
            success: false,
            error: 'This request overlaps an already approved timeout',
          });
        }

        timeout.status = TIMEOUT_REQUEST_STATUS.APPROVED;
        timeout.reviewedBy = req.user._id;
        timeout.reviewedAt = new Date();
        timeout.reviewMessage = undefined;
        await timeout.save();

        const managerMessage = `${timeout.technician.name}'s timeout request for ${rangeLabel} was approved by ${actorWithRole(req.user)}.`;

        await updateRequestNotifications({
          timeoutId: timeout._id,
          message: managerMessage,
          timeoutStatus: TIMEOUT_REQUEST_STATUS.APPROVED,
          actorUserId: req.user._id,
          reviewedByUser: req.user,
          reason: timeout.reason,
          technicianId: timeout.technician._id,
          startDate: timeout.startDate,
          endDate: timeout.endDate,
        });

        await createNotification({
          type: 'TECH_TIMEOUT_APPROVED',
          message: `Your timeout request for ${rangeLabel} was approved by ${actorWithRole(req.user)}.`,
          jobId: null,
          recipientIds: [timeout.technician._id],
          meta: {
            timeoutRequestId: timeout._id.toString(),
            timeoutStatus: TIMEOUT_REQUEST_STATUS.APPROVED,
            reason: timeout.reason,
          },
        });

        emitToUsers({
          event: 'notification',
          data: {
            type: 'TECH_TIMEOUT_REQUESTED',
            message: managerMessage,
            meta: {
              timeoutRequestId: timeout._id.toString(),
              timeoutStatus: TIMEOUT_REQUEST_STATUS.APPROVED,
              reason: timeout.reason,
              technicianId: timeout.technician._id.toString(),
              startDate: timeout.startDate,
              endDate: timeout.endDate,
              reviewedByName: req.user.name,
              reviewedByRole: req.user.role,
            },
          },
          recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
          excludeUserId: req.user._id,
        });

        emitToUsers({
          event: 'notifications:updated',
          data: { timeoutRequestId: timeout._id.toString(), timeoutStatus: TIMEOUT_REQUEST_STATUS.APPROVED },
          recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        });

        emitJobUpdate();
        return res.json({
          success: true,
          data: timeout.toObject(),
          message: 'Timeout request approved',
        });
      }

      timeout.status = TIMEOUT_REQUEST_STATUS.REJECTED;
      timeout.reviewedBy = req.user._id;
      timeout.reviewedAt = new Date();
      timeout.reviewMessage = reviewMessage;
      await timeout.save();

      const managerMessage = reviewMessage
        ? `${timeout.technician.name}'s timeout request for ${rangeLabel} was rejected by ${actorWithRole(req.user)}. Response: ${reviewMessage}`
        : `${timeout.technician.name}'s timeout request for ${rangeLabel} was rejected by ${actorWithRole(req.user)}.`;

      await updateRequestNotifications({
        timeoutId: timeout._id,
        message: managerMessage,
        timeoutStatus: TIMEOUT_REQUEST_STATUS.REJECTED,
        reviewMessage,
        actorUserId: req.user._id,
        reviewedByUser: req.user,
        reason: timeout.reason,
        technicianId: timeout.technician._id,
        startDate: timeout.startDate,
        endDate: timeout.endDate,
      });

      const rejectionMessage = reviewMessage
        ? `Your timeout request for ${rangeLabel} was rejected by ${actorWithRole(req.user)}. Response: ${reviewMessage}`
        : `Your timeout request for ${rangeLabel} was rejected by ${actorWithRole(req.user)}.`;

      await createNotification({
        type: 'TECH_TIMEOUT_REJECTED',
        message: rejectionMessage,
        jobId: null,
        recipientIds: [timeout.technician._id],
        meta: {
          timeoutRequestId: timeout._id.toString(),
          timeoutStatus: TIMEOUT_REQUEST_STATUS.REJECTED,
          reason: timeout.reason,
          reviewMessage,
        },
      });

      emitToUsers({
        event: 'notification',
        data: {
          type: 'TECH_TIMEOUT_REQUESTED',
          message: managerMessage,
          meta: {
            timeoutRequestId: timeout._id.toString(),
            timeoutStatus: TIMEOUT_REQUEST_STATUS.REJECTED,
            reason: timeout.reason,
            reviewMessage,
            technicianId: timeout.technician._id.toString(),
            startDate: timeout.startDate,
            endDate: timeout.endDate,
            reviewedByName: req.user.name,
            reviewedByRole: req.user.role,
          },
        },
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      emitToUsers({
        event: 'notifications:updated',
        data: {
          timeoutRequestId: timeout._id.toString(),
          timeoutStatus: TIMEOUT_REQUEST_STATUS.REJECTED,
        },
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
      });

      res.json({
        success: true,
        data: timeout.toObject(),
        message: 'Timeout request rejected',
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── DELETE /api/tech-timeouts/:id  ──────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const timeout = await TechTimeout.findById(req.params.id);
    if (!timeout) {
      return res.status(404).json({ success: false, error: 'Timeout entry not found' });
    }

    // Technicians can only delete their own
    if (req.user.role === ROLES.TECHNICIAN) {
      if (timeout.technician.toString() !== req.user._id.toString()) {
        return res.status(403).json({ success: false, error: 'Not authorized' });
      }
    }

    if (req.user.role === ROLES.TECHNICIAN && timeout.status === TIMEOUT_REQUEST_STATUS.PENDING) {
      const rangeLabel = formatTimeoutRange(timeout.startDate, timeout.endDate);
      const managerMessage = `${actorWithRole(req.user)} cancelled the timeout request for ${rangeLabel}.`;

      await updateRequestNotifications({
        timeoutId: timeout._id,
        message: managerMessage,
        timeoutStatus: 'CANCELLED',
        reviewedByUser: req.user,
        reason: timeout.reason,
        technicianId: req.user._id,
        startDate: timeout.startDate,
        endDate: timeout.endDate,
      });

      emitToUsers({
        event: 'notification',
        data: {
          type: 'TECH_TIMEOUT_REQUESTED',
          message: managerMessage,
          meta: {
            timeoutRequestId: timeout._id.toString(),
            timeoutStatus: 'CANCELLED',
            technicianId: req.user._id.toString(),
            startDate: timeout.startDate,
            endDate: timeout.endDate,
            reason: timeout.reason,
            reviewedByName: req.user.name,
            reviewedByRole: req.user.role,
          },
        },
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
      });

      emitToUsers({
        event: 'notifications:updated',
        data: {
          timeoutRequestId: timeout._id.toString(),
          timeoutStatus: 'CANCELLED',
        },
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
      });
    }

    const isApprovedTimeout =
      !timeout.status || timeout.status === TIMEOUT_REQUEST_STATUS.APPROVED;
    const isTechDeletingUpcomingApprovedTimeout =
      req.user.role === ROLES.TECHNICIAN &&
      isApprovedTimeout &&
      normalizeDateOnly(timeout.endDate) >= toLocalDateOnly();

    if (isTechDeletingUpcomingApprovedTimeout) {
      const rangeLabel = formatTimeoutRange(timeout.startDate, timeout.endDate);
      const isSingleDay = normalizeDateOnly(timeout.startDate) === normalizeDateOnly(timeout.endDate);
      const managerMessage = isSingleDay
        ? `${actorWithRole(req.user)} deleted the approved time off for ${rangeLabel}. ${req.user.name} is now available on that date.`
        : `${actorWithRole(req.user)} deleted the approved time off for ${rangeLabel}. ${req.user.name} is now available for those dates.`;

      await createNotification({
        type: 'TECH_TIMEOUT_CANCELLED',
        message: managerMessage,
        jobId: null,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        meta: {
          timeoutRequestId: timeout._id.toString(),
          timeoutStatus: 'CANCELLED',
          technicianId: req.user._id.toString(),
          startDate: timeout.startDate,
          endDate: timeout.endDate,
          availabilityRestored: true,
        },
      });
    }

    await TechTimeout.findByIdAndDelete(req.params.id);

    if (!timeout.status || timeout.status === TIMEOUT_REQUEST_STATUS.APPROVED) {
      emitJobUpdate();
    }

    res.json({
      success: true,
      message:
        req.user.role === ROLES.TECHNICIAN && timeout.status === TIMEOUT_REQUEST_STATUS.PENDING
          ? 'Timeout request cancelled'
          : req.user.role === ROLES.TECHNICIAN && timeout.status === TIMEOUT_REQUEST_STATUS.REJECTED
            ? 'Rejected request deleted'
          : 'Timeout entry deleted',
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
