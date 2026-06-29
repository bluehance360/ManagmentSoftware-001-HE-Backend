const express = require('express');
const FsrDocument = require('../models/FsrDocument');
const FsrSignatureRequest = require('../models/FsrSignatureRequest');
const { authenticate, authorize } = require('../middleware/auth');
const { ROLES } = require('../config/constants');
const { formatFsrDocument, FSR_STATUS } = require('../services/FsrService');
const { getIO } = require('../socket');

const router = express.Router();

router.use(authenticate);

function isFsrSeenBy(doc, userId) {
  if (!doc || doc.status !== FSR_STATUS.SUBMITTED) return true;
  const uid = String(userId);
  return (doc.seenBy || []).some((id) => String(id) === uid);
}

router.get(
  '/',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const docs = await FsrDocument.find({})
        .populate({
          path: 'job',
          select:
            'title status scheduledDate companyName customer customerName assignedTechnician secondaryAssignedTechnician parentJob jobVisitKind',
          populate: [
            { path: 'assignedTechnician', select: 'name email' },
            { path: 'secondaryAssignedTechnician', select: 'name email' },
            { path: 'customer', select: 'name' },
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
            seen: isFsrSeenBy(doc, req.user._id),
            job: formatted.job
              ? {
                  _id: formatted.job._id,
                  title: formatted.job.title,
                  status: formatted.job.status,
                  scheduledDate: formatted.job.scheduledDate || '',
                  companyName: formatted.job.companyName || '',
                  customerName:
                    formatted.job.customer?.name || formatted.job.customerName || '',
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

// ── GET /api/fsr-docs/unseen-count ──────────────────────────────────
router.get(
  '/unseen-count',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const count = await FsrDocument.countDocuments({
        status: FSR_STATUS.SUBMITTED,
        seenBy: { $ne: req.user._id },
      });
      return res.json({ success: true, data: { count } });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── DELETE /api/fsr-docs/:id ────────────────────────────────────────
// Resets the FSR to an empty NOT_STARTED state so the attached job must fill it again.
router.delete(
  '/:id',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const doc = await FsrDocument.findById(req.params.id);
      if (!doc) {
        return res.status(404).json({ success: false, error: 'FSR document not found' });
      }

      await FsrSignatureRequest.updateMany(
        { fsrDocument: doc._id, status: 'PENDING' },
        { $set: { status: 'CANCELLED' } }
      );

      doc.status = FSR_STATUS.NOT_STARTED;
      doc.submissionData = undefined;
      doc.draftSignatures = {};
      doc.assets = [];
      doc.jobSnapshot = undefined;
      doc.submittedBy = null;
      doc.submittedAt = null;
      doc.seenBy = [];
      await doc.save();

      const io = getIO();
      if (io) io.emit('jobs:updated');

      return res.json({ success: true, data: { _id: String(doc._id) } });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

module.exports = router;
