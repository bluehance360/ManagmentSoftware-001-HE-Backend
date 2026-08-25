const express = require('express');
const { body, param, validationResult } = require('express-validator');
const User = require('../models/User');
const JobType = require('../models/JobType');
const { authenticate, authorize } = require('../middleware/auth');
const { ROLES } = require('../config/constants');
const { sendAccountDeletedEmail } = require('../services/EmailService');
const {
  buildCertificateKey,
  getUploadUrl,
  getDownloadUrl,
  headObject,
  deleteObject,
} = require('../services/S3Service');

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
      const Job = require('../models/Job');
      const { JOB_STATUS } = require('../config/constants');

      const technicians = await User.find({
        role: ROLES.TECHNICIAN,
        isActive: true,
      }).select('name email certificates').lean();

      // Attach active job info so the frontend can show a "Busy" indicator
      const activeJobs = await Job.find({
        $or: [
          { assignedTechnician: { $in: technicians.map((t) => t._id) } },
          { secondaryAssignedTechnician: { $in: technicians.map((t) => t._id) } },
        ],
        status: { $in: [JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS] },
      }).select('assignedTechnician secondaryAssignedTechnician title status').lean();

      const activeJobMap = {};
      for (const j of activeJobs) {
        if (j.assignedTechnician) {
          activeJobMap[j.assignedTechnician.toString()] = { title: j.title, status: j.status };
        }
        if (j.secondaryAssignedTechnician) {
          activeJobMap[j.secondaryAssignedTechnician.toString()] = { title: j.title, status: j.status };
        }
      }

      const enriched = technicians.map((t) => ({
        ...t,
        activeJob: activeJobMap[t._id.toString()] || null,
      }));

      res.json({
        success: true,
        data: enriched,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

// ── Certificate management (ADMIN, OFFICE_MANAGER) ────────────────────
// Allowed file extensions for certificate uploads
const ALLOWED_CERT_EXT = new Set(['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx']);

function isAllowedCertFile(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  return ALLOWED_CERT_EXT.has(ext);
}

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
 * @route   POST /api/users/:id/certificates/presign
 * @desc    Presign one or more certificate uploads to S3
 * @access  Private (ADMIN, OFFICE_MANAGER)
 */
router.post(
  '/:id/certificates/presign',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    param('id').isMongoId().withMessage('Invalid technician ID'),
    body('files').isArray({ min: 1 }).withMessage('files must be a non-empty array'),
    body('files.*.jobTypeId').isMongoId().withMessage('jobTypeId is required'),
    body('files.*.fileName').notEmpty().withMessage('fileName is required'),
    body('files.*.contentType').optional().isString(),
    body('files.*.size').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { tech, error: techErr, status: techStatus } = await loadTechnicianForCerts(req.params.id);
      if (techErr) return res.status(techStatus).json({ success: false, error: techErr });

      const files = req.body.files.slice(0, 10);
      const invalid = files.find((f) => !isAllowedCertFile(f.fileName));
      if (invalid) {
        return res.status(400).json({
          success: false,
          error: `File type not allowed: "${invalid.fileName}". Accepted: PDF, JPG, JPEG, PNG, DOC, DOCX`,
        });
      }

      const uploads = await Promise.all(
        files.map(async (file) => {
          const { type, error: typeErr, status: typeStatus } = await loadCertifiableJobType(file.jobTypeId);
          if (typeErr) {
            const err = new Error(typeErr);
            err.status = typeStatus;
            throw err;
          }
          const key = buildCertificateKey(tech._id.toString(), type._id.toString(), file.fileName);
          const contentType = file.contentType || 'application/octet-stream';
          const presignedUrl = await getUploadUrl({ key, contentType, expiresIn: 300 });
          return {
            jobTypeId: type._id,
            jobTypeName: type.name,
            key,
            fileName: file.fileName,
            contentType,
            size: Number(file.size) || 0,
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

/**
 * @route   POST /api/users/:id/certificates/complete
 * @desc    Confirm S3 uploads and persist cert entries on the technician
 * @access  Private (ADMIN, OFFICE_MANAGER)
 */
router.post(
  '/:id/certificates/complete',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    param('id').isMongoId().withMessage('Invalid technician ID'),
    body('entries').isArray({ min: 1 }).withMessage('entries must be a non-empty array'),
    body('entries.*.jobTypeId').isMongoId().withMessage('jobTypeId is required'),
    body('entries.*.key').notEmpty().withMessage('key is required'),
    body('entries.*.fileName').notEmpty().withMessage('fileName is required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { tech, error: techErr, status: techStatus } = await loadTechnicianForCerts(req.params.id);
      if (techErr) return res.status(techStatus).json({ success: false, error: techErr });

      const incoming = req.body.entries.slice(0, 10);
      const replacedKeys = [];

      for (const item of incoming) {
        const { type, error: typeErr, status: typeStatus } = await loadCertifiableJobType(item.jobTypeId);
        if (typeErr) return res.status(typeStatus).json({ success: false, error: typeErr });

        const expectedPrefix = `users/${tech._id}/certificates/${type._id}/`;
        if (!item.key.startsWith(expectedPrefix)) {
          return res.status(400).json({
            success: false,
            error: `Invalid certificate key for ${type.name}`,
          });
        }

        const meta = await headObject(item.key);

        const existingIdx = tech.certificates.findIndex(
          (c) => c.jobTypeId.toString() === type._id.toString()
        );
        if (existingIdx !== -1) {
          replacedKeys.push(tech.certificates[existingIdx].document?.key);
          tech.certificates.splice(existingIdx, 1);
        }
        tech.certificates.push({
          jobTypeId: type._id,
          jobTypeName: type.name,
          document: {
            key: item.key,
            fileName: item.fileName,
            contentType: meta.ContentType || 'application/octet-stream',
            size: Number(meta.ContentLength) || 0,
          },
          uploadedAt: new Date(),
          uploadedBy: req.user._id,
        });
      }

      await tech.save();

      // Best-effort cleanup of replaced S3 objects
      await Promise.all(
        replacedKeys.filter(Boolean).map((key) => deleteObject(key).catch(() => null))
      );

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
