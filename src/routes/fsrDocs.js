const express = require('express');
const FsrDocument = require('../models/FsrDocument');
const { authenticate, authorize } = require('../middleware/auth');
const { ROLES } = require('../config/constants');
const { formatFsrDocument } = require('../services/FsrService');

const router = express.Router();

router.use(authenticate);

router.get(
  '/',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const docs = await FsrDocument.find({})
        .populate({
          path: 'job',
          select:
            'title status scheduledDate companyName assignedTechnician secondaryAssignedTechnician parentJob jobVisitKind',
          populate: [
            { path: 'assignedTechnician', select: 'name email' },
            { path: 'secondaryAssignedTechnician', select: 'name email' },
          ],
        })
        .populate('submittedBy', 'name email role')
        .sort({ submittedAt: -1, createdAt: -1 });

      const data = docs
        .filter((doc) => doc.job)
        .map((doc) => {
          const formatted = formatFsrDocument(doc);
          return {
            ...formatted,
            job: formatted.job
              ? {
                  _id: formatted.job._id,
                  title: formatted.job.title,
                  status: formatted.job.status,
                  scheduledDate: formatted.job.scheduledDate || '',
                  companyName: formatted.job.companyName || '',
                  jobVisitKind: formatted.job.jobVisitKind || 'STANDARD',
                  parentJob: formatted.job.parentJob || null,
                  assignedTechnician: formatted.job.assignedTechnician || null,
                  secondaryAssignedTechnician: formatted.job.secondaryAssignedTechnician || null,
                }
              : null,
          };
        });

      return res.json({ success: true, data });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

module.exports = router;
