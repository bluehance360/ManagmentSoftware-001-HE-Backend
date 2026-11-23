const express = require('express');
const { body, param, validationResult } = require('express-validator');
const User = require('../models/User');
const JobType = require('../models/JobType');
const { authenticate, authorize } = require('../middleware/auth');
const { ROLES } = require('../config/constants');
const { sendAccountDeletedEmail } = require('../services/EmailService');
const { getDownloadUrl, deleteObject } = require('../services/S3Service');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

/**
 * @route   GET /api/users
 * @desc    Get all users (Admin only)
 * @access  Private (ADMIN)
 */
router.get('/', authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER), async (req, res) => {
  try {
    const { role, isActive } = req.query;

    let filter = {};
    if (role) filter.role = role;
    if (isActive !== undefined) filter.isActive = isActive === 'true';

    const users = await User.find(filter).sort({ createdAt: -1 });

    res.json({
      success: true,
      data: users,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @route   GET /api/users/technicians
 * @desc    Get all technicians (for job assignment)
 * @access  Private (ADMIN, OFFICE_MANAGER)
 */
router.get(
  '/technicians',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      // Techs can hold multiple jobs at once, so no "busy" flag here; availability
      // for a date comes from approved time-off (GET /api/tech-timeouts/availability).
      const technicians = await User.find({
        role: ROLES.TECHNICIAN,
        isActive: true,
      }).select('name email certificates').lean();

      res.json({
        success: true,
        data: technicians,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

// ── Certification management (ADMIN, OFFICE_MANAGER) ──────────────────
// A technician is certified for a job type when they have a `certificates` entry for it.
// Certifications are marked directly - no certificate document is required.

async function loadCertifiableJobType(jobTypeId) {
  const type = await JobType.findById(jobTypeId).lean();
  if (!type) return { error: 'Job type not found', status: 404 };
  if (!type.certificationRequired) {
    return {
      error: `Job type "${type.name}" does not require certification`,
      status: 400,
    };
  }
  return { type };
}

async function loadTechnicianForCerts(id) {
  const tech = await User.findById(id);
  if (!tech) return { error: 'Technician not found', status: 404 };
  if (tech.role !== ROLES.TECHNICIAN) {
    return { error: 'Certificates only apply to technicians', status: 400 };
  }
  return { tech };
}

/**
 * @route   POST /api/users/:id/certificates
 * @desc    Mark a technician as certified for one or more job types (no document needed)
 * @access  Private (ADMIN, OFFICE_MANAGER)
 */
router.post(
  '/:id/certificates',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    param('id').isMongoId().withMessage('Invalid technician ID'),
    body('jobTypeIds').isArray({ min: 1 }).withMessage('Select at least one job type'),
    body('jobTypeIds.*').isMongoId().withMessage('Invalid job type ID'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { tech, error: techErr, status: techStatus } = await loadTechnicianForCerts(req.params.id);
      if (techErr) return res.status(techStatus).json({ success: false, error: techErr });

      const jobTypeIds = [...new Set(req.body.jobTypeIds.map(String))].slice(0, 50);
      for (const jobTypeId of jobTypeIds) {
        const { type, error: typeErr, status: typeStatus } = await loadCertifiableJobType(jobTypeId);
        if (typeErr) return res.status(typeStatus).json({ success: false, error: typeErr });

        // Already certified (with or without a document) - leave the existing entry as is.
        const alreadyCertified = tech.certificates.some(
          (c) => c.jobTypeId.toString() === type._id.toString()
        );
        if (alreadyCertified) continue;

        tech.certificates.push({
          jobTypeId: type._id,
          jobTypeName: type.name,
          uploadedAt: new Date(),
          uploadedBy: req.user._id,
        });
      }

      await tech.save();
      res.json({ success: true, data: { certificates: tech.certificates } });
    } catch (error) {
      const status = error.status || 500;
      res.status(status).json({ success: false, error: error.message });
    }
  }
);

/**
 * @route   GET /api/users/:id/certificates/:jobTypeId/download
 * @desc    Get a presigned URL to view a technician's certificate
 * @access  Private (ADMIN, OFFICE_MANAGER)
 */
router.get(
  '/:id/certificates/:jobTypeId/download',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    param('id').isMongoId().withMessage('Invalid technician ID'),
    param('jobTypeId').isMongoId().withMessage('Invalid job type ID'),
  ],
  async (req, res) => {
    try {
      const tech = await User.findById(req.params.id).select('certificates role').lean();
      if (!tech || tech.role !== ROLES.TECHNICIAN) {
        return res.status(404).json({ success: false, error: 'Technician not found' });
      }
      const cert = (tech.certificates || []).find(
        (c) => c.jobTypeId.toString() === req.params.jobTypeId
      );
      if (!cert) {
        return res.status(404).json({ success: false, error: 'Certificate not found' });
      }
      if (!cert.document?.key) {
        return res.status(404).json({
          success: false,
          error: 'No certificate document is attached to this certification',
        });
      }
      const url = await getDownloadUrl({
        key: cert.document.key,
        fileName: cert.document.fileName,
        expiresIn: 900,
      });
      res.json({
        success: true,
        data: { url, fileName: cert.document.fileName, contentType: cert.document.contentType },
      });
    } catch (error) {
      const status = error.status || 500;
      res.status(status).json({ success: false, error: error.message });
    }
  }
);

/**
 * @route   DELETE /api/users/:id/certificates/:jobTypeId
 * @desc    Remove a technician's certificate for a job type
 * @access  Private (ADMIN, OFFICE_MANAGER)
 */
router.delete(
  '/:id/certificates/:jobTypeId',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    param('id').isMongoId().withMessage('Invalid technician ID'),
    param('jobTypeId').isMongoId().withMessage('Invalid job type ID'),
  ],
  async (req, res) => {
    try {
      const tech = await User.findById(req.params.id);
      if (!tech || tech.role !== ROLES.TECHNICIAN) {
        return res.status(404).json({ success: false, error: 'Technician not found' });
      }
      const idx = tech.certificates.findIndex(
        (c) => c.jobTypeId.toString() === req.params.jobTypeId
      );
      if (idx === -1) {
        return res.status(404).json({ success: false, error: 'Certificate not found' });
      }
      const removed = tech.certificates[idx];
      tech.certificates.splice(idx, 1);
      await tech.save();

      if (removed.document?.key) {
        deleteObject(removed.document.key).catch(() => null);
      }

      res.json({ success: true, data: { certificates: tech.certificates } });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/**
 * @route   GET /api/users/:id
 * @desc    Get user by ID
 * @access  Private (ADMIN)
 */
router.get('/:id', authorize(ROLES.ADMIN), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @route   DELETE /api/users/:id
 * @desc    Delete a user account (Admin only)
 * @access  Private (ADMIN)
 */
router.delete('/:id', authorize(ROLES.ADMIN), async (req, res) => {
  try {
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ success: false, error: 'You cannot delete your own account' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    await User.findByIdAndDelete(req.params.id);

    // Notify the deleted user - non-blocking
    sendAccountDeletedEmail({ to: user.email, name: user.name }).catch((err) =>
      console.error('Failed to send account deleted email:', err.message)
    );

    res.json({ success: true, message: `Account for ${user.name} has been deleted` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
