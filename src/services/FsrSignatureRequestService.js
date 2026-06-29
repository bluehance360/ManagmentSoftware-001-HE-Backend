const FsrSignatureRequest = require('../models/FsrSignatureRequest');
const { FSR_TEMPLATE } = require('./FsrService');

const FSR_SIGNATURE_REQUEST_STATUS = {
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  REPLACED: 'REPLACED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
};

const FSR_SIGNATURE_FIELD_KEY = {
  STANDARD_TRAINING: 'standard.training.traineeSignature',
  STANDARD_CLIENT_ACCEPTANCE: 'standard.clientAcceptance.acceptorSignature',
  WATTSTOPPER_TRAINING: 'wattstopper.training.traineeSignature',
  WATTSTOPPER_FINAL: 'wattstopper.reportReceivedBy.signature',
  KORE_ELECTRICAL: 'kore.electricalContractor.signature',
  KORE_OWNER: 'kore.ownerRepresentative.signature',
};

const SIGNATURE_REQUEST_DEFINITIONS = {
  [FSR_SIGNATURE_FIELD_KEY.STANDARD_TRAINING]: {
    key: FSR_SIGNATURE_FIELD_KEY.STANDARD_TRAINING,
    templateKey: FSR_TEMPLATE.STANDARD,
    label: 'Trainee Signature',
    sectionLabel: 'Training',
    contextFields: [
      { key: 'traineeName', label: 'Trainee Name' },
      { key: 'traineeCompany', label: 'Trainee Company' },
    ],
  },
  [FSR_SIGNATURE_FIELD_KEY.STANDARD_CLIENT_ACCEPTANCE]: {
    key: FSR_SIGNATURE_FIELD_KEY.STANDARD_CLIENT_ACCEPTANCE,
    templateKey: FSR_TEMPLATE.STANDARD,
    label: 'Acceptor Signature',
    sectionLabel: 'Client Acceptance',
    contextFields: [
      { key: 'acceptorName', label: 'Acceptor Name' },
      { key: 'acceptorCompany', label: 'Acceptor Company' },
    ],
  },
  [FSR_SIGNATURE_FIELD_KEY.WATTSTOPPER_TRAINING]: {
    key: FSR_SIGNATURE_FIELD_KEY.WATTSTOPPER_TRAINING,
    templateKey: FSR_TEMPLATE.WATTSTOPPER,
    label: 'Trainee Signature',
    sectionLabel: 'Site Contact & Training',
    contextFields: [
      { key: 'traineeName', label: 'Trainee Name' },
      { key: 'traineeCompany', label: 'Trainee Company' },
    ],
  },
  [FSR_SIGNATURE_FIELD_KEY.WATTSTOPPER_FINAL]: {
    key: FSR_SIGNATURE_FIELD_KEY.WATTSTOPPER_FINAL,
    templateKey: FSR_TEMPLATE.WATTSTOPPER,
    label: 'Report Received By Signature',
    sectionLabel: 'Final Signature',
    contextFields: [
      { key: 'name', label: 'Name' },
      { key: 'title', label: 'Title' },
      { key: 'company', label: 'Company' },
    ],
  },
  [FSR_SIGNATURE_FIELD_KEY.KORE_ELECTRICAL]: {
    key: FSR_SIGNATURE_FIELD_KEY.KORE_ELECTRICAL,
    templateKey: FSR_TEMPLATE.KORE,
    label: 'Electrical Contractor Signature',
    sectionLabel: 'Sign-Off',
    contextFields: [{ key: 'name', label: 'Electrical Contractor Name' }],
  },
  [FSR_SIGNATURE_FIELD_KEY.KORE_OWNER]: {
    key: FSR_SIGNATURE_FIELD_KEY.KORE_OWNER,
    templateKey: FSR_TEMPLATE.KORE,
    label: "Owner's Representative Signature",
    sectionLabel: 'Sign-Off',
    contextFields: [{ key: 'name', label: "Owner's Representative Name" }],
  },
};

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getSignatureRequestDefinition(templateKey, signatureFieldKey) {
  const definition = SIGNATURE_REQUEST_DEFINITIONS[signatureFieldKey];
  if (!definition) return null;
  return definition.templateKey === templateKey ? definition : null;
}

function sanitizeSignatureRequestContext(signatureFieldKey, rawContext) {
  const definition = SIGNATURE_REQUEST_DEFINITIONS[signatureFieldKey];
  if (!definition) {
    const error = new Error('Unsupported FSR signature field');
    error.status = 400;
    throw error;
  }

  const context = rawContext && typeof rawContext === 'object' ? rawContext : {};
  const sanitized = {};

  definition.contextFields.forEach((field) => {
    const value = trimString(context[field.key]);
    if (!value) {
      const error = new Error(`${field.label} is required before requesting a signature`);
      error.status = 400;
      throw error;
    }
    sanitized[field.key] = value;
  });

  return sanitized;
}

function calculateSignatureRequestCooldownSeconds(sendCount) {
  const normalized = Number.isFinite(Number(sendCount)) ? Number(sendCount) : 1;
  return Math.max(1, normalized) * 30;
}

function buildSignatureRequestNextSendAllowedAt(sendCount, fromDate = new Date()) {
  return new Date(fromDate.getTime() + calculateSignatureRequestCooldownSeconds(sendCount) * 1000);
}

function normalizeDraftSignaturesObject(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.entries(value).reduce((acc, [key, raw]) => {
    const normalized = trimString(raw);
    if (normalized) acc[key] = normalized;
    return acc;
  }, {});
}

function getDraftSignatureValue(fsrDoc, signatureFieldKey) {
  const normalized = normalizeDraftSignaturesObject(fsrDoc?.draftSignatures);
  return normalized[signatureFieldKey] || '';
}

function buildSignatureRequestSummary(request) {
  if (!request) return null;
  return {
    _id: request._id,
    fsrDocument: request.fsrDocument,
    job: request.job,
    templateKey: request.templateKey,
    signatureFieldKey: request.signatureFieldKey,
    signatureFieldLabel: request.signatureFieldLabel,
    recipientEmail: request.recipientEmail,
    status: request.status,
    requestedBy: request.requestedBy,
    requestedByName: request.requestedByName,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
    sendCount: request.sendCount,
    lastSentAt: request.lastSentAt,
    nextSendAllowedAt: request.nextSendAllowedAt,
    completedAt: request.completedAt,
    fieldContext: request.fieldContext || {},
    jobSnapshot: request.jobSnapshot || {},
  };
}

async function expireRequestIfNeeded(request) {
  if (!request || request.status !== FSR_SIGNATURE_REQUEST_STATUS.PENDING) return request;
  if (!request.expiresAt || request.expiresAt > new Date()) return request;
  request.status = FSR_SIGNATURE_REQUEST_STATUS.EXPIRED;
  await request.save();
  return request;
}

async function getLatestSignatureRequestsByField(fsrDocumentId) {
  if (!fsrDocumentId) return {};
  const requests = await FsrSignatureRequest.find({ fsrDocument: fsrDocumentId })
    .sort({ createdAt: -1, _id: -1 })
    .lean();

  const state = {};
  for (const request of requests) {
    if (!request?.signatureFieldKey || state[request.signatureFieldKey]) continue;
    if (
      request.status === FSR_SIGNATURE_REQUEST_STATUS.PENDING &&
      request.expiresAt &&
      new Date(request.expiresAt) <= new Date()
    ) {
      await FsrSignatureRequest.updateOne(
        { _id: request._id, status: FSR_SIGNATURE_REQUEST_STATUS.PENDING },
        { $set: { status: FSR_SIGNATURE_REQUEST_STATUS.EXPIRED } }
      );
      request.status = FSR_SIGNATURE_REQUEST_STATUS.EXPIRED;
    }
    state[request.signatureFieldKey] = buildSignatureRequestSummary(request);
  }

  return state;
}

async function getPendingSignatureRequest(fsrDocumentId, signatureFieldKey) {
  if (!fsrDocumentId || !signatureFieldKey) return null;
  const request = await FsrSignatureRequest.findOne({
    fsrDocument: fsrDocumentId,
    signatureFieldKey,
    status: FSR_SIGNATURE_REQUEST_STATUS.PENDING,
  }).sort({ createdAt: -1, _id: -1 });

  return expireRequestIfNeeded(request);
}

async function cancelPendingSignatureRequest(
  fsrDocumentId,
  signatureFieldKey,
  nextStatus = FSR_SIGNATURE_REQUEST_STATUS.CANCELLED
) {
  if (!fsrDocumentId || !signatureFieldKey) return null;
  return FsrSignatureRequest.findOneAndUpdate(
    {
      fsrDocument: fsrDocumentId,
      signatureFieldKey,
      status: FSR_SIGNATURE_REQUEST_STATUS.PENDING,
    },
    { $set: { status: nextStatus } },
    { sort: { createdAt: -1, _id: -1 }, new: true }
  );
}

async function cancelPendingSignatureRequestsForFsr(
  fsrDocumentId,
  nextStatus = FSR_SIGNATURE_REQUEST_STATUS.CANCELLED
) {
  if (!fsrDocumentId) return;
  await FsrSignatureRequest.updateMany(
    { fsrDocument: fsrDocumentId, status: FSR_SIGNATURE_REQUEST_STATUS.PENDING },
    { $set: { status: nextStatus } }
  );
}

module.exports = {
  FSR_SIGNATURE_REQUEST_STATUS,
  FSR_SIGNATURE_FIELD_KEY,
  SIGNATURE_REQUEST_DEFINITIONS,
  getSignatureRequestDefinition,
  sanitizeSignatureRequestContext,
  calculateSignatureRequestCooldownSeconds,
  buildSignatureRequestNextSendAllowedAt,
  normalizeDraftSignaturesObject,
  getDraftSignatureValue,
  buildSignatureRequestSummary,
  expireRequestIfNeeded,
  getLatestSignatureRequestsByField,
  getPendingSignatureRequest,
  cancelPendingSignatureRequest,
  cancelPendingSignatureRequestsForFsr,
};
