const mongoose = require('mongoose');
const Receipt = require('../models/Receipt');
const { ROLES, RECEIPT_STATUS, RECEIPT_MAX_AMOUNT_CENTS } = require('../config/constants');
const { createNotification } = require('./NotificationService');
const { emitToUsers } = require('../socket');
const { getDownloadUrl, deleteObject } = require('./S3Service');

const MANAGER_ROLES = [ROLES.ADMIN, ROLES.OFFICE_MANAGER];

/** Receipts of a job and its return visits share one list, keyed by the original job. */
function getRootJobId(job) {
  const raw = job?.parentJob?._id || job?.parentJob || job?._id;
  return raw ? String(raw) : '';
}

/**
 * "42.18", "$1,234.5", 42.18 → whole cents. Returns null for anything that isn't a positive
 * amount with at most two decimals, or that exceeds the cap.
 */
function parseAmountToCents(input) {
  if (input === null || input === undefined) return null;
  const text = String(input).trim().replace(/^\$/, '').replace(/,/g, '');
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > RECEIPT_MAX_AMOUNT_CENTS) return null;
  return cents;
}

function formatCents(cents) {
  const value = (Number(cents) || 0) / 100;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Totals in cents. Rejected receipts are counted separately and left out of the total;
 * receipts whose amount the office hasn't entered yet are counted in `unpricedCount`.
 */
function summarizeReceipts(receipts) {
  const summary = {
    count: 0,
    totalCents: 0,
    unpricedCount: 0,
    pendingCount: 0,
    pendingCents: 0,
    approvedCount: 0,
    approvedCents: 0,
    reimbursedCount: 0,
    reimbursedCents: 0,
    rejectedCount: 0,
    rejectedCents: 0,
  };
  for (const r of receipts || []) {
    const cents = Number(r.amountCents) || 0;
    summary.count += 1;
    if (r.status === RECEIPT_STATUS.REJECTED) {
      summary.rejectedCount += 1;
      summary.rejectedCents += cents;
      continue;
    }
    summary.totalCents += cents;
    if (r.amountCents === null || r.amountCents === undefined) summary.unpricedCount += 1;
    if (r.status === RECEIPT_STATUS.SUBMITTED) {
      summary.pendingCount += 1;
      summary.pendingCents += cents;
    } else if (r.status === RECEIPT_STATUS.APPROVED) {
      summary.approvedCount += 1;
      summary.approvedCents += cents;
    } else if (r.status === RECEIPT_STATUS.REIMBURSED) {
      summary.reimbursedCount += 1;
      summary.reimbursedCents += cents;
    }
  }
  return summary;
}

/** Summary for the job detail response (Receipts tab badge). */
async function getReceiptSummaryForJob(job) {
  const rootId = getRootJobId(job);
  if (!rootId || !mongoose.isValidObjectId(rootId)) return summarizeReceipts([]);
  const receipts = await Receipt.find({ rootJob: rootId }).select('amountCents status').lean();
  return summarizeReceipts(receipts);
}

/** Remove a deleted job's receipts and their photos. */
async function deleteReceiptsForJob(jobId) {
  const receipts = await Receipt.find({ job: jobId }).select('photos').lean();
  if (!receipts.length) return;
  const keys = receipts.flatMap((r) => (r.photos || []).map((p) => p.key).filter(Boolean));
  await Receipt.deleteMany({ job: jobId });
  await Promise.all(keys.map((key) => deleteObject(key).catch(() => null)));
}

function personSummary(user) {
  if (!user) return null;
  if (!user._id) return { _id: String(user) };
  return { _id: String(user._id), name: user.name, role: user.role };
}

/** API shape of a receipt; photo view links are presigned for 15 minutes. */
async function serializeReceipt(receipt) {
  const r = typeof receipt.toObject === 'function' ? receipt.toObject() : receipt;
  const photos = await Promise.all(
    (r.photos || []).map(async (photo) => {
      let url = null;
      try {
        url = await getDownloadUrl({
          key: photo.key,
          fileName: photo.fileName,
          contentType: photo.contentType,
          expiresIn: 900,
        });
      } catch {
        url = null;
      }
      return {
        _id: String(photo._id),
        key: photo.key,
        fileName: photo.fileName,
        contentType: photo.contentType,
        size: photo.size,
        url,
      };
    })
  );
  const jobRef = r.job && r.job._id
    ? {
        _id: String(r.job._id),
        title: r.job.title,
        scheduledDate: r.job.scheduledDate,
        jobVisitKind: r.job.jobVisitKind,
      }
    : { _id: String(r.job) };

  return {
    _id: String(r._id),
    job: jobRef,
    rootJob: String(r.rootJob),
    submittedBy: personSummary(r.submittedBy),
    amountCents: r.amountCents ?? null,
    amountSetBy: personSummary(r.amountSetBy),
    amountSetAt: r.amountSetAt || null,
    photos,
    status: r.status,
    approvedBy: personSummary(r.approvedBy),
    approvedAt: r.approvedAt,
    reimbursedBy: personSummary(r.reimbursedBy),
    reimbursedAt: r.reimbursedAt,
    rejectedBy: personSummary(r.rejectedBy),
    rejectedAt: r.rejectedAt,
    rejectionReason: r.rejectionReason || '',
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const RECEIPT_POPULATE = [
  { path: 'submittedBy', select: 'name role' },
  { path: 'amountSetBy', select: 'name role' },
  { path: 'approvedBy', select: 'name role' },
  { path: 'reimbursedBy', select: 'name role' },
  { path: 'rejectedBy', select: 'name role' },
  { path: 'job', select: 'title scheduledDate jobVisitKind assignedTechnician secondaryAssignedTechnician' },
];

/** Every receipt of the job family, newest first, with totals. */
async function listReceiptsForJob(job) {
  const rootId = getRootJobId(job);
  const receipts = await Receipt.find({ rootJob: rootId })
    .sort({ createdAt: -1 })
    .populate(RECEIPT_POPULATE);
  return {
    receipts: await Promise.all(receipts.map(serializeReceipt)),
    summary: summarizeReceipts(receipts),
  };
}

function idOf(value) {
  const raw = value?._id || value;
  return raw ? String(raw) : '';
}

/** Technicians on the job and on the visit the receipt was uploaded on, plus the uploader. */
function receiptTechnicianIds(job, receipt) {
  const receiptJob = receipt?.job && typeof receipt.job === 'object' ? receipt.job : null;
  const ids = [
    idOf(job?.assignedTechnician),
    idOf(job?.secondaryAssignedTechnician),
    idOf(receiptJob?.assignedTechnician),
    idOf(receiptJob?.secondaryAssignedTechnician),
    idOf(receipt?.submittedBy),
  ].filter(Boolean);
  return [...new Set(ids)];
}

/** "$42.18 receipt", or just "receipt" before the office has entered the amount. */
function describeReceipt(receipt) {
  return receipt.amountCents ? `${formatCents(receipt.amountCents)} receipt` : 'receipt';
}

/**
 * Notify everyone who works with the job's receipts - all Admins / Office Managers and the
 * job's technicians - except the person who acted. In-app + live toast + web push, and
 * email for the types allowlisted in EmailNotificationService.
 */
function notifyReceiptEvent({ type, message, job, receipt, actor }) {
  return createNotification({
    type,
    message,
    jobId: idOf(receipt.job) || idOf(job),
    meta: {
      receiptId: String(receipt._id),
      amountCents: receipt.amountCents,
      receiptStatus: receipt.status,
      tab: 'receipts',
    },
    recipientIds: receiptTechnicianIds(job, receipt),
    recipientRoles: MANAGER_ROLES,
    excludeUserId: actor._id,
  });
}

/** Tell open Receipts tabs (office staff + the job's technicians) to refresh. */
function broadcastReceiptsUpdated({ job, receipt }) {
  emitToUsers({
    event: 'receipts:updated',
    data: {
      jobId: idOf(receipt?.job) || idOf(job),
      rootJobId: idOf(receipt?.rootJob) || getRootJobId(job),
    },
    recipientIds: receiptTechnicianIds(job, receipt),
    recipientRoles: MANAGER_ROLES,
  });
}

module.exports = {
  getRootJobId,
  parseAmountToCents,
  formatCents,
  summarizeReceipts,
  getReceiptSummaryForJob,
  deleteReceiptsForJob,
  serializeReceipt,
  listReceiptsForJob,
  RECEIPT_POPULATE,
  describeReceipt,
  notifyReceiptEvent,
  broadcastReceiptsUpdated,
};
