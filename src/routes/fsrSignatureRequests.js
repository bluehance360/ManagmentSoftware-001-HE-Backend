const express = require('express');
const FsrDocument = require('../models/FsrDocument');
const FsrSignatureRequest = require('../models/FsrSignatureRequest');
const Job = require('../models/Job');
const { ROLES } = require('../config/constants');
const { createNotification } = require('../services/NotificationService');
const { emitToUsers } = require('../socket');
const {
  FSR_SIGNATURE_REQUEST_STATUS,
  buildSignatureRequestSummary,
  expireRequestIfNeeded,
} = require('../services/FsrSignatureRequestService');

const router = express.Router();

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function ensureSignatureDataUrl(value) {
  const normalized = trimString(value);
  if (!normalized) {
    const error = new Error('Signature is required');
    error.status = 400;
    throw error;
  }
  if (!normalized.startsWith('data:image/')) {
    const error = new Error('Signature must be a captured signature image');
    error.status = 400;
    throw error;
  }
  return normalized;
}

function toObjectIdString(value) {
  const raw = value?._id || value;
  return raw ? String(raw) : '';
}

function getVisibleTechnicianRecipientIds(job, fsrDoc) {
  if (!fsrDoc?.technicianVisible) return [];
  return [job?.assignedTechnician, job?.secondaryAssignedTechnician]
    .map((entry) => toObjectIdString(entry))
    .filter(Boolean);
}

function buildVerifyPayload(request, options = {}) {
  const summary = buildSignatureRequestSummary(request);
  return {
    valid: Boolean(options.valid),
    status: request.status,
    message: options.message || '',
    request: summary,
    signatureFieldKey: request.signatureFieldKey,
    signatureFieldLabel: request.signatureFieldLabel,
    sectionLabel: summary?.fieldContext?.sectionLabel || '',
    requestedByName: request.requestedByName,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
    job: request.jobSnapshot || {},
    fieldContext: request.fieldContext || {},
  };
}

router.get('/verify/:token', async (req, res) => {
  try {
    const request = await FsrSignatureRequest.findOne({ token: req.params.token });
    if (!request) {
      return res.status(404).json({
        success: false,
        error: 'Invalid signature link',
      });
    }

    await expireRequestIfNeeded(request);

    if (request.status === FSR_SIGNATURE_REQUEST_STATUS.PENDING) {
      return res.json({
        success: true,
        data: buildVerifyPayload(request, { valid: true }),
      });
    }

    const messageMap = {
      [FSR_SIGNATURE_REQUEST_STATUS.COMPLETED]: 'This signature has already been submitted.',
      [FSR_SIGNATURE_REQUEST_STATUS.REPLACED]: 'This signature link has been replaced by a newer request.',
      [FSR_SIGNATURE_REQUEST_STATUS.CANCELLED]: 'This signature request is no longer active.',
      [FSR_SIGNATURE_REQUEST_STATUS.EXPIRED]: 'This signature link has expired.',
    };

    return res.json({
      success: true,
      data: buildVerifyPayload(request, {
        valid: false,
        message: messageMap[request.status] || 'This signature request is no longer active.',
      }),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/:token/submit', async (req, res) => {
  try {
    const request = await FsrSignatureRequest.findOne({ token: req.params.token });
    if (!request) {
      return res.status(404).json({ success: false, error: 'Invalid signature link' });
    }

    await expireRequestIfNeeded(request);

    if (request.status !== FSR_SIGNATURE_REQUEST_STATUS.PENDING) {
      const messageMap = {
        [FSR_SIGNATURE_REQUEST_STATUS.COMPLETED]: 'This signature has already been submitted.',
        [FSR_SIGNATURE_REQUEST_STATUS.REPLACED]: 'This signature link has been replaced by a newer request.',
        [FSR_SIGNATURE_REQUEST_STATUS.CANCELLED]: 'This signature request is no longer active.',
        [FSR_SIGNATURE_REQUEST_STATUS.EXPIRED]: 'This signature link has expired.',
      };
      return res.status(400).json({
        success: false,
        error: messageMap[request.status] || 'This signature request is no longer active.',
      });
    }

    const signatureValue = ensureSignatureDataUrl(req.body?.signature);
    const fsrDoc = await FsrDocument.findById(request.fsrDocument);
    if (!fsrDoc) {
      return res.status(404).json({ success: false, error: 'FSR document not found' });
    }
    if (fsrDoc.status === 'SUBMITTED') {
      request.status = FSR_SIGNATURE_REQUEST_STATUS.CANCELLED;
      await request.save();
      return res.status(400).json({
        success: false,
        error: 'This FSR has already been submitted.',
      });
    }

    const job = await Job.findById(request.job)
      .select('_id title assignedTechnician secondaryAssignedTechnician')
      .populate('assignedTechnician', 'name email')
      .populate('secondaryAssignedTechnician', 'name email');

    fsrDoc.draftSignatures = {
      ...(fsrDoc.draftSignatures?.toObject ? fsrDoc.draftSignatures.toObject() : fsrDoc.draftSignatures || {}),
      [request.signatureFieldKey]: signatureValue,
    };
    await fsrDoc.save();

    request.status = FSR_SIGNATURE_REQUEST_STATUS.COMPLETED;
    request.completedAt = new Date();
    await request.save();

    const recipientIds = job ? getVisibleTechnicianRecipientIds(job, fsrDoc) : [];
    const notificationMessage = `An external signer completed ${request.signatureFieldLabel} for job "${request.jobSnapshot?.projectName || job?.title || 'Untitled job'}".`;

    createNotification({
      type: 'JOB_FSR_SIGNATURE_COMPLETED',
      message: notificationMessage,
      jobId: job?._id || request.job,
      recipientIds,
      recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
    });

    emitToUsers({
      event: 'fsr:signature-updated',
      data: {
        jobId: String(request.job),
        fsrDocumentId: String(request.fsrDocument),
        signatureFieldKey: request.signatureFieldKey,
        signatureValue,
        request: buildSignatureRequestSummary(request),
      },
      recipientIds,
      recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
    });
    emitToUsers({
      event: 'jobs:updated',
      data: { jobId: String(request.job) },
      recipientIds,
      recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
    });

    return res.json({
      success: true,
      message: 'Signature submitted successfully',
      data: {
        signatureFieldKey: request.signatureFieldKey,
        signatureValue,
        request: buildSignatureRequestSummary(request),
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

module.exports = router;
