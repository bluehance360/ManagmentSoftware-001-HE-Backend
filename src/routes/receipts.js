const express = require('express');
const { body, param, validationResult } = require('express-validator');
const Job = require('../models/Job');
const Receipt = require('../models/Receipt');
const { authenticate, authorize } = require('../middleware/auth');
const { ROLES, RECEIPT_STATUS, RECEIPT_MAX_PHOTOS } = require('../config/constants');
const { canAccessJob, actorWithRole } = require('../utils/jobAccess');
const {
  buildReceiptKey,
  getUploadUrl,
  getDownloadUrl,
  headObject,
  deleteObject,
} = require('../services/S3Service');
const {
  getRootJobId,
  parseAmountToCents,
  formatCents,
  serializeReceipt,
  listReceiptsForJob,
  RECEIPT_POPULATE,
  describeReceipt,
  notifyReceiptEvent,
  broadcastReceiptsUpdated,
} = require('../services/ReceiptService');

// Mounted at /api/jobs/:id/receipts
//
// Technicians only upload receipt photos. Office staff read the photo, enter the amount,
// and approve / reimburse / reject.
const router = express.Router({ mergeParams: true });
router.use(authenticate);

// Keep in sync with RECEIPT_FILE_EXTENSIONS in web/src/utils/receipts.js
const RECEIPT_FILE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'avif', 'gif', 'bmp', 'tif', 'tiff', 'pdf',
]);
const RECEIPT_MAX_FILE_BYTES = 20 * 1024 * 1024;
const EDITABLE_BY_UPLOADER = [RECEIPT_STATUS.SUBMITTED, RECEIPT_STATUS.REJECTED];
/** The office can enter or correct the amount until the receipt is reimbursed. */
const AMOUNT_EDITABLE = [RECEIPT_STATUS.SUBMITTED, RECEIPT_STATUS.APPROVED];
const STATUS_LABEL = {
  [RECEIPT_STATUS.SUBMITTED]: 'Pending',
  [RECEIPT_STATUS.APPROVED]: 'Approved',
  [RECEIPT_STATUS.REIMBURSED]: 'Reimbursed',
  [RECEIPT_STATUS.REJECTED]: 'Rejected',
};

/** Office actions on a receipt. Reimbursed can be marked straight from Pending. */
const STATUS_ACTIONS = {
  APPROVE: {
    from: [RECEIPT_STATUS.SUBMITTED],
    type: 'JOB_RECEIPT_APPROVED',
    needsAmount: true,
  },
  REIMBURSE: {
    from: [RECEIPT_STATUS.SUBMITTED, RECEIPT_STATUS.APPROVED],
    type: 'JOB_RECEIPT_REIMBURSED',
    needsAmount: true,
  },
  REJECT: {
    from: [RECEIPT_STATUS.SUBMITTED, RECEIPT_STATUS.APPROVED],
    type: 'JOB_RECEIPT_REJECTED',
  },
  UNDO: {
    from: [RECEIPT_STATUS.APPROVED, RECEIPT_STATUS.REIMBURSED, RECEIPT_STATUS.REJECTED],
    type: 'JOB_RECEIPT_STATUS_REVERTED',
  },
};

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sendError(res, error) {
  if (error?.name === 'VersionError') {
    return res.status(409).json({
      success: false,
      error: 'This receipt was just changed by someone else. Refresh and try again.',
    });
  }
  if (error?.name === 'ValidationError') {
    const first = Object.values(error.errors || {})[0];
    return res.status(400).json({ success: false, error: first?.message || error.message });
  }
  return res.status(error?.status || 500).json({ success: false, error: error?.message || 'Server error' });
}

function rejectInvalid(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ success: false, errors: errors.array() });
  return true;
}

function sameId(a, b) {
  const x = a?._id || a;
  const y = b?._id || b;
  return Boolean(x && y) && String(x) === String(y);
}

/**
 * Load the job and check the user can see it. The raw parentJob id is kept (rather than
 * populated) so the family root stays correct even if the parent job was deleted.
 */
async function loadAccessibleJob(req) {
  const job = await Job.findById(req.params.id)
    .select('_id title status assignedTechnician secondaryAssignedTechnician parentJob jobVisitKind')
    .lean();
  if (!job) throw httpError(404, 'Job not found');

  let parent = null;
  if (job.parentJob) {
    parent = await Job.findById(job.parentJob)
      .select('_id assignedTechnician secondaryAssignedTechnician')
      .lean();
  }
  if (!canAccessJob(req.user, { ...job, parentJob: parent })) {
    throw httpError(403, 'Not authorized to view receipts for this job');
  }
  return job;
}

async function loadReceiptInJobFamily(job, receiptId) {
  const receipt = await Receipt.findOne({ _id: receiptId, rootJob: getRootJobId(job) }).populate(RECEIPT_POPULATE);
  if (!receipt) throw httpError(404, 'Receipt not found');
  return receipt;
}

function fileExtension(name) {
  const parts = String(name || '').split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

/** Validate freshly uploaded photo keys for this job and read their real type/size from S3. */
async function resolveUploadedPhotos(items, jobId) {
  const prefix = `jobs/${jobId}/receipts/`;
  const photos = [];
  for (const item of items) {
    const key = String(item?.key || '');
    const fileName = String(item?.fileName || '').trim();
    if (!key.startsWith(prefix)) throw httpError(400, 'Invalid photo for this job');
    if (!fileName) throw httpError(400, 'Photo file name is required');
    let head;
    try {
      head = await headObject(key);
    } catch {
      throw httpError(400, `"${fileName}" did not finish uploading. Please add it again.`);
    }
    photos.push({
      key,
      fileName,
      contentType: head.ContentType || 'application/octet-stream',
      size: Number(head.ContentLength) || 0,
    });
  }
  return photos;
}

const photosValidators = [
  body('photos')
    .isArray({ min: 1, max: RECEIPT_MAX_PHOTOS })
    .withMessage(`Add 1 to ${RECEIPT_MAX_PHOTOS} receipt photos`),
  body('photos.*.key').isString().notEmpty().withMessage('photo key is required'),
  body('photos.*.fileName').isString().notEmpty().withMessage('photo fileName is required'),
];

const amountValidator = (optional) =>
  (optional ? body('amount').optional({ values: 'null' }) : body('amount')).custom((value) => {
    if (parseAmountToCents(value) === null) {
      throw new Error('Enter an amount greater than $0.00 with up to 2 decimals');
    }
    return true;
  });

function jobTitleFor(receipt, job) {
  return receipt.job?.title || job.title;
}

function ownerOf(receipt) {
  return receipt.submittedBy?.name ? `${receipt.submittedBy.name}'s` : 'a';
}

function photoCountLabel(count) {
  return `${count} photo${count === 1 ? '' : 's'}`;
}

/** Record an office-entered amount on the receipt. Returns the previous amount. */
function applyAmount(receipt, cents, user) {
  const previous = receipt.amountCents ?? null;
  receipt.amountCents = cents;
  receipt.amountSetBy = user._id;
  receipt.amountSetAt = new Date();
  return previous;
}

// ── GET /api/jobs/:id/receipts ──────────────────────────────────────
// Everyone who can see the job sees all of its receipts (and its return visits').
router.get('/', [param('id').isMongoId().withMessage('Invalid job ID')], async (req, res) => {
  if (rejectInvalid(req, res)) return;
  try {
    const job = await loadAccessibleJob(req);
    const data = await listReceiptsForJob(job);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error);
  }
});

// ── POST /api/jobs/:id/receipts/presign (TECHNICIAN) ────────────────
router.post(
  '/presign',
  authorize(ROLES.TECHNICIAN),
  [
    param('id').isMongoId().withMessage('Invalid job ID'),
    body('files')
      .isArray({ min: 1, max: RECEIPT_MAX_PHOTOS })
      .withMessage(`Add 1 to ${RECEIPT_MAX_PHOTOS} receipt photos`),
    body('files.*.name').isString().notEmpty().withMessage('file name is required'),
    body('files.*.contentType').optional().isString(),
    body('files.*.size').optional().isInt({ min: 0 }).withMessage('file size must be >= 0'),
  ],
  async (req, res) => {
    if (rejectInvalid(req, res)) return;
    try {
      const job = await loadAccessibleJob(req);
      const files = req.body.files;

      const badType = files.find((f) => !RECEIPT_FILE_EXTENSIONS.has(fileExtension(f.name)));
      if (badType) {
        throw httpError(400, `"${badType.name}" is not a photo or PDF`);
      }
      const tooBig = files.find((f) => Number(f.size) > RECEIPT_MAX_FILE_BYTES);
      if (tooBig) {
        throw httpError(400, `"${tooBig.name}" is larger than 20 MB`);
      }

      const uploads = await Promise.all(
        files.map(async (file) => {
          const key = buildReceiptKey(String(job._id), file.name);
          const contentType = file.contentType || 'application/octet-stream';
          const presignedUrl = await getUploadUrl({ key, contentType, expiresIn: 300 });
          return { key, fileName: file.name, contentType, presignedUrl, expiresIn: 300 };
        })
      );
      res.json({ success: true, data: { uploads } });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ── POST /api/jobs/:id/receipts (TECHNICIAN) ────────────────────────
// Body: { photos: [{ key, fileName }] } - photos only; the office enters the amount.
router.post(
  '/',
  authorize(ROLES.TECHNICIAN),
  [param('id').isMongoId().withMessage('Invalid job ID'), ...photosValidators],
  async (req, res) => {
    if (rejectInvalid(req, res)) return;
    try {
      const job = await loadAccessibleJob(req);
      const photos = await resolveUploadedPhotos(req.body.photos, job._id);

      const receipt = new Receipt({
        job: job._id,
        rootJob: getRootJobId(job),
        submittedBy: req.user._id,
        photos,
        status: RECEIPT_STATUS.SUBMITTED,
        statusHistory: [
          {
            action: 'SUBMIT',
            fromStatus: null,
            toStatus: RECEIPT_STATUS.SUBMITTED,
            changedBy: req.user._id,
          },
        ],
      });
      await receipt.save();
      await receipt.populate(RECEIPT_POPULATE);

      notifyReceiptEvent({
        type: 'JOB_RECEIPT_SUBMITTED',
        message: `${actorWithRole(req.user)} added a receipt (${photoCountLabel(photos.length)}) to job "${job.title}"`,
        job,
        receipt,
        actor: req.user,
      });
      broadcastReceiptsUpdated({ job, receipt });

      res.status(201).json({ success: true, data: await serializeReceipt(receipt) });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ── PATCH /api/jobs/:id/receipts/:receiptId (uploader) ──────────────
// Change the photos (add a page, retake a blurry one). Editing a rejected receipt resubmits it.
router.patch(
  '/:receiptId',
  authorize(ROLES.TECHNICIAN),
  [
    param('id').isMongoId().withMessage('Invalid job ID'),
    param('receiptId').isMongoId().withMessage('Invalid receipt ID'),
    ...photosValidators,
  ],
  async (req, res) => {
    if (rejectInvalid(req, res)) return;
    try {
      const job = await loadAccessibleJob(req);
      const receipt = await loadReceiptInJobFamily(job, req.params.receiptId);
      if (!sameId(receipt.submittedBy, req.user._id)) {
        throw httpError(403, 'You can only edit receipts you uploaded');
      }
      if (!EDITABLE_BY_UPLOADER.includes(receipt.status)) {
        throw httpError(400, `This receipt is already ${STATUS_LABEL[receipt.status].toLowerCase()} and can't be edited`);
      }

      const beforeKeys = receipt.photos.map((p) => p.key).join('|');
      const existingByKey = new Map(receipt.photos.map((p) => [p.key, p]));
      const kept = [];
      const fresh = [];
      for (const item of req.body.photos) {
        const existing = existingByKey.get(String(item?.key || ''));
        if (existing) kept.push(existing.toObject());
        else fresh.push(item);
      }
      // New photos are presigned under the job the tab is open on.
      const added = await resolveUploadedPhotos(fresh, job._id);
      const nextPhotos = [...kept, ...added];
      const nextKeys = new Set(nextPhotos.map((p) => p.key));
      const removedKeys = receipt.photos.map((p) => p.key).filter((key) => !nextKeys.has(key));
      receipt.set('photos', nextPhotos);

      const changed = beforeKeys !== nextPhotos.map((p) => p.key).join('|');
      const wasRejected = receipt.status === RECEIPT_STATUS.REJECTED;
      if (!changed && !wasRejected) {
        return res.json({ success: true, data: await serializeReceipt(receipt) });
      }

      if (wasRejected) {
        receipt.status = RECEIPT_STATUS.SUBMITTED;
        receipt.approvedBy = null;
        receipt.approvedAt = null;
        receipt.rejectedBy = null;
        receipt.rejectedAt = null;
        receipt.rejectionReason = '';
        // A resubmitted receipt is reviewed from scratch - the office enters the amount again.
        receipt.amountCents = null;
        receipt.amountSetBy = null;
        receipt.amountSetAt = null;
      }
      receipt.statusHistory.push({
        action: wasRejected ? 'RESUBMIT' : 'EDIT',
        fromStatus: wasRejected ? RECEIPT_STATUS.REJECTED : RECEIPT_STATUS.SUBMITTED,
        toStatus: RECEIPT_STATUS.SUBMITTED,
        changedBy: req.user._id,
      });
      await receipt.save();
      await Promise.all(removedKeys.map((key) => deleteObject(key).catch(() => null)));

      const title = jobTitleFor(receipt, job);
      notifyReceiptEvent({
        // A resubmitted receipt needs review again, so it notifies like a new one.
        type: wasRejected ? 'JOB_RECEIPT_SUBMITTED' : 'JOB_RECEIPT_UPDATED',
        message: wasRejected
          ? `${actorWithRole(req.user)} resubmitted a rejected ${describeReceipt(receipt)} on job "${title}" (${photoCountLabel(nextPhotos.length)})`
          : `${actorWithRole(req.user)} updated the photos of a ${describeReceipt(receipt)} on job "${title}" (${photoCountLabel(nextPhotos.length)})`,
        job,
        receipt,
        actor: req.user,
      });
      broadcastReceiptsUpdated({ job, receipt });

      res.json({ success: true, data: await serializeReceipt(receipt) });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ── DELETE /api/jobs/:id/receipts/:receiptId (uploader) ─────────────
router.delete(
  '/:receiptId',
  authorize(ROLES.TECHNICIAN),
  [
    param('id').isMongoId().withMessage('Invalid job ID'),
    param('receiptId').isMongoId().withMessage('Invalid receipt ID'),
  ],
  async (req, res) => {
    if (rejectInvalid(req, res)) return;
    try {
      const job = await loadAccessibleJob(req);
      const receipt = await loadReceiptInJobFamily(job, req.params.receiptId);
      if (!sameId(receipt.submittedBy, req.user._id)) {
        throw httpError(403, 'You can only delete receipts you uploaded');
      }
      if (!EDITABLE_BY_UPLOADER.includes(receipt.status)) {
        throw httpError(400, `This receipt is already ${STATUS_LABEL[receipt.status].toLowerCase()} and can't be deleted`);
      }

      const keys = receipt.photos.map((p) => p.key);
      await Receipt.deleteOne({ _id: receipt._id });
      await Promise.all(keys.map((key) => deleteObject(key).catch(() => null)));

      notifyReceiptEvent({
        type: 'JOB_RECEIPT_DELETED',
        message: `${actorWithRole(req.user)} deleted a ${describeReceipt(receipt)} from job "${jobTitleFor(receipt, job)}"`,
        job,
        receipt,
        actor: req.user,
      });
      broadcastReceiptsUpdated({ job, receipt });

      res.json({ success: true });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ── PATCH /api/jobs/:id/receipts/:receiptId/amount (ADMIN, OFFICE_MANAGER) ──
// Enter or correct the receipt total read from the photo.
router.patch(
  '/:receiptId/amount',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    param('id').isMongoId().withMessage('Invalid job ID'),
    param('receiptId').isMongoId().withMessage('Invalid receipt ID'),
    amountValidator(false),
  ],
  async (req, res) => {
    if (rejectInvalid(req, res)) return;
    try {
      const job = await loadAccessibleJob(req);
      const receipt = await loadReceiptInJobFamily(job, req.params.receiptId);
      if (!AMOUNT_EDITABLE.includes(receipt.status)) {
        throw httpError(
          400,
          receipt.status === RECEIPT_STATUS.REIMBURSED
            ? 'This receipt is already reimbursed. Undo the reimbursement to change the amount.'
            : 'This receipt is rejected. Undo the rejection to enter an amount.'
        );
      }

      const cents = parseAmountToCents(req.body.amount);
      if (receipt.amountCents === cents) {
        return res.json({ success: true, data: await serializeReceipt(receipt) });
      }
      const previous = applyAmount(receipt, cents, req.user);
      receipt.statusHistory.push({
        action: 'AMOUNT',
        fromStatus: receipt.status,
        toStatus: receipt.status,
        changedBy: req.user._id,
        note: previous ? `${formatCents(previous)} → ${formatCents(cents)}` : formatCents(cents),
      });
      await receipt.save();
      await receipt.populate(RECEIPT_POPULATE);

      const what = `${ownerOf(receipt)} receipt on job "${jobTitleFor(receipt, job)}"`;
      notifyReceiptEvent({
        type: 'JOB_RECEIPT_UPDATED',
        message: previous
          ? `${actorWithRole(req.user)} changed the amount of ${what} from ${formatCents(previous)} to ${formatCents(cents)}`
          : `${actorWithRole(req.user)} entered ${formatCents(cents)} for ${what}`,
        job,
        receipt,
        actor: req.user,
      });
      broadcastReceiptsUpdated({ job, receipt });

      res.json({ success: true, data: await serializeReceipt(receipt) });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ── PATCH /api/jobs/:id/receipts/:receiptId/status (ADMIN, OFFICE_MANAGER) ──
// action: APPROVE | REIMBURSE | REJECT (reason required) | UNDO
// APPROVE / REIMBURSE need the amount - send `amount` here if it hasn't been entered yet.
router.patch(
  '/:receiptId/status',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    param('id').isMongoId().withMessage('Invalid job ID'),
    param('receiptId').isMongoId().withMessage('Invalid receipt ID'),
    body('action').isIn(Object.keys(STATUS_ACTIONS)).withMessage('Invalid action'),
    body('reason').optional().isString().isLength({ max: 500 }).withMessage('Reason must be 500 characters or less'),
    amountValidator(true),
  ],
  async (req, res) => {
    if (rejectInvalid(req, res)) return;
    try {
      const job = await loadAccessibleJob(req);
      const receipt = await loadReceiptInJobFamily(job, req.params.receiptId);
      const { action } = req.body;
      const rule = STATUS_ACTIONS[action];
      const reason = String(req.body.reason || '').trim();
      const fromStatus = receipt.status;

      if (!rule.from.includes(fromStatus)) {
        throw httpError(
          400,
          `This receipt is ${STATUS_LABEL[fromStatus].toLowerCase()} - it can't be ${
            { APPROVE: 'approved', REIMBURSE: 'marked reimbursed', REJECT: 'rejected', UNDO: 'undone' }[action]
          } now. Refresh to see the latest.`
        );
      }
      if (action === 'REJECT' && !reason) throw httpError(400, 'Add a reason for rejecting this receipt');

      const amountGiven = rule.needsAmount && req.body.amount !== undefined && req.body.amount !== null;
      if (amountGiven) applyAmount(receipt, parseAmountToCents(req.body.amount), req.user);
      if (rule.needsAmount && !receipt.amountCents) {
        throw httpError(400, 'Enter the receipt amount first');
      }

      const now = new Date();
      // Described before the change, so a rejection message still names the amount it cleared.
      const receiptBefore = describeReceipt(receipt);
      const historyExtras = {};
      let toStatus;
      if (action === 'APPROVE') {
        toStatus = RECEIPT_STATUS.APPROVED;
        receipt.approvedBy = req.user._id;
        receipt.approvedAt = now;
      } else if (action === 'REIMBURSE') {
        toStatus = RECEIPT_STATUS.REIMBURSED;
        receipt.reimbursedBy = req.user._id;
        receipt.reimbursedAt = now;
      } else if (action === 'REJECT') {
        toStatus = RECEIPT_STATUS.REJECTED;
        receipt.rejectedBy = req.user._id;
        receipt.rejectedAt = now;
        receipt.rejectionReason = reason;
        // The amount is reset on rejection; when the technician resubmits, the office enters it again.
        if (receipt.amountCents) {
          historyExtras.clearedAmountCents = receipt.amountCents;
          historyExtras.clearedAmountSetBy = receipt.amountSetBy?._id || receipt.amountSetBy || undefined;
          historyExtras.clearedAmountSetAt = receipt.amountSetAt || undefined;
        }
        receipt.amountCents = null;
        receipt.amountSetBy = null;
        receipt.amountSetAt = null;
      } else {
        // UNDO: step back one stage. Reimbursed/rejected return to Approved if it had been approved.
        if (fromStatus === RECEIPT_STATUS.APPROVED) {
          toStatus = RECEIPT_STATUS.SUBMITTED;
          receipt.approvedBy = null;
          receipt.approvedAt = null;
        } else {
          toStatus = receipt.approvedAt ? RECEIPT_STATUS.APPROVED : RECEIPT_STATUS.SUBMITTED;
          if (fromStatus === RECEIPT_STATUS.REIMBURSED) {
            receipt.reimbursedBy = null;
            receipt.reimbursedAt = null;
          } else {
            receipt.rejectedBy = null;
            receipt.rejectedAt = null;
            receipt.rejectionReason = '';
            // Undoing a rejection puts back the amount the rejection cleared.
            const lastReject = [...receipt.statusHistory].reverse().find((h) => h.action === 'REJECT');
            if (lastReject?.clearedAmountCents) {
              receipt.amountCents = lastReject.clearedAmountCents;
              receipt.amountSetBy = lastReject.clearedAmountSetBy || null;
              receipt.amountSetAt = lastReject.clearedAmountSetAt || null;
            }
          }
        }
      }

      receipt.status = toStatus;
      receipt.statusHistory.push({
        action,
        fromStatus,
        toStatus,
        changedBy: req.user._id,
        note: reason || (amountGiven ? `Amount ${formatCents(receipt.amountCents)}` : ''),
        ...historyExtras,
      });
      await receipt.save();
      await receipt.populate(RECEIPT_POPULATE);

      const what = `${ownerOf(receipt)} ${describeReceipt(receipt)} on job "${jobTitleFor(receipt, job)}"`;
      const actor = actorWithRole(req.user);
      const message = {
        APPROVE: `${actor} approved ${what}`,
        REIMBURSE: `${actor} marked ${what} as reimbursed`,
        REJECT: `${actor} rejected ${ownerOf(receipt)} ${receiptBefore} on job "${jobTitleFor(receipt, job)}" - Reason: ${reason}`,
        UNDO: `${actor} moved ${what} back to ${STATUS_LABEL[toStatus]}`,
      }[action];

      notifyReceiptEvent({ type: rule.type, message, job, receipt, actor: req.user });
      broadcastReceiptsUpdated({ job, receipt });

      res.json({ success: true, data: await serializeReceipt(receipt) });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ── GET /api/jobs/:id/receipts/:receiptId/photos/:photoId/url ───────
// Fresh view link (the ones in the list expire after 15 minutes).
router.get(
  '/:receiptId/photos/:photoId/url',
  [
    param('id').isMongoId().withMessage('Invalid job ID'),
    param('receiptId').isMongoId().withMessage('Invalid receipt ID'),
    param('photoId').isMongoId().withMessage('Invalid photo ID'),
  ],
  async (req, res) => {
    if (rejectInvalid(req, res)) return;
    try {
      const job = await loadAccessibleJob(req);
      const receipt = await loadReceiptInJobFamily(job, req.params.receiptId);
      const photo = receipt.photos.id(req.params.photoId);
      if (!photo) throw httpError(404, 'Photo not found');
      const url = await getDownloadUrl({
        key: photo.key,
        fileName: photo.fileName,
        contentType: photo.contentType,
        expiresIn: 900,
      });
      res.json({ success: true, data: { url, fileName: photo.fileName, contentType: photo.contentType } });
    } catch (error) {
      sendError(res, error);
    }
  }
);

module.exports = router;
