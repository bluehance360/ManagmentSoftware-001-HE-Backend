const express = require('express');
const { body, validationResult } = require('express-validator');
const TechTimeout = require('../models/TechTimeout');
const Job = require('../models/Job');
const User = require('../models/User');
const { authenticate, authorize } = require('../middleware/auth');
const { ROLES, JOB_STATUS } = require('../config/constants');
const { createNotification } = require('../services/NotificationService');
const { getIO } = require('../socket');

const router = express.Router();
router.use(authenticate);

// ── Helper: get unavailable technicians for a date ──────────────────
async function getUnavailableTechs(date) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const dayEnd = new Date(day);
  dayEnd.setHours(23, 59, 59, 999);

  // 1) Techs with active jobs (ASSIGNED or IN_PROGRESS) on this date
  const activeJobs = await Job.find({
    status: { $in: [JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS] },
    scheduledDate: { $gte: day, $lte: dayEnd },
    assignedTechnician: { $ne: null },
  })
    .populate('assignedTechnician', 'name email')
    .select('assignedTechnician title status scheduledDate')
    .lean();

  // 2) Techs with timeout entries overlapping this date
  const timeouts = await TechTimeout.find({
    startDate: { $lte: dayEnd },
    endDate: { $gte: day },
  })
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

      const allTechs = await User.find({ role: ROLES.TECHNICIAN, isActive: true })
        .select('name email')
        .lean();

      const unavailable = await getUnavailableTechs(date);
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
      .sort({ startDate: -1 })
      .lean();
    res.json({ success: true, data: timeouts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /api/tech-timeouts/technician/:id  ──────────────────────────
// Admin/manager fetch a specific technician's timeouts + jobs
router.get(
  '/technician/:id',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const tech = await User.findById(req.params.id).select('name email role');
      if (!tech || tech.role !== ROLES.TECHNICIAN) {
        return res.status(404).json({ success: false, error: 'Technician not found' });
      }

      const [timeouts, jobs] = await Promise.all([
        TechTimeout.find({ technician: req.params.id }).sort({ startDate: -1 }).lean(),
        Job.find({ assignedTechnician: req.params.id })
          .populate('customer', 'name phone email address')
          .sort({ scheduledDate: -1 })
          .lean(),
      ]);

      res.json({
        success: true,
        data: { technician: tech, timeouts, jobs },
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
    body('startDate').notEmpty().withMessage('Start date is required').isISO8601(),
    body('endDate').optional({ values: 'falsy' }).isISO8601(),
    body('reason').optional().trim(),
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

      const start = new Date(req.body.startDate);
      start.setHours(0, 0, 0, 0);
      const end = req.body.endDate ? new Date(req.body.endDate) : new Date(start);
      end.setHours(23, 59, 59, 999);

      if (end < start) {
        return res.status(400).json({ success: false, error: 'End date must be on or after start date' });
      }

      const timeout = await TechTimeout.create({
        technician: techId,
        startDate: start,
        endDate: end,
        reason: req.body.reason || undefined,
      });

      // Notify admin and manager
      const startStr = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const endStr = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

      const isSingleDay = start.toDateString() === end.toDateString();
      const message = isSingleDay
        ? `${techName} is not available on ${startStr}.`
        : `${techName} is not available from ${startStr} to ${endStr}.`;

      createNotification({
        type: 'TECH_TIMEOUT',
        message,
        jobId: null,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      const io = getIO();
      if (io) io.emit('jobs:updated'); // Refresh availability everywhere

      res.status(201).json({ success: true, data: timeout });
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

    await TechTimeout.findByIdAndDelete(req.params.id);

    const io = getIO();
    if (io) io.emit('jobs:updated');

    res.json({ success: true, message: 'Timeout entry deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
