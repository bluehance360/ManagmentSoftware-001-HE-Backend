const express = require('express');
const mongoose = require('mongoose');
const { body, param, validationResult } = require('express-validator');
const Job = require('../models/Job');
const JobType = require('../models/JobType');
const JobTypeSettings = require('../models/JobTypeSettings');
const User = require('../models/User');
const FsrDocument = require('../models/FsrDocument');
const FsrSignatureRequest = require('../models/FsrSignatureRequest');
const { authenticate, authorize } = require('../middleware/auth');
const { ROLES, JOB_STATUS } = require('../config/constants');
const JobService = require('../services/JobService');
const Customer = require('../models/Customer');
const TechTimeout = require('../models/TechTimeout');
const { createNotification } = require('../services/NotificationService');
const { getIO } = require('../socket');
const { sendFsrSignatureRequestEmail } = require('../services/EmailService');
const { normalizeDateOnly, isDateOnly, toLocalDateOnly } = require('../utils/dateOnly');
const {
  buildDocumentKey,
  buildFsrAssetKey,
  getUploadUrl,
  getDownloadUrl,
  headObject,
  deleteObject,
} = require('../services/S3Service');
const {
  FSR_TEMPLATE,
  FSR_STATUS,
  FSR_TEMPLATE_SOURCE,
  normalizeLevitonExternalLink,
  attachFsrSummariesToJobs,
  createFsrDocumentForJob,
  getFsrDocumentByJobId,
  syncUnsubmittedFsrDocumentForJob,
  buildJobSnapshot,
  formatFsrDocument,
  resolveFsrTemplateForJobType,
} = require('../services/FsrService');
const {
  FSR_SIGNATURE_REQUEST_STATUS,
  getSignatureRequestDefinition,
  sanitizeSignatureRequestContext,
  buildSignatureRequestNextSendAllowedAt,
  buildSignatureRequestSummary,
  normalizeDraftSignaturesObject,
  getDraftSignatureValue,
  getLatestSignatureRequestsByField,
  getPendingSignatureRequest,
  cancelPendingSignatureRequest,
  cancelPendingSignatureRequestsForFsr,
} = require('../services/FsrSignatureRequestService');

const router = express.Router();

function broadcastJobUpdate() {
  const io = getIO();
  if (io) io.emit('jobs:updated');
}

const TECH_VISIBLE_STATUSES = [
  JOB_STATUS.ASSIGNED,
  JOB_STATUS.IN_PROGRESS,
  JOB_STATUS.COMPLETED,
  JOB_STATUS.BILLED,
  JOB_STATUS.PAID,
  JOB_STATUS.CLOSED,
];

const PROGRAMMING_SUBTYPES = ['New Start-Up', 'Existing Start-Up'];
const EMPTY_PROGRAMMING_REQUIREMENT_DEFAULTS = {
  newStartup: [],
  existingStartup: [],
};
const FSR_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif']);
const FSR_MAX_ASSETS = 10;
const KORE_SYSTEM_STATUSES = ['VERIFIED_ACCEPTED', 'CONFIRMATION', 'CONDITIONAL'];

function normalizeJobType(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizeProgrammingSubtype(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function sanitizeDocumentRequirements(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      const label =
        typeof item === 'string'
          ? item.trim()
          : typeof item?.label === 'string'
            ? item.label.trim()
            : '';
      return label ? { label } : null;
    })
    .filter(Boolean)
    .slice(0, 30);
}

function toRequirementKey(label, fallbackIndex = 0) {
  const normalized = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || `requirement-${fallbackIndex + 1}`;
}

function sanitizeProgrammingRequirements(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    newStartup: sanitizeDocumentRequirements(source.newStartup),
    existingStartup: sanitizeDocumentRequirements(source.existingStartup),
  };
}

async function getProgrammingRequirementDefaults() {
  const settings = await JobTypeSettings.findOne({ key: 'global' })
    .select('programmingDocumentRequirements')
    .lean();
  return sanitizeProgrammingRequirements(
    settings?.programmingDocumentRequirements || EMPTY_PROGRAMMING_REQUIREMENT_DEFAULTS
  );
}

function resolveJobTypeDocumentRequirements(type, programmingSubtype, programmingDefaults) {
  if (!type) return [];
  const generalRows = sanitizeDocumentRequirements(type.documentRequirements);
  if (!type.isProgramming) {
    return generalRows;
  }

  const isExisting = normalizeProgrammingSubtype(programmingSubtype) === 'Existing Start-Up';
  const override = sanitizeProgrammingRequirements(type.programmingDocumentRequirements);
  const overrideRows = isExisting ? override.existingStartup : override.newStartup;
  const defaultRows = isExisting
    ? programmingDefaults.existingStartup
    : programmingDefaults.newStartup;
  const subtypeRows = overrideRows.length ? overrideRows : defaultRows;
  return [...generalRows, ...subtypeRows];
}

function buildAssignmentRequirementRows(requirements, previousRows = []) {
  const previousByKey = new Map(
    (Array.isArray(previousRows) ? previousRows : [])
      .filter((row) => row && row.key && row.label)
      .map((row) => [String(row.key), row])
  );

  return sanitizeDocumentRequirements(requirements).map((row, index) => {
    const key = toRequirementKey(row.label, index);
    const previous = previousByKey.get(key);
    return {
      key,
      label: row.label,
      checked: Boolean(previous?.checked),
      textValue: String(previous?.textValue || '').trim(),
      document: previous?.document?.key
        ? {
          key: previous.document.key,
          fileName: previous.document.fileName || '',
          contentType: previous.document.contentType || 'application/octet-stream',
          size: Number(previous.document.size || 0),
          uploadedBy: previous.document.uploadedBy || null,
          uploadedAt: previous.document.uploadedAt || null,
        }
        : null,
    };
  });
}

function throwBadRequest(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function ensureBoolean(value, fieldLabel) {
  if (typeof value !== 'boolean') {
    throwBadRequest(`${fieldLabel} must be true or false`);
  }
  return value;
}

function ensureRequiredText(value, fieldLabel) {
  const normalized = trimString(value);
  if (!normalized) {
    throwBadRequest(`${fieldLabel} is required`);
  }
  return normalized;
}

function ensureOptionalEmail(value, fieldLabel) {
  const normalized = trimString(value);
  if (!normalized) return '';
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(normalized)) {
    throwBadRequest(`${fieldLabel} must be a valid email address`);
  }
  return normalized.toLowerCase();
}

function ensureOptionalPhone(value, fieldLabel) {
  const normalized = trimString(value);
  if (!normalized) return '';
  if (!/^[\d\s()+\-]+$/.test(normalized)) {
    throwBadRequest(`${fieldLabel} contains invalid characters`);
  }
  return normalized;
}

function ensureOptionalDateOnly(value, fieldLabel) {
  const normalized = trimString(value);
  if (!normalized) return '';
  if (!isDateOnly(normalized)) {
    throwBadRequest(`${fieldLabel} must be in YYYY-MM-DD format`);
  }
  return normalized;
}

function ensureSignatureDataUrl(value, fieldLabel, required = false) {
  const normalized = trimString(value);
  if (!normalized) {
    if (required) throwBadRequest(`${fieldLabel} is required`);
    return '';
  }
  if (!normalized.startsWith('data:image/')) {
    throwBadRequest(`${fieldLabel} must be a captured signature image`);
  }
  return normalized;
}

function ensureRequiredEmail(value, fieldLabel) {
  const normalized = ensureOptionalEmail(value, fieldLabel);
  if (!normalized) {
    throwBadRequest(`${fieldLabel} is required`);
  }
  return normalized;
}

function resolveSubmittedOrDraftSignature(fsrDoc, payloadValue, signatureFieldKey, fieldLabel, required = false) {
  const submittedValue = ensureSignatureDataUrl(payloadValue, fieldLabel, false);
  if (submittedValue) return submittedValue;
  const draftValue = ensureSignatureDataUrl(
    getDraftSignatureValue(fsrDoc, signatureFieldKey),
    fieldLabel,
    false
  );
  if (draftValue) return draftValue;
  if (required) {
    throwBadRequest(`${fieldLabel} is required`);
  }
  return '';
}

async function normalizeFsrAssets(rawAssets, jobId, userId, maxCount = FSR_MAX_ASSETS) {
  if (rawAssets === undefined) return [];
  if (!Array.isArray(rawAssets)) {
    throwBadRequest('FSR assets must be an array');
  }
  if (rawAssets.length > maxCount) {
    throwBadRequest(`You can upload a maximum of ${maxCount} FSR assets`);
  }

  const now = new Date();
  const normalizedAssets = [];

  for (const item of rawAssets) {
    const key = trimString(item?.key);
    const fileName = ensureRequiredText(item?.fileName, 'FSR asset file name');
    const caption = trimString(item?.caption);
    if (!key.startsWith(`jobs/${jobId}/fsr/`)) {
      throwBadRequest('Invalid FSR asset key for this job');
    }

    const meta = await headObject(key);
    const contentType = String(meta.ContentType || item?.contentType || 'application/octet-stream').trim();
    if (!contentType.startsWith('image/')) {
      throwBadRequest(`FSR asset "${fileName}" must be an image`);
    }

    normalizedAssets.push({
      key,
      fileName,
      contentType,
      size: Number(meta.ContentLength || item?.size || 0),
      caption,
      uploadedBy: userId,
      uploadedAt: now,
    });
  }

  return normalizedAssets;
}

async function buildSubmissionPayloadForFsr({ fsrDoc, submissionData, job, userId }) {
  const payload = submissionData && typeof submissionData === 'object' ? submissionData : {};

  if (fsrDoc.templateKey === FSR_TEMPLATE.STANDARD) {
    const techSupportContacted = ensureBoolean(payload.techSupportContacted, 'Tech Support Contacted');
    const returnTripNeeded = ensureBoolean(payload.returnTripNeeded, 'Return Trip Needed');
    const trainingGiven = ensureBoolean(payload.trainingGiven, 'Training Given');
    const photos = await normalizeFsrAssets(payload.photoAssets, job._id, userId, FSR_MAX_ASSETS);

    return {
      submissionData: {
        workPerformed: ensureRequiredText(payload.workPerformed, 'Work Performed'),
        techSupportContacted,
        caseNumber: techSupportContacted
          ? ensureRequiredText(payload.caseNumber, 'Case Number')
          : '',
        returnTripNeeded,
        returnTripReason: returnTripNeeded
          ? ensureRequiredText(payload.returnTripReason, 'Return Trip Reason')
          : '',
        trainingGiven,
        training: trainingGiven
          ? {
              traineeName: trimString(payload.training?.traineeName),
              traineeCompany: trimString(payload.training?.traineeCompany),
              traineeSignature: resolveSubmittedOrDraftSignature(
                fsrDoc,
                payload.training?.traineeSignature,
                'standard.training.traineeSignature',
                'Trainee Signature',
                true
              ),
            }
          : null,
        photos,
        clientAcceptance: {
          acceptorName: ensureRequiredText(payload.clientAcceptance?.acceptorName, 'Acceptor Name'),
          acceptorCompany: ensureRequiredText(
            payload.clientAcceptance?.acceptorCompany,
            'Acceptor Company'
          ),
          acceptorSignature: resolveSubmittedOrDraftSignature(
            fsrDoc,
            payload.clientAcceptance?.acceptorSignature,
            'standard.clientAcceptance.acceptorSignature',
            'Acceptor Signature',
            true
          ),
        },
      },
      assets: photos,
    };
  }

  if (fsrDoc.templateKey === FSR_TEMPLATE.WATTSTOPPER) {
    const trainingComplete = ensureBoolean(payload.trainingComplete, 'Training Complete');
    const programmingComplete = ensureBoolean(payload.programmingComplete, 'Programming Complete');
    const issuesResolved = ensureBoolean(payload.issuesResolved, 'Were All Issues Resolved');
    const photos = await normalizeFsrAssets(payload.photoAssets, job._id, userId, FSR_MAX_ASSETS);
    const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'];
    const technicianHours = {};
    const ecHours = {};

    weekdays.forEach((day) => {
      technicianHours[day] = trimString(payload.hoursOnSite?.technicianHours?.[day]);
      ecHours[day] = trimString(payload.hoursOnSite?.ecHours?.[day]);
    });

    return {
      submissionData: {
        siteContact: {
          name: trimString(payload.siteContact?.name),
          title: trimString(payload.siteContact?.title),
          company: trimString(payload.siteContact?.company),
          phone: ensureOptionalPhone(payload.siteContact?.phone, 'Site Contact Phone'),
          email: ensureOptionalEmail(payload.siteContact?.email, 'Site Contact Email'),
        },
        trainingComplete,
        trainingReason: !trainingComplete
          ? ensureRequiredText(payload.trainingReason, 'Training Reason')
          : '',
        training: trainingComplete
          ? {
              dateOfTraining: ensureOptionalDateOnly(
                payload.training?.dateOfTraining,
                'Date of Training'
              ),
              traineeName: trimString(payload.training?.traineeName),
              traineeCompany: trimString(payload.training?.traineeCompany),
              traineeSignature: resolveSubmittedOrDraftSignature(
                fsrDoc,
                payload.training?.traineeSignature,
                'wattstopper.training.traineeSignature',
                'Trainee Signature',
                true
              ),
            }
          : null,
        hoursOnSite: {
          technicianHours,
          ecHours,
        },
        programmingComplete,
        programmingReason: !programmingComplete
          ? ensureRequiredText(payload.programmingReason, 'Programming Reason')
          : '',
        issuesResolved,
        programmingDetailsAndNotes: trimString(payload.programmingDetailsAndNotes),
        photos,
        reportReceivedBy: {
          name: ensureRequiredText(payload.reportReceivedBy?.name, 'Report Received By Name'),
          title: ensureRequiredText(payload.reportReceivedBy?.title, 'Report Received By Title'),
          company: ensureRequiredText(
            payload.reportReceivedBy?.company,
            'Report Received By Company'
          ),
          signature: resolveSubmittedOrDraftSignature(
            fsrDoc,
            payload.reportReceivedBy?.signature,
            'wattstopper.reportReceivedBy.signature',
            'Signature',
            true
          ),
        },
      },
      assets: photos,
    };
  }

  if (fsrDoc.templateKey === FSR_TEMPLATE.LEVITON_EXTERNAL) {
    const completionConfirmed = ensureBoolean(payload.completionConfirmed, 'Completion');
    if (!completionConfirmed) {
      throwBadRequest('Completion must be checked before submitting the Leviton FSR');
    }

    const screenshotAssets = payload.screenshotAsset
      ? await normalizeFsrAssets([payload.screenshotAsset], job._id, userId, 1)
      : [];

    return {
      submissionData: {
        completionConfirmed: true,
        externalFsrReferenceNumber: trimString(payload.externalFsrReferenceNumber),
        internalNotes: trimString(payload.internalNotes),
        screenshot: screenshotAssets[0] || null,
      },
      assets: screenshotAssets,
    };
  }

  if (fsrDoc.templateKey === FSR_TEMPLATE.KORE) {
    const systemStatus = trimString(payload.systemStatus);
    if (!KORE_SYSTEM_STATUSES.includes(systemStatus)) {
      throwBadRequest('A system status selection is required');
    }

    const electricalName = trimString(payload.electricalContractor?.name);
    const electricalSignature = electricalName
      ? resolveSubmittedOrDraftSignature(
          fsrDoc,
          payload.electricalContractor?.signature,
          'kore.electricalContractor.signature',
          'Electrical Contractor Signature',
          false
        )
      : '';

    return {
      submissionData: {
        project: ensureRequiredText(payload.project, 'Project'),
        dateOfReport: ensureOptionalDateOnly(payload.dateOfReport, 'Date of Report'),
        koreRepresentative: trimString(payload.koreRepresentative),
        dateOnsite: ensureOptionalDateOnly(payload.dateOnsite, 'Date Onsite'),
        onsiteTime: trimString(payload.onsiteTime),
        departedTime: trimString(payload.departedTime),
        onsiteContact: trimString(payload.onsiteContact),
        whatWasDone: ensureRequiredText(payload.whatWasDone, 'What Was Done'),
        issues: trimString(payload.issues),
        nextSteps: trimString(payload.nextSteps),
        submittedBy: trimString(payload.submittedBy),
        systemStatus,
        electricalContractor: {
          name: electricalName,
          signature: electricalSignature,
        },
        ownerRepresentative: {
          name: ensureRequiredText(payload.ownerRepresentative?.name, "Owner's Representative Name"),
          signature: resolveSubmittedOrDraftSignature(
            fsrDoc,
            payload.ownerRepresentative?.signature,
            'kore.ownerRepresentative.signature',
            "Owner's Representative Signature",
            true
          ),
        },
        notes: trimString(payload.notes),
      },
      assets: [],
    };
  }

  throwBadRequest('Unsupported FSR template');
}

function isManagerRole(role) {
  return role === ROLES.ADMIN || role === ROLES.OFFICE_MANAGER;
}

/** Records that a manager has opened a SUBMITTED FSR (idempotent). */
async function markFsrSeenForManager(fsrDoc, user) {
  if (!fsrDoc || !user || !isManagerRole(user.role)) return;
  if (fsrDoc.status !== FSR_STATUS.SUBMITTED) return;
  const uid = String(user._id);
  const alreadySeen = (fsrDoc.seenBy || []).some((id) => String(id) === uid);
  if (alreadySeen) return;
  await FsrDocument.updateOne({ _id: fsrDoc._id }, { $addToSet: { seenBy: user._id } });
  fsrDoc.seenBy = [...(fsrDoc.seenBy || []), user._id];
}

/** Sets a per-request `statusSeen` boolean on each job for the requesting manager. */
function annotateJobsWithStatusSeen(jobs, user) {
  const list = Array.isArray(jobs) ? jobs : [];
  const manager = isManagerRole(user?.role);
  const uid = String(user?._id || '');
  list.forEach((job) => {
    if (!job) return;
    const seen = !manager || (job.statusSeenBy || []).some((id) => String(id) === uid);
    if (typeof job.set === 'function') job.set('statusSeen', seen, { strict: false });
    else job.statusSeen = seen;
  });
}

async function attachAssetUrlsToFsrData(data) {
  if (!data || !Array.isArray(data.assets) || data.assets.length === 0) return data;

  const assets = await Promise.all(
    data.assets.map(async (asset) => ({
      ...asset,
      url: await getDownloadUrl({
        key: asset.key,
        fileName: asset.fileName,
        expiresIn: 900,
      }),
    }))
  );

  const urlByKey = new Map(assets.map((asset) => [asset.key, asset.url]));
  data.assets = assets;

  if (data.templateKey === FSR_TEMPLATE.LEVITON_EXTERNAL && data.submissionData?.screenshot?.key) {
    data.submissionData = {
      ...data.submissionData,
      screenshot: {
        ...data.submissionData.screenshot,
        url: urlByKey.get(data.submissionData.screenshot.key) || '',
      },
    };
  }

  if (
    (data.templateKey === FSR_TEMPLATE.STANDARD || data.templateKey === FSR_TEMPLATE.WATTSTOPPER) &&
    Array.isArray(data.submissionData?.photos)
  ) {
    data.submissionData = {
      ...data.submissionData,
      photos: data.submissionData.photos.map((photo) => ({
        ...photo,
        url: photo?.key ? urlByKey.get(photo.key) || '' : '',
      })),
    };
  }

  return data;
}

async function buildFsrResponseData(job, fsrDoc) {
  const data = await attachAssetUrlsToFsrData(formatFsrDocument(fsrDoc));
  data.draftSignatures = normalizeDraftSignaturesObject(data.draftSignatures);
  data.signatureRequests = await getLatestSignatureRequestsByField(fsrDoc?._id);
  data.job = {
    _id: job._id,
    title: job.title,
    address:
      typeof job.address === 'string' && job.address.trim()
        ? job.address
        : String(job.customer?.address || '').trim(),
    companyName: job.companyName || '',
    customerName: job.customer?.name || job.customerName || '',
    assignedTechnician: job.assignedTechnician || null,
    secondaryAssignedTechnician: job.secondaryAssignedTechnician || null,
    status: job.status,
  };

  return data;
}

async function resolveAssignmentRequirementsForJob(jobDoc, overrideRows = null) {
  const normalizedJobType = normalizeJobType(jobDoc?.jobType).toLowerCase();
  if (!normalizedJobType) return [];
  const type = await JobType.findOne({ normalizedName: normalizedJobType }).lean();
  if (!type) return [];
  const defaults = await getProgrammingRequirementDefaults();
  const resolved = resolveJobTypeDocumentRequirements(type, jobDoc?.programmingSubtype, defaults);
  const savedRows = overrideRows !== null ? overrideRows : (jobDoc?.assignmentDocumentRequirements || []);
  return buildAssignmentRequirementRows(resolved, savedRows);
}

/** Resolve whether the named job type is a programming type (from DB). */
async function jobTypeIsProgramming(jobTypeName) {
  const normalized = normalizeJobType(jobTypeName).toLowerCase();
  if (!normalized) return false;
  const doc = await JobType.findOne({ normalizedName: normalized }).select('isProgramming').lean();
  return Boolean(doc?.isProgramming);
}

async function ensureJobTypeSaved(name, opts = {}) {
  const normalizedName = normalizeJobType(name);
  if (!normalizedName) return null;

  const {
    certificationRequired,
    isProgramming,
    documentRequirements,
    programmingDocumentRequirements,
  } = opts;

  const setOnInsert = {
    name: normalizedName,
    normalizedName: normalizedName.toLowerCase(),
  };
  if (typeof certificationRequired === 'boolean') {
    setOnInsert.certificationRequired = certificationRequired;
  }
  if (typeof isProgramming === 'boolean') {
    setOnInsert.isProgramming = isProgramming;
  }
  if (documentRequirements !== undefined) {
    setOnInsert.documentRequirements = sanitizeDocumentRequirements(documentRequirements);
  }
  if (programmingDocumentRequirements !== undefined) {
    setOnInsert.programmingDocumentRequirements = sanitizeProgrammingRequirements(
      programmingDocumentRequirements
    );
  }

  return JobType.findOneAndUpdate(
    { normalizedName: normalizedName.toLowerCase() },
    { $setOnInsert: setOnInsert },
    { upsert: true, new: true }
  );
}

async function getJobTypeUsageMap() {
  const usage = await Job.aggregate([
    { $match: { jobType: { $exists: true, $ne: '' } } },
    {
      $group: {
        _id: { $toLower: '$jobType' },
        usageCount: { $sum: 1 },
        jobTitles: { $addToSet: '$title' },
      },
    },
  ]);

  const map = new Map();
  usage.forEach((item) => {
    map.set(item._id, {
      usageCount: item.usageCount,
      jobTitles: item.jobTitles || [],
    });
  });
  return map;
}

async function listJobTypesWithUsage() {
  const usageMap = await getJobTypeUsageMap();
  const types = await JobType.find({}).sort({ name: 1 }).lean();
  return types.map((type) => ({
    _id: type._id,
    name: type.name,
    certificationRequired: Boolean(type.certificationRequired),
    isProgramming: Boolean(type.isProgramming),
    documentRequirements: Array.isArray(type.documentRequirements) ? type.documentRequirements : [],
    programmingDocumentRequirements: sanitizeProgrammingRequirements(type.programmingDocumentRequirements),
    usageCount: usageMap.get(type.normalizedName)?.usageCount || 0,
    jobTitles: usageMap.get(type.normalizedName)?.jobTitles || [],
  }));
}

const JOB_DETAIL_POPULATE = [
  { path: 'assignedTechnician', select: 'name email certificates' },
  { path: 'secondaryAssignedTechnician', select: 'name email certificates' },
  { path: 'createdBy', select: 'name email' },
  { path: 'customer', select: 'name phone email address firstPageRequired' },
  { path: 'statusHistory.changedBy', select: 'name email role' },
  { path: 'statusHistory.technician', select: 'name email' },
  { path: 'documents.uploadedBy', select: 'name email role' },
  { path: 'parentJob', select: 'title scheduledDate status assignedTechnician secondaryAssignedTechnician' },
  { path: 'incompleteReturnRequest.submittedBy', select: 'name role' },
  { path: 'incompleteReturnRequest.reviewedBy', select: 'name role' },
];

function withJobDetailPopulate(query) {
  return query.populate(JOB_DETAIL_POPULATE);
}

function canAccessJob(user, job) {
  if (!job) return false;
  if ([ROLES.ADMIN, ROLES.OFFICE_MANAGER].includes(user.role)) return true;
  if (user.role !== ROLES.TECHNICIAN) return false;

  const userId = user._id.toString();
  const primaryTechId = job.assignedTechnician?._id || job.assignedTechnician;
  const secondaryTechId = job.secondaryAssignedTechnician?._id || job.secondaryAssignedTechnician;
  const selfAssigned =
    primaryTechId?.toString() === userId || secondaryTechId?.toString() === userId;

  if (selfAssigned && TECH_VISIBLE_STATUSES.includes(job.status)) return true;

  const extendedReturnStatuses = [
    JOB_STATUS.TENTATIVE,
    JOB_STATUS.CONFIRMED,
    ...TECH_VISIBLE_STATUSES,
  ];
  if (
    job.jobVisitKind === 'RETURN' &&
    job.parentJob &&
    extendedReturnStatuses.includes(job.status)
  ) {
    const parent = job.parentJob;
    const p1 = parent.assignedTechnician?._id || parent.assignedTechnician;
    const p2 = parent.secondaryAssignedTechnician?._id || parent.secondaryAssignedTechnician;
    const parentAssigned = p1?.toString() === userId || p2?.toString() === userId;
    if (parentAssigned) return true;
  }

  return false;
}

function normalizeDocNote(note) {
  return typeof note === 'string' ? note.trim() : '';
}

function validateScheduledDate(value) {
  const normalized = normalizeDateOnly(value);
  if (!isDateOnly(normalized)) {
    throw new Error('Invalid date format. Use YYYY-MM-DD');
  }
  if (normalized < toLocalDateOnly()) {
    throw new Error('Scheduled date cannot be in the past');
  }
  return true;
}

function formatRoleLabel(role) {
  if (!role) return 'User';
  if (role === ROLES.OFFICE_MANAGER) return 'Office Manager';
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
}

function actorWithRole(user) {
  return `${user.name} (${formatRoleLabel(user.role)})`;
}

function hasAssignedTechnician(job) {
  return Boolean(
    job?.assignedTechnician?._id ||
      job?.assignedTechnician ||
      job?.secondaryAssignedTechnician?._id ||
      job?.secondaryAssignedTechnician
  );
}

function toObjectIdString(value) {
  const raw = value?._id || value;
  return raw ? String(raw) : '';
}

function getVisibleFsrTechnicianRecipientIds(job, fsrDoc) {
  if (!fsrDoc?.technicianVisible) return [];
  return [job?.assignedTechnician, job?.secondaryAssignedTechnician]
    .map((entry) => toObjectIdString(entry))
    .filter(Boolean);
}

function canUserOpenVisibleFsr(user, job, fsrDoc) {
  if (!user || !job || !fsrDoc) return false;
  if ([ROLES.ADMIN, ROLES.OFFICE_MANAGER].includes(user.role)) return true;
  if (user.role !== ROLES.TECHNICIAN) return false;
  return canAccessJob(user, job) && Boolean(fsrDoc.technicianVisible);
}

function buildSignatureRequestJobSnapshot(job, fsrDoc) {
  const snapshot = buildJobSnapshot(job);
  return {
    projectName: snapshot.projectName || String(job?.title || '').trim(),
    siteAddress: snapshot.siteAddress || '',
    companyName: snapshot.companyName || String(job?.companyName || '').trim(),
    customerName: snapshot.customerName || String(job?.customer?.name || job?.customerName || '').trim(),
    templateKey: fsrDoc?.templateKey || '',
  };
}

function notifyAssignmentDocumentChange({ job, documentFieldName, action, actorUser }) {
  if (!job || !documentFieldName || !action || !actorUser) return;
  const recipientIds = [];
  if (job.assignedTechnician) recipientIds.push(job.assignedTechnician);
  if (job.secondaryAssignedTechnician) recipientIds.push(job.secondaryAssignedTechnician);

  createNotification({
    type: 'JOB_DOCUMENTS_UPDATED',
    message: `Job "${job.title || 'Untitled'}": ${documentFieldName} is ${action} by ${actorWithRole(actorUser)}.`,
    jobId: job._id,
    recipientIds,
    recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
    excludeUserId: actorUser._id,
  });
}

function notifyAssignmentChecklistUpdated({ job, summaryLines, actorUser }) {
  if (!job || !actorUser) return;
  const recipientIds = [];
  if (job.assignedTechnician) recipientIds.push(job.assignedTechnician);
  if (job.secondaryAssignedTechnician) recipientIds.push(job.secondaryAssignedTechnician);
  const detail = summaryLines?.length ? summaryLines.join('; ') : 'checklist updated';
  createNotification({
    type: 'JOB_UPDATED',
    message: `Job "${job.title || 'Untitled'}": Assignment checklist updated (${detail}) by ${actorWithRole(actorUser)}.`,
    jobId: job._id,
    recipientIds,
    recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
    excludeUserId: actorUser._id,
  });
}

/** Compare saved rows to merged rows; notify when requirement text (textValue) changed. */
function collectAssignmentRequirementTextNoteChanges(beforeRows, afterRows) {
  const beforeByKey = new Map(
    (Array.isArray(beforeRows) ? beforeRows : [])
      .filter((row) => row && row.key)
      .map((row) => [String(row.key), String(row.textValue || '').trim()])
  );
  const entries = [];
  for (const row of Array.isArray(afterRows) ? afterRows : []) {
    if (!row?.key) continue;
    const key = String(row.key);
    const prevText = beforeByKey.has(key) ? beforeByKey.get(key) : '';
    const nextText = String(row.textValue || '').trim();
    if (prevText === nextText) continue;
    const label = String(row.label || key).trim() || key;
    let summary = 'text note updated';
    if (!prevText && nextText) summary = 'text note added';
    else if (prevText && !nextText) summary = 'text note removed';
    entries.push({ label, summary });
  }
  return entries;
}

function notifyAssignmentRequirementNoteChanges({ job, entries, actorUser }) {
  if (!job || !actorUser || !entries?.length) return;
  const recipientIds = [];
  if (job.assignedTechnician) recipientIds.push(job.assignedTechnician);
  if (job.secondaryAssignedTechnician) recipientIds.push(job.secondaryAssignedTechnician);
  const detail = entries.map((e) => `"${e.label}" - ${e.summary}`).join('; ');
  createNotification({
    type: 'JOB_DOCUMENTS_UPDATED',
    message: `Job "${job.title || 'Untitled'}": ${detail} by ${actorWithRole(actorUser)}.`,
    jobId: job._id,
    recipientIds,
    recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
    excludeUserId: actorUser._id,
  });
}

const RETURN_WORKFLOW_REASONS = ['NONE', 'RETURN_VISIT', 'MANUFACTURER', 'OUR_ISSUE'];
const RMA_STATUSES = ['ORDERED', 'WAITING', 'RECEIVED'];
const OUR_ISSUE_REVIEW_STATUSES = ['NONE', 'PENDING', 'APPROVED', 'REJECTED'];

function techAssignedToJob(job, userId) {
  if (!job) return false;
  const uid = userId.toString();
  const p1 = job.assignedTechnician?._id || job.assignedTechnician;
  const p2 = job.secondaryAssignedTechnician?._id || job.secondaryAssignedTechnician;
  return p1?.toString() === uid || p2?.toString() === uid;
}

/** Job document that owns `returnWorkflow` (never the return child row). */
async function loadReturnWorkflowTargetJob(jobId) {
  const job = await Job.findById(jobId)
    .select(
      '_id title status customer companyName customerName customerPhone customerEmail address scheduledDate jobType programmingSubtype estimatedCost notes assignedTechnician secondaryAssignedTechnician createdBy parentJob jobVisitKind returnWorkflow description'
    )
    .populate('parentJob', 'assignedTechnician secondaryAssignedTechnician');
  if (!job) return null;
  if (job.parentJob) {
    const parentId = job.parentJob._id || job.parentJob;
    return Job.findById(parentId).select(
      '_id title status customer companyName customerName customerPhone customerEmail address scheduledDate jobType programmingSubtype estimatedCost notes assignedTechnician secondaryAssignedTechnician createdBy parentJob jobVisitKind returnWorkflow description'
    );
  }
  return job;
}

function canEditReturnWorkflow(user, workflowJob) {
  if (!workflowJob) return false;
  if ([ROLES.ADMIN, ROLES.OFFICE_MANAGER].includes(user.role)) return canAccessJob(user, workflowJob);
  if (user.role === ROLES.TECHNICIAN) {
    if (![JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS].includes(workflowJob.status)) return false;
    return techAssignedToJob(workflowJob, user._id);
  }
  return false;
}

function pushStatusHistoryNote(job, userId, notesText) {
  if (!Array.isArray(job.statusHistory)) {
    job.statusHistory = [];
  }
  job.statusHistory.push({
    _id: new mongoose.Types.ObjectId(),
    fromStatus: job.status,
    toStatus: job.status,
    changedBy: userId,
    notes: notesText,
  });
}

function cloneStatusHistoryEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => entry?.toStatus && entry?.changedBy)
    .map((entry) => ({
      _id: entry._id || new mongoose.Types.ObjectId(),
      fromStatus: entry.fromStatus ?? null,
      toStatus: entry.toStatus,
      changedBy: entry.changedBy?._id || entry.changedBy,
      changedAt: entry.changedAt ? new Date(entry.changedAt) : new Date(),
      notes: String(entry.notes || '').trim(),
      technician: entry.technician?._id || entry.technician || null,
      assignmentChecklist: entry.assignmentChecklist
        ? {
          firstPageReceived: Boolean(entry.assignmentChecklist.firstPageReceived),
          printsDrawingsReceived: Boolean(entry.assignmentChecklist.printsDrawingsReceived),
          siteContactInfoReceived: Boolean(entry.assignmentChecklist.siteContactInfoReceived),
        }
        : undefined,
    }));
}

function cloneDocumentEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((doc) => doc?.key && doc?.fileName)
    .map((doc) => ({
      _id: doc._id || new mongoose.Types.ObjectId(),
      key: String(doc.key).trim(),
      fileName: String(doc.fileName).trim(),
      contentType: String(doc.contentType || 'application/octet-stream').trim(),
      size: Number(doc.size) || 0,
      note: normalizeDocNote(doc.note),
      isSiteInfo: Boolean(doc.isSiteInfo),
      uploadedBy: doc.uploadedBy?._id || doc.uploadedBy,
      uploadedAt: doc.uploadedAt ? new Date(doc.uploadedAt) : new Date(),
    }));
}

function mergeStatusHistoryEntries(...groups) {
  const byId = new Map();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const raw of group) {
      if (!raw?.toStatus || !raw?.changedBy) continue;
      const entry = raw?.toObject ? raw.toObject() : { ...raw };
      const key = String(entry._id || '');
      if (key && byId.has(key)) continue;
      byId.set(key || `${entry.toStatus}-${new Date(entry.changedAt || 0).getTime()}`, entry);
    }
  }
  return Array.from(byId.values()).sort((a, b) => {
    const aTime = new Date(a.changedAt || 0).getTime();
    const bTime = new Date(b.changedAt || 0).getTime();
    if (aTime !== bTime) return aTime - bTime;
    return String(a._id || '').localeCompare(String(b._id || ''));
  });
}

function mergeFamilyDocuments(jobs) {
  const byKey = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    for (const rawDoc of Array.isArray(job?.documents) ? job.documents : []) {
      const docs = cloneDocumentEntries([rawDoc]);
      const doc = docs[0];
      if (!doc?.key || byKey.has(doc.key)) continue;
      byKey.set(doc.key, {
        ...doc,
        uploadedBy:
          rawDoc?.uploadedBy && typeof rawDoc.uploadedBy === 'object'
            ? rawDoc.uploadedBy
            : doc.uploadedBy,
      });
    }
  }
  return Array.from(byKey.values());
}

async function loadDocumentFamilyJobs(job) {
  if (!job?._id) return [];
  const rootId = job.parentJob?._id || job.parentJob || job._id;
  return Job.find({
    $or: [
      { _id: rootId },
      { parentJob: rootId, jobVisitKind: 'RETURN' },
    ],
  })
    .select('_id title documents assignedTechnician secondaryAssignedTechnician parentJob jobVisitKind')
    .populate('documents.uploadedBy', 'name email role');
}

async function syncAssignmentRequirementsToFamily(job, rows) {
  const rootId = job.parentJob?._id || job.parentJob || job._id;
  const familyJobs = await Job.find({
    $or: [{ _id: rootId }, { parentJob: rootId, jobVisitKind: 'RETURN' }],
  }).select('_id');
  const otherIds = familyJobs.map((j) => j._id).filter((id) => String(id) !== String(job._id));
  if (otherIds.length > 0) {
    await Job.updateMany({ _id: { $in: otherIds } }, { $set: { assignmentDocumentRequirements: rows } });
  }
}

function findDocumentInFamilyJobs(familyJobs, docId) {
  for (const familyJob of Array.isArray(familyJobs) ? familyJobs : []) {
    const doc = familyJob.documents?.id ? familyJob.documents.id(docId) : null;
    if (doc) return { familyJob, doc };
  }
  return null;
}

async function annotateJobsWithLinkedReturnFlag(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const rootIds = list
    .filter((job) => job?._id && !job.parentJob)
    .map((job) => job._id);

  if (!rootIds.length) {
    list.forEach((job) => {
      if (job && typeof job.set === 'function') {
        job.set('hasLinkedReturnVisit', false, { strict: false });
      } else if (job) {
        job.hasLinkedReturnVisit = false;
      }
    });
    return list;
  }

  const parentIds = await Job.find({
    parentJob: { $in: rootIds },
    jobVisitKind: 'RETURN',
  }).distinct('parentJob');
  const parentIdSet = new Set(parentIds.map((id) => String(id)));

  list.forEach((job) => {
    const hasLinkedReturnVisit = !job?.parentJob && parentIdSet.has(String(job?._id || ''));
    if (job && typeof job.set === 'function') {
      job.set('hasLinkedReturnVisit', hasLinkedReturnVisit, { strict: false });
    } else if (job) {
      job.hasLinkedReturnVisit = hasLinkedReturnVisit;
    }
  });

  return list;
}

/** Only Admin / Office Manager, after technician request is approved. */
function canCreateReturnVisitJob(user, parentJob) {
  if (!parentJob || parentJob.parentJob) return false;
  if (![ROLES.ADMIN, ROLES.OFFICE_MANAGER].includes(user.role)) return false;
  if (!canAccessJob(user, parentJob)) return false;
  return parentJob.incompleteReturnRequest?.status === 'APPROVED';
}

function canSubmitIncompleteReturnRequest(user, parentJob) {
  if (!parentJob || parentJob.parentJob) return false;
  if (![JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS].includes(parentJob.status)) return false;
  if ([ROLES.ADMIN, ROLES.OFFICE_MANAGER].includes(user.role)) {
    return canAccessJob(user, parentJob);
  }
  if (user.role === ROLES.TECHNICIAN) {
    return techAssignedToJob(parentJob, user._id);
  }
  return false;
}

const INCOMPLETE_RETURN_REASON_TYPES = ['MANUFACTURER', 'OUR_ISSUE'];

router.use(authenticate);

// ── GET /api/jobs ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, assignedTechnician, jobType, page = 1, limit = 20 } = req.query;
    const filter = {};

    if (req.user.role === ROLES.TECHNICIAN) {
      const techVisibleStatuses = [
        JOB_STATUS.ASSIGNED,
        JOB_STATUS.IN_PROGRESS,
        JOB_STATUS.COMPLETED,
        JOB_STATUS.BILLED,
        JOB_STATUS.PAID,
        JOB_STATUS.CLOSED,
      ];
      const returnExtraStatuses = [JOB_STATUS.TENTATIVE, JOB_STATUS.CONFIRMED];
      const statusConstraint = status
        ? techVisibleStatuses.includes(status) || returnExtraStatuses.includes(status)
          ? { status }
          : { status: '__none__' }
        : null;

      const myParentIds = await Job.find({
        $or: [
          { assignedTechnician: req.user._id },
          { secondaryAssignedTechnician: req.user._id },
        ],
      }).distinct('_id');

      const returnVisitBranch =
        myParentIds.length > 0
          ? {
            $and: [
              { parentJob: { $in: myParentIds } },
              { jobVisitKind: 'RETURN' },
              statusConstraint
                ? statusConstraint
                : { status: { $in: [...techVisibleStatuses, ...returnExtraStatuses] } },
            ],
          }
          : { _id: { $exists: false } };

      const assignedBranch = {
        $and: [
          {
            $or: [
              { assignedTechnician: req.user._id },
              { secondaryAssignedTechnician: req.user._id },
            ],
          },
          statusConstraint
            ? statusConstraint
            : { status: { $in: techVisibleStatuses } },
        ],
      };

      filter.$or = [assignedBranch, returnVisitBranch];
    } else if (req.user.role === ROLES.OFFICE_MANAGER) {
      // Managers see everything including TENTATIVE
      const managerVisibleStatuses = [
        JOB_STATUS.TENTATIVE,
        JOB_STATUS.CONFIRMED,
        JOB_STATUS.ASSIGNED,
        JOB_STATUS.IN_PROGRESS,
        JOB_STATUS.COMPLETED,
        JOB_STATUS.BILLED,
        JOB_STATUS.PAID,
        JOB_STATUS.CLOSED,
      ];
      filter.status = status
        ? (managerVisibleStatuses.includes(status) ? status : '__none__')
        : { $in: managerVisibleStatuses };
    } else {
      // ADMIN sees everything
      if (status) filter.status = status;
    }
    if (assignedTechnician && req.user.role !== ROLES.TECHNICIAN) {
      filter.assignedTechnician = assignedTechnician;
    }
    if (jobType) {
      filter.jobType = normalizeJobType(jobType);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [jobs, total] = await Promise.all([
      Job.find(filter)
        .populate('assignedTechnician', 'name email')
        .populate('secondaryAssignedTechnician', 'name email')
        .populate('createdBy', 'name email')
        .populate('customer', 'name phone email address firstPageRequired')
        .populate('parentJob', 'title scheduledDate status')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Job.countDocuments(filter),
    ]);

    await annotateJobsWithLinkedReturnFlag(jobs);
    await attachFsrSummariesToJobs(jobs);
    annotateJobsWithStatusSeen(jobs, req.user);

    res.json({
      success: true,
      data: jobs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /api/jobs/unseen-count ──────────────────────────────────────
// Number of jobs whose status changed (or were created by someone else) that
// this manager hasn't opened yet. Managers only.
router.get(
  '/unseen-count',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const count = await Job.countDocuments({ statusSeenBy: { $ne: req.user._id } });
      return res.json({ success: true, data: { count } });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── GET /api/jobs/job-types ─────────────────────────────────────────
router.get('/job-types', async (req, res) => {
  try {
    const [jobTypes, programmingRequirementDefaults] = await Promise.all([
      listJobTypesWithUsage(),
      getProgrammingRequirementDefaults(),
    ]);
    res.json({ success: true, data: jobTypes, programmingRequirementDefaults });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch(
  '/job-types/programming-defaults',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('newStartup').optional().isArray().withMessage('newStartup must be an array'),
    body('existingStartup').optional().isArray().withMessage('existingStartup must be an array'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    try {
      const programmingDocumentRequirements = sanitizeProgrammingRequirements(req.body);
      await JobTypeSettings.findOneAndUpdate(
        { key: 'global' },
        { $set: { key: 'global', programmingDocumentRequirements } },
        { upsert: true, new: true }
      );
      const jobTypes = await listJobTypesWithUsage();
      return res.json({ success: true, data: { jobTypes, programmingRequirementDefaults: programmingDocumentRequirements } });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/jobs/job-types (ADMIN, OFFICE_MANAGER) ───────────────
router.post(
  '/job-types',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('name').notEmpty().withMessage('Job type name is required').isString().withMessage('Job type name must be a string'),
    body('certificationRequired').optional().isBoolean().withMessage('certificationRequired must be true or false'),
    body('isProgramming').optional().isBoolean().withMessage('isProgramming must be true or false'),
    body('documentRequirements').optional().isArray().withMessage('documentRequirements must be an array'),
    body('programmingDocumentRequirements').optional().isObject().withMessage('programmingDocumentRequirements must be an object'),
    body('programmingDocumentRequirements.newStartup').optional().isArray().withMessage('newStartup must be an array'),
    body('programmingDocumentRequirements.existingStartup').optional().isArray().withMessage('existingStartup must be an array'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const normalizedName = normalizeJobType(req.body.name);
      if (!normalizedName) {
        return res.status(400).json({ success: false, error: 'Job type name is required' });
      }

      const defaults = await getProgrammingRequirementDefaults();
      const isProgramming = Boolean(req.body.isProgramming);
      await ensureJobTypeSaved(normalizedName, {
        certificationRequired: Boolean(req.body.certificationRequired),
        isProgramming,
        documentRequirements: sanitizeDocumentRequirements(req.body.documentRequirements),
        programmingDocumentRequirements: isProgramming
          ? sanitizeProgrammingRequirements(
            req.body.programmingDocumentRequirements || defaults
          )
          : sanitizeProgrammingRequirements(req.body.programmingDocumentRequirements),
      });
      const jobTypes = await listJobTypesWithUsage();
      const created = jobTypes.find((item) => item.name.toLowerCase() === normalizedName.toLowerCase());

      res.status(201).json({ success: true, data: { jobType: created, jobTypes } });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/jobs/job-types/:id (ADMIN, OFFICE_MANAGER) ───────────
router.patch(
  '/job-types/:id',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    param('id').isMongoId().withMessage('Invalid job type ID'),
    body('certificationRequired').optional().isBoolean().withMessage('certificationRequired must be true or false'),
    body('isProgramming').optional().isBoolean().withMessage('isProgramming must be true or false'),
    body('documentRequirements').optional().isArray().withMessage('documentRequirements must be an array'),
    body('programmingDocumentRequirements').optional().isObject().withMessage('programmingDocumentRequirements must be an object'),
    body('programmingDocumentRequirements.newStartup').optional().isArray().withMessage('newStartup must be an array'),
    body('programmingDocumentRequirements.existingStartup').optional().isArray().withMessage('existingStartup must be an array'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const type = await JobType.findById(req.params.id);
      if (!type) {
        return res.status(404).json({ success: false, error: 'Job type not found' });
      }

      const $set = {};
      if (req.body.certificationRequired !== undefined) {
        $set.certificationRequired = Boolean(req.body.certificationRequired);
      }
      if (req.body.isProgramming !== undefined) {
        $set.isProgramming = Boolean(req.body.isProgramming);
      }
      if (req.body.documentRequirements !== undefined) {
        $set.documentRequirements = sanitizeDocumentRequirements(req.body.documentRequirements);
      }
      if (req.body.programmingDocumentRequirements !== undefined) {
        $set.programmingDocumentRequirements = sanitizeProgrammingRequirements(
          req.body.programmingDocumentRequirements
        );
      } else if (req.body.isProgramming === true && !type.isProgramming) {
        $set.programmingDocumentRequirements = await getProgrammingRequirementDefaults();
      }

      if (Object.keys($set).length === 0) {
        const jobTypes = await listJobTypesWithUsage();
        const unchanged = jobTypes.find((t) => t._id.toString() === req.params.id);
        return res.json({ success: true, data: { jobType: unchanged, jobTypes } });
      }

      await JobType.findByIdAndUpdate(req.params.id, { $set });
      const jobTypes = await listJobTypesWithUsage();
      const updated = jobTypes.find((t) => t._id.toString() === req.params.id);

      broadcastJobUpdate();
      res.json({ success: true, data: { jobType: updated, jobTypes } });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── DELETE /api/jobs/job-types/:id (ADMIN, OFFICE_MANAGER) ─────────
router.delete(
  '/job-types/:id',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [param('id').isMongoId().withMessage('Invalid job type ID')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const type = await JobType.findById(req.params.id).lean();
      if (!type) {
        return res.status(404).json({ success: false, error: 'Job type not found' });
      }

      const usageCount = await Job.countDocuments({
        $expr: {
          $eq: [{ $toLower: '$jobType' }, type.normalizedName],
        },
      });
      await JobType.findByIdAndDelete(req.params.id);

      const jobTypes = await listJobTypesWithUsage();
      res.json({
        success: true,
        data: {
          deleted: { _id: type._id, name: type.name, usageCount },
          jobTypes,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── GET /api/jobs/:id ────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const job = await withJobDetailPopulate(Job.findById(req.params.id));

    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    if (!canAccessJob(req.user, job)) {
      return res.status(403).json({ success: false, error: 'Not authorized to view this job' });
    }

    let baseRows = null;
    if (job.parentJob) {
      const parentId = job.parentJob?._id || job.parentJob;
      const parentDoc = await Job.findById(parentId)
        .select('assignmentDocumentRequirements assignmentChecklist')
        .lean();
      baseRows = parentDoc?.assignmentDocumentRequirements || [];
      if (parentDoc?.assignmentChecklist) {
        job.assignmentChecklist = parentDoc.assignmentChecklist;
      }
    }
    const resolvedRequirements = await resolveAssignmentRequirementsForJob(job, baseRows);
    if (resolvedRequirements.length > 0) {
      job.assignmentDocumentRequirements = resolvedRequirements;
    }

    const returnVisitJobs = await Job.find({
      parentJob: job._id,
      jobVisitKind: 'RETURN',
    })
      .select('title scheduledDate status _id jobVisitKind parentJob assignedTechnician secondaryAssignedTechnician')
      .sort({ scheduledDate: 1 })
      .lean();

    const data = job.toObject();
    const documentFamilyJobs = await loadDocumentFamilyJobs(job);
    data.documents = mergeFamilyDocuments(documentFamilyJobs);
    data.returnVisitJobs = returnVisitJobs;
    const fsrDoc = await getFsrDocumentByJobId(job._id);
    data.fsrSummary = fsrDoc ? formatFsrDocument(fsrDoc).summary : null;

    // Opening the job marks it "seen" for managers (clears the unseen indicator).
    if (isManagerRole(req.user.role)) {
      const uid = String(req.user._id);
      const alreadySeen = (job.statusSeenBy || []).some((id) => String(id) === uid);
      if (!alreadySeen) {
        await Job.updateOne({ _id: job._id }, { $addToSet: { statusSeenBy: req.user._id } });
      }
      data.statusSeen = true;
    }

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /api/jobs (ADMIN, OFFICE_MANAGER) ──────────────────────────
router.post(
  '/',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('title').notEmpty().withMessage('Job title is required'),
    body('customerId').notEmpty().withMessage('Customer is required').isMongoId().withMessage('Invalid customer ID'),
    body('jobType').notEmpty().withMessage('Job type is required').isString().withMessage('Job type must be a string'),
    body('programmingSubtype').optional().isString().withMessage('Programming subtype must be a string'),
    body('scheduledDate').notEmpty().withMessage('Scheduled date is required').custom(validateScheduledDate),
    body('estimatedCost').optional().isFloat({ min: 0 }).withMessage('Must be a positive number'),
    body('companyName').optional().trim(),
    body('levitonExternalFsrLink').optional().isString().withMessage('External FSR link must be a string'),
    body('siteInfoMode').optional().isIn(['TEXT', 'PDF']).withMessage('Invalid site info mode'),
    body('siteInfoText').optional().isString().withMessage('Site info must be a string'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      // Verify customer exists
      const customer = await Customer.findById(req.body.customerId);
      if (!customer) {
        return res.status(404).json({ success: false, error: 'Customer not found' });
      }

      req.body.jobType = normalizeJobType(req.body.jobType);
      if (!req.body.jobType) {
        return res.status(400).json({ success: false, error: 'Job type is required' });
      }
      req.body.programmingSubtype = normalizeProgrammingSubtype(req.body.programmingSubtype);
      if (await jobTypeIsProgramming(req.body.jobType)) {
        if (!req.body.programmingSubtype) {
          return res.status(400).json({
            success: false,
            error: 'Programming subtype is required for selected job type',
          });
        }
        if (!PROGRAMMING_SUBTYPES.includes(req.body.programmingSubtype)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid programming subtype',
          });
        }
      } else {
        req.body.programmingSubtype = undefined;
      }
      await ensureJobTypeSaved(req.body.jobType);

      const job = await JobService.createJob(req.body, req.user._id);
      await createFsrDocumentForJob(job, {
        levitonExternalLink: req.body.levitonExternalFsrLink,
      });
      await attachFsrSummariesToJobs([job]);

      // Notify admins and managers
      createNotification({
        type: 'JOB_CREATED',
        message: `New job created by ${actorWithRole(req.user)}: "${job.title}" for ${customer.name}`,
        jobId: job._id,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      res.status(201).json({ success: true, data: job });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── GET /api/jobs/:id/fsr ───────────────────────────────────────────
router.get('/:id/fsr', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .select(
        '_id title address customer customerName companyName assignedTechnician secondaryAssignedTechnician status parentJob jobVisitKind'
      )
      .populate('customer', 'name address')
      .populate('assignedTechnician', 'name email')
      .populate('secondaryAssignedTechnician', 'name email')
      .populate('parentJob', 'assignedTechnician secondaryAssignedTechnician');

    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    if (!canAccessJob(req.user, job)) {
      return res.status(403).json({ success: false, error: 'Not authorized to view this FSR' });
    }

    const fsrDoc = await getFsrDocumentByJobId(job._id);
    if (!fsrDoc) {
      return res.status(404).json({ success: false, error: 'No FSR document is attached to this job' });
    }
    if (!canUserOpenVisibleFsr(req.user, job, fsrDoc)) {
      return res.status(403).json({
        success: false,
        error: 'This FSR will become available after you start the completion flow from Mark Completed.',
      });
    }

    await markFsrSeenForManager(fsrDoc, req.user);

    return res.json({ success: true, data: await buildFsrResponseData(job, fsrDoc) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ── POST /api/jobs/:id/fsr/signature-requests ──────────────────────
router.post(
  '/:id/fsr/signature-requests',
  [
    body('signatureFieldKey').isString().notEmpty().withMessage('signatureFieldKey is required'),
    body('recipientEmail').isEmail().withMessage('A valid recipientEmail is required'),
    body('fieldContext').optional().isObject().withMessage('fieldContext must be an object'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const job = await Job.findById(req.params.id)
        .select(
          '_id title address customer customerName companyName assignedTechnician secondaryAssignedTechnician status parentJob jobVisitKind'
        )
        .populate('customer', 'name address')
        .populate('assignedTechnician', 'name email')
        .populate('secondaryAssignedTechnician', 'name email')
        .populate('parentJob', 'assignedTechnician secondaryAssignedTechnician');

      if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to request this signature' });
      }

      const fsrDoc = await getFsrDocumentByJobId(job._id);
      if (!fsrDoc) {
        return res.status(404).json({ success: false, error: 'No FSR document is attached to this job' });
      }
      if (!canUserOpenVisibleFsr(req.user, job, fsrDoc)) {
        return res.status(403).json({
          success: false,
          error: 'This FSR will become available after you start the completion flow from Mark Completed.',
        });
      }
      if (fsrDoc.status === FSR_STATUS.SUBMITTED) {
        return res.status(400).json({ success: false, error: 'Submitted FSRs are read-only' });
      }

      const signatureFieldKey = trimString(req.body.signatureFieldKey);
      const definition = getSignatureRequestDefinition(fsrDoc.templateKey, signatureFieldKey);
      if (!definition) {
        return res.status(400).json({ success: false, error: 'This signature field cannot be requested by email' });
      }

      const fieldContext = sanitizeSignatureRequestContext(signatureFieldKey, req.body.fieldContext);
      const recipientEmail = ensureRequiredEmail(req.body.recipientEmail, 'Recipient email');
      const now = new Date();
      const activeRequest = await getPendingSignatureRequest(fsrDoc._id, signatureFieldKey);

      if (
        activeRequest &&
        activeRequest.status === FSR_SIGNATURE_REQUEST_STATUS.PENDING &&
        activeRequest.nextSendAllowedAt &&
        activeRequest.nextSendAllowedAt > now
      ) {
        return res.status(429).json({
          success: false,
          error: 'Please wait before resending this signature request.',
          data: {
            nextSendAllowedAt: activeRequest.nextSendAllowedAt,
            sendCount: activeRequest.sendCount,
          },
        });
      }

      const nextSendCount =
        activeRequest && activeRequest.status === FSR_SIGNATURE_REQUEST_STATUS.PENDING
          ? Number(activeRequest.sendCount || 1) + 1
          : 1;

      if (activeRequest && activeRequest.status === FSR_SIGNATURE_REQUEST_STATUS.PENDING) {
        activeRequest.status = FSR_SIGNATURE_REQUEST_STATUS.REPLACED;
        await activeRequest.save();
      }

      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const requestDoc = await FsrSignatureRequest.create({
        fsrDocument: fsrDoc._id,
        job: job._id,
        templateKey: fsrDoc.templateKey,
        signatureFieldKey,
        signatureFieldLabel: definition.label,
        recipientEmail,
        token: FsrSignatureRequest.generateToken(),
        status: FSR_SIGNATURE_REQUEST_STATUS.PENDING,
        requestedBy: req.user._id,
        requestedByName: req.user.name,
        requestedAt: now,
        expiresAt,
        sendCount: nextSendCount,
        lastSentAt: now,
        nextSendAllowedAt: buildSignatureRequestNextSendAllowedAt(nextSendCount, now),
        fieldContext: {
          ...fieldContext,
          sectionLabel: definition.sectionLabel,
        },
        jobSnapshot: buildSignatureRequestJobSnapshot(job, fsrDoc),
      });

      await sendFsrSignatureRequestEmail({
        to: recipientEmail,
        token: requestDoc.token,
        signatureFieldLabel: definition.label,
        signatureSectionLabel: definition.sectionLabel,
        requestedByName: req.user.name,
        requestedByRole: req.user.role,
        jobTitle: requestDoc.jobSnapshot?.projectName || job.title || 'Untitled job',
        siteAddress: requestDoc.jobSnapshot?.siteAddress || '',
        companyName: requestDoc.jobSnapshot?.companyName || '',
        customerName: requestDoc.jobSnapshot?.customerName || '',
        expiresAt,
      });

      createNotification({
        type: 'JOB_FSR_SIGNATURE_REQUESTED',
        message: `${actorWithRole(req.user)} requested ${definition.label} by email for job "${job.title}".`,
        jobId: job._id,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      return res.json({
        success: true,
        message:
          nextSendCount > 1 ? 'Signature request resent successfully' : 'Signature request sent successfully',
        data: await buildFsrResponseData(job, fsrDoc),
        meta: {
          request: buildSignatureRequestSummary(requestDoc),
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/jobs/:id/fsr/signature-requests/cancel ───────────────
router.post(
  '/:id/fsr/signature-requests/cancel',
  [body('signatureFieldKey').isString().notEmpty().withMessage('signatureFieldKey is required')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const job = await Job.findById(req.params.id)
        .select(
          '_id title address customer customerName companyName assignedTechnician secondaryAssignedTechnician status parentJob jobVisitKind'
        )
        .populate('customer', 'name address')
        .populate('assignedTechnician', 'name email')
        .populate('secondaryAssignedTechnician', 'name email')
        .populate('parentJob', 'assignedTechnician secondaryAssignedTechnician');

      if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to update this FSR' });
      }

      const fsrDoc = await getFsrDocumentByJobId(job._id);
      if (!fsrDoc) {
        return res.status(404).json({ success: false, error: 'No FSR document is attached to this job' });
      }
      if (!canUserOpenVisibleFsr(req.user, job, fsrDoc)) {
        return res.status(403).json({
          success: false,
          error: 'This FSR will become available after you start the completion flow from Mark Completed.',
        });
      }
      if (fsrDoc.status === FSR_STATUS.SUBMITTED) {
        return res.status(400).json({ success: false, error: 'Submitted FSRs are read-only' });
      }

      const cancelled = await cancelPendingSignatureRequest(
        fsrDoc._id,
        trimString(req.body.signatureFieldKey),
        FSR_SIGNATURE_REQUEST_STATUS.CANCELLED
      );

      return res.json({
        success: true,
        data: await buildFsrResponseData(job, fsrDoc),
        meta: { cancelled: Boolean(cancelled) },
      });
    } catch (error) {
      return res.status(error.status || 500).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/jobs/:id/fsr/open ─────────────────────────────────────
router.post('/:id/fsr/open', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .select(
        '_id title address customer customerName companyName assignedTechnician secondaryAssignedTechnician status parentJob jobVisitKind'
      )
      .populate('customer', 'name address')
      .populate('assignedTechnician', 'name email')
      .populate('secondaryAssignedTechnician', 'name email')
      .populate('parentJob', 'assignedTechnician secondaryAssignedTechnician');

    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    if (!canAccessJob(req.user, job)) {
      return res.status(403).json({ success: false, error: 'Not authorized to open this FSR' });
    }

    let fsrDoc = await getFsrDocumentByJobId(job._id);
    if (!fsrDoc) {
      return res.status(404).json({ success: false, error: 'No FSR document is attached to this job' });
    }

    let technicianVisibleUnlocked = false;

    if (req.user.role === ROLES.TECHNICIAN && !fsrDoc.technicianVisible) {
      if (job.status !== JOB_STATUS.IN_PROGRESS) {
        return res.status(403).json({
          success: false,
          error: 'The FSR is only accessible while the job is in progress.',
        });
      }

      const unlockedDoc = await FsrDocument.findOneAndUpdate(
        { job: job._id, technicianVisible: { $ne: true } },
        { $set: { technicianVisible: true, technicianVisibleAt: new Date() } },
        { new: true }
      );
      technicianVisibleUnlocked = Boolean(unlockedDoc);
      fsrDoc = unlockedDoc || (await getFsrDocumentByJobId(job._id));
    }

    if (!canUserOpenVisibleFsr(req.user, job, fsrDoc)) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to open this FSR.',
      });
    }

    const transitionedDoc = hasAssignedTechnician(job)
      ? await FsrDocument.findOneAndUpdate(
          { job: job._id, status: FSR_STATUS.NOT_STARTED },
          { $set: { status: FSR_STATUS.IN_PROGRESS } },
          { new: true }
        )
      : null;

    const transitionedToInProgress = Boolean(transitionedDoc);
    const shouldNotifyOpened = transitionedToInProgress || technicianVisibleUnlocked;

    if (transitionedDoc) {
      fsrDoc = transitionedDoc;
    } else if (!fsrDoc) {
      fsrDoc = await getFsrDocumentByJobId(job._id);
    }

    if (shouldNotifyOpened) {
      createNotification({
        type: 'JOB_FSR_OPENED',
        message: `${actorWithRole(req.user)} started the ${formatFsrDocument(fsrDoc).templateLabel} for job "${job.title}"`,
        jobId: job._id,
        recipientIds: getVisibleFsrTechnicianRecipientIds(job, fsrDoc),
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
    }

    return res.json({
      success: true,
      data: await buildFsrResponseData(job, fsrDoc),
      meta: { transitionedToInProgress, technicianVisibleUnlocked },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ── PATCH /api/jobs/:id/fsr/link ────────────────────────────────────
router.patch(
  '/:id/fsr/link',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [body('levitonExternalLink').optional().isString().withMessage('levitonExternalLink must be a string')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const job = await Job.findById(req.params.id)
        .select('_id title assignedTechnician secondaryAssignedTechnician');
      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }

      const fsrDoc = await getFsrDocumentByJobId(req.params.id);
      if (!fsrDoc) {
        return res.status(404).json({ success: false, error: 'No FSR document is attached to this job' });
      }
      if (fsrDoc.templateKey !== FSR_TEMPLATE.LEVITON_EXTERNAL) {
        return res.status(400).json({ success: false, error: 'External link is only available for Leviton FSRs' });
      }
      if (fsrDoc.status === FSR_STATUS.SUBMITTED) {
        return res.status(400).json({ success: false, error: 'Submitted FSRs are read-only' });
      }

      fsrDoc.levitonExternalLink = normalizeLevitonExternalLink(req.body.levitonExternalLink);
      await fsrDoc.save();

      const recipientIds = [];

      createNotification({
        type: 'JOB_FSR_LINK_UPDATED',
        message: `${actorWithRole(req.user)} updated the external Leviton FSR link for job "${job.title}".`,
        jobId: job._id,
        recipientIds: getVisibleFsrTechnicianRecipientIds(job, fsrDoc),
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      return res.json({ success: true, data: await attachAssetUrlsToFsrData(formatFsrDocument(fsrDoc)) });
    } catch (error) {
      const status = error.status || 500;
      return res.status(status).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/jobs/:id/fsr/template ────────────────────────────────
router.patch(
  '/:id/fsr/template',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('templateKey')
      .isString()
      .custom((value) => Object.values(FSR_TEMPLATE).includes(value))
      .withMessage('templateKey must be a valid FSR template'),
    body('levitonExternalLink').optional().isString().withMessage('levitonExternalLink must be a string'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const job = await Job.findById(req.params.id)
        .select(
          '_id title address customer customerName companyName jobType programmingSubtype assignedTechnician secondaryAssignedTechnician status parentJob jobVisitKind'
        )
        .populate('customer', 'name address')
        .populate('assignedTechnician', 'name email')
        .populate('secondaryAssignedTechnician', 'name email')
        .populate('parentJob', 'assignedTechnician secondaryAssignedTechnician');
      if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

      const fsrDoc = await getFsrDocumentByJobId(job._id);
      if (!fsrDoc) {
        return res.status(404).json({ success: false, error: 'No FSR document is attached to this job' });
      }
      if (fsrDoc.status === FSR_STATUS.SUBMITTED) {
        return res.status(400).json({ success: false, error: 'Submitted FSRs are read-only' });
      }

      const nextTemplateKey = req.body.templateKey;
      if (fsrDoc.templateKey === nextTemplateKey) {
        return res.json({
          success: true,
          data: await buildFsrResponseData(job, fsrDoc),
          meta: { changed: false },
        });
      }

      const previousTemplateLabel = formatFsrDocument(fsrDoc).templateLabel;
      const defaultTemplateKey = resolveFsrTemplateForJobType(job.jobType, {
        programmingSubtype: job.programmingSubtype,
      });

      fsrDoc.templateKey = nextTemplateKey;
      fsrDoc.templateSource =
        nextTemplateKey === defaultTemplateKey
          ? FSR_TEMPLATE_SOURCE.AUTO
          : FSR_TEMPLATE_SOURCE.MANUAL_OVERRIDE;
      fsrDoc.status = FSR_STATUS.NOT_STARTED;
      fsrDoc.jobSnapshot = undefined;
      fsrDoc.submissionData = undefined;
      fsrDoc.draftSignatures = {};
      fsrDoc.assets = [];
      fsrDoc.submittedBy = null;
      fsrDoc.submittedAt = null;
      fsrDoc.levitonExternalLink =
        nextTemplateKey === FSR_TEMPLATE.LEVITON_EXTERNAL
          ? normalizeLevitonExternalLink(req.body.levitonExternalLink)
          : '';

      await fsrDoc.save();
      await cancelPendingSignatureRequestsForFsr(
        fsrDoc._id,
        FSR_SIGNATURE_REQUEST_STATUS.CANCELLED
      );

      createNotification({
        type: 'JOB_FSR_TEMPLATE_CHANGED',
        message: `${actorWithRole(req.user)} changed the FSR for job "${job.title}" from ${previousTemplateLabel} to ${formatFsrDocument(fsrDoc).templateLabel}.`,
        jobId: job._id,
        recipientIds: getVisibleFsrTechnicianRecipientIds(job, fsrDoc),
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      return res.json({
        success: true,
        data: await buildFsrResponseData(job, fsrDoc),
        meta: { changed: true },
      });
    } catch (error) {
      const status = error.status || 500;
      return res.status(status).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/jobs/:id/fsr/assets/presign ───────────────────────────
router.post(
  '/:id/fsr/assets/presign',
  [
    body('files').isArray({ min: 1 }).withMessage('files must be a non-empty array'),
    body('files.*.name').notEmpty().withMessage('file name is required'),
    body('files.*.contentType').optional().isString(),
    body('files.*.size').optional().isInt({ min: 0 }).withMessage('file size must be >= 0'),
    body('files.*.caption').optional().isString().withMessage('file caption must be a string'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const job = await Job.findById(req.params.id)
        .select('_id title status assignedTechnician secondaryAssignedTechnician parentJob jobVisitKind')
        .populate('parentJob', 'assignedTechnician secondaryAssignedTechnician');
      if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to upload FSR assets for this job' });
      }

      const fsrDoc = await getFsrDocumentByJobId(job._id);
      if (!fsrDoc) {
        return res.status(404).json({ success: false, error: 'No FSR document is attached to this job' });
      }
      if (!canUserOpenVisibleFsr(req.user, job, fsrDoc)) {
        return res.status(403).json({
          success: false,
          error: 'This FSR will become available after you start the completion flow from Mark Completed.',
        });
      }
      if (fsrDoc.status === FSR_STATUS.SUBMITTED) {
        return res.status(400).json({ success: false, error: 'Submitted FSRs are read-only' });
      }

      const files = req.body.files.slice(0, FSR_MAX_ASSETS);
      const invalid = files.find((file) => {
        const ext = String(file.name || '').split('.').pop().toLowerCase();
        return !FSR_IMAGE_EXTENSIONS.has(ext);
      });
      if (invalid) {
        return res.status(400).json({
          success: false,
          error: `File type not allowed: "${invalid.name}". Accepted: PNG, JPG, JPEG, WEBP, HEIC, HEIF`,
        });
      }

      const uploads = await Promise.all(
        files.map(async (file) => {
          const key = buildFsrAssetKey(job._id.toString(), file.name);
          const contentType = file.contentType || 'application/octet-stream';
          const presignedUrl = await getUploadUrl({ key, contentType, expiresIn: 300 });
          return {
            key,
            fileName: file.name,
            contentType,
            size: Number(file.size) || 0,
            caption: trimString(file.caption),
            presignedUrl,
            expiresIn: 300,
          };
        })
      );

      return res.json({ success: true, data: { uploads } });
    } catch (error) {
      const status = error.status || 500;
      return res.status(status).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/jobs/:id/fsr/submit ───────────────────────────────────
router.post(
  '/:id/fsr/submit',
  [body('submissionData').optional().isObject().withMessage('submissionData must be an object')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const job = await Job.findById(req.params.id)
        .select(
          '_id title address customer customerName companyName assignedTechnician secondaryAssignedTechnician status parentJob jobVisitKind'
        )
        .populate('customer', 'name address')
        .populate('assignedTechnician', 'name email')
        .populate('secondaryAssignedTechnician', 'name email')
        .populate('parentJob', 'assignedTechnician secondaryAssignedTechnician');
      if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to submit this FSR' });
      }

      const fsrDoc = await getFsrDocumentByJobId(job._id);
      if (!fsrDoc) {
        return res.status(404).json({ success: false, error: 'No FSR document is attached to this job' });
      }
      if (!canUserOpenVisibleFsr(req.user, job, fsrDoc)) {
        return res.status(403).json({
          success: false,
          error: 'This FSR will become available after you start the completion flow from Mark Completed.',
        });
      }
      if (fsrDoc.status === FSR_STATUS.SUBMITTED) {
        return res.status(400).json({ success: false, error: 'This FSR has already been submitted' });
      }
      if (
        fsrDoc.templateKey === FSR_TEMPLATE.LEVITON_EXTERNAL &&
        !trimString(fsrDoc.levitonExternalLink)
      ) {
        return res.status(400).json({
          success: false,
          error: 'An external Leviton FSR link must be set before submitting this form',
        });
      }

      const { submissionData, assets } = await buildSubmissionPayloadForFsr({
        fsrDoc,
        submissionData: req.body.submissionData,
        job,
        userId: req.user._id,
      });

      fsrDoc.status = FSR_STATUS.SUBMITTED;
      fsrDoc.jobSnapshot = buildJobSnapshot(job);
      fsrDoc.submissionData = submissionData;
      fsrDoc.draftSignatures = {};
      fsrDoc.assets = assets;
      fsrDoc.submittedBy = req.user._id;
      fsrDoc.submittedAt = new Date();
      fsrDoc.seenBy = [];
      await fsrDoc.save();
      await cancelPendingSignatureRequestsForFsr(
        fsrDoc._id,
        FSR_SIGNATURE_REQUEST_STATUS.CANCELLED
      );
      await fsrDoc.populate('submittedBy', 'name email role');

      createNotification({
        type: 'JOB_FSR_SUBMITTED',
        message: `${actorWithRole(req.user)} submitted the ${formatFsrDocument(fsrDoc).templateLabel} for job "${job.title}"`,
        jobId: job._id,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      return res.json({ success: true, data: await attachAssetUrlsToFsrData(formatFsrDocument(fsrDoc)) });
    } catch (error) {
      const status = error.status || 500;
      return res.status(status).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/jobs/:id/documents/presign ───────────────────────────
router.post(
  '/:id/documents/presign',
  [
    body('files').isArray({ min: 1 }).withMessage('files must be a non-empty array'),
    body('files.*.name').notEmpty().withMessage('file name is required'),
    body('files.*.contentType').optional().isString(),
    body('files.*.size').optional().isInt({ min: 0 }).withMessage('file size must be >= 0'),
    body('files.*.note').optional().isString().withMessage('file note must be a string'),
    body('files.*.isSiteInfo').optional().isBoolean().withMessage('isSiteInfo must be a boolean'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const job = await Job.findById(req.params.id)
        .select('_id title status assignedTechnician secondaryAssignedTechnician parentJob jobVisitKind')
        .populate('parentJob', 'assignedTechnician secondaryAssignedTechnician');
      if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to upload documents for this job' });
      }

      const files = req.body.files.slice(0, 10);

      const ALLOWED_EXT = new Set(['pdf', 'doc', 'docx', 'txt', 'xml']);
      const invalid = files.find((f) => {
        const ext = (f.name || '').split('.').pop().toLowerCase();
        return !ALLOWED_EXT.has(ext);
      });
      if (invalid) {
        return res.status(400).json({
          success: false,
          error: `File type not allowed: "${invalid.name}". Accepted: PDF, DOC, DOCX, TXT, XML`,
        });
      }

      const uploads = await Promise.all(
        files.map(async (file) => {
          const key = buildDocumentKey(job._id.toString(), file.name);
          const contentType = file.contentType || 'application/octet-stream';
          const presignedUrl = await getUploadUrl({ key, contentType, expiresIn: 300 });
          return {
            key,
            fileName: file.name,
            contentType,
            size: Number(file.size) || 0,
            note: normalizeDocNote(file.note),
            isSiteInfo: Boolean(file.isSiteInfo),
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

// ── POST /api/jobs/:id/documents/complete ──────────────────────────
router.post(
  '/:id/documents/complete',
  [
    body('documents').isArray({ min: 1 }).withMessage('documents must be a non-empty array'),
    body('documents.*.key').notEmpty().withMessage('document key is required'),
    body('documents.*.fileName').notEmpty().withMessage('document fileName is required'),
    body('documents.*.note').optional().isString().withMessage('document note must be a string'),
    body('documents.*.isSiteInfo').optional().isBoolean().withMessage('isSiteInfo must be a boolean'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const job = await Job.findById(req.params.id)
        .select('_id title status assignedTechnician secondaryAssignedTechnician documents parentJob jobVisitKind')
        .populate('assignedTechnician', 'name email')
        .populate('parentJob', 'assignedTechnician secondaryAssignedTechnician');

      if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to add documents for this job' });
      }

      const incoming = req.body.documents.slice(0, 10);
      const createdDocs = [];

      for (const item of incoming) {
        if (!item.key.startsWith(`jobs/${job._id}/documents/`)) {
          return res.status(400).json({ success: false, error: 'Invalid document key for this job' });
        }

        const meta = await headObject(item.key);
        createdDocs.push({
          _id: new mongoose.Types.ObjectId(),
          key: item.key,
          fileName: item.fileName,
          contentType: meta.ContentType || 'application/octet-stream',
          size: Number(meta.ContentLength) || 0,
          note: normalizeDocNote(item.note),
          isSiteInfo: Boolean(item.isSiteInfo),
          uploadedBy: req.user._id,
          uploadedAt: new Date(),
        });
      }

      const familyJobs = await loadDocumentFamilyJobs(job);
      for (const familyJob of familyJobs) {
        const existingKeys = new Set((familyJob.documents || []).map((doc) => String(doc.key || '')));
        const additions = cloneDocumentEntries(createdDocs).filter((doc) => !existingKeys.has(doc.key));
        if (!additions.length) continue;
        familyJob.documents.push(...additions);
        await familyJob.save();
      }

      const requestFamilyJob =
        familyJobs.find((familyJob) => String(familyJob._id) === String(job._id)) || job;
      await requestFamilyJob.populate('documents.uploadedBy', 'name email role');

      const latestKeys = new Set(createdDocs.map((doc) => doc.key));
      const latest = (requestFamilyJob.documents || []).filter((doc) => latestKeys.has(doc.key));
      const firstFile = latest[0]?.fileName || 'document';
      const message = latest.length === 1
        ? `${actorWithRole(req.user)} uploaded "${firstFile}" to job "${job.title}"`
        : `${actorWithRole(req.user)} uploaded ${latest.length} documents to job "${job.title}"`;

      const recipientIds = [];
      if (job.assignedTechnician?._id) recipientIds.push(job.assignedTechnician._id);
      if (job.secondaryAssignedTechnician) recipientIds.push(job.secondaryAssignedTechnician);

      createNotification({
        type: 'JOB_DOCUMENT_UPLOADED',
        message,
        jobId: job._id,
        recipientIds,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      res.json({ success: true, data: { documents: latest } });
    } catch (error) {
      const status = error.status || 500;
      res.status(status).json({ success: false, error: error.message });
    }
  }
);

// ── GET /api/jobs/:id/documents/:docId/url ─────────────────────────
router.get('/:id/documents/:docId/url', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .select('_id status assignedTechnician secondaryAssignedTechnician documents parentJob jobVisitKind')
      .populate('parentJob', 'assignedTechnician secondaryAssignedTechnician');

    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    if (!canAccessJob(req.user, job)) {
      return res.status(403).json({ success: false, error: 'Not authorized to view documents for this job' });
    }

    const familyJobs = await loadDocumentFamilyJobs(job);
    const match = findDocumentInFamilyJobs(familyJobs, req.params.docId);
    const doc = match?.doc;
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });

    const url = await getDownloadUrl({
      key: doc.key,
      fileName: doc.fileName,
      contentType: doc.contentType,
      expiresIn: 900,
    });

    res.json({
      success: true,
      data: {
        url,
        fileName: doc.fileName,
        contentType: doc.contentType,
      },
    });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// ── DELETE /api/jobs/:id/documents/:docId ───────────────────────────
router.delete('/:id/documents/:docId', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .select('_id title status assignedTechnician secondaryAssignedTechnician documents parentJob jobVisitKind')
      .populate('assignedTechnician', 'name email')
      .populate('parentJob', 'assignedTechnician secondaryAssignedTechnician');

    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    if (!canAccessJob(req.user, job)) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const familyJobs = await loadDocumentFamilyJobs(job);
    const match = findDocumentInFamilyJobs(familyJobs, req.params.docId);
    const doc = match?.doc;
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });

    // Only the uploader can delete their own documents
    const uploadedById = doc.uploadedBy?._id || doc.uploadedBy;
    if (!uploadedById || uploadedById.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, error: 'You can only delete documents you uploaded' });
    }

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    const fileName = doc.fileName;

    // Delete from S3 (fire-and-forget, doc is removed from DB regardless)
    try { await deleteObject(doc.key); } catch { /* ignore S3 errors */ }

    // Remove from every linked job so parent/return rows stay mirrored
    for (const familyJob of familyJobs) {
      const filteredDocs = (familyJob.documents || []).filter(
        (item) =>
          String(item._id) !== String(req.params.docId) &&
          String(item.key || '') !== String(doc.key || '')
      );
      if (filteredDocs.length === (familyJob.documents || []).length) continue;
      familyJob.set('documents', filteredDocs);
      await familyJob.save();
    }

    // Notify admins/managers + assigned tech
    const recipientIds = [];
    if (job.assignedTechnician?._id) recipientIds.push(job.assignedTechnician._id);
    if (job.secondaryAssignedTechnician) recipientIds.push(job.secondaryAssignedTechnician);

    let message = `${actorWithRole(req.user)} deleted "${fileName}" from job "${job.title}"`;
    if (reason) message += ` - Reason: ${reason}`;

    createNotification({
      type: 'JOB_DOCUMENT_DELETED',
      message,
      jobId: job._id,
      recipientIds,
      recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
      excludeUserId: req.user._id,
    });

    broadcastJobUpdate();
    res.json({ success: true });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

// ── PATCH /api/jobs/:id/documents/:docId (ADMIN, OFFICE_MANAGER) ─────
// Toggle whether a document is the job-site info document shown to techs.
router.patch(
  '/:id/documents/:docId',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [body('isSiteInfo').isBoolean().withMessage('isSiteInfo must be a boolean')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const job = await Job.findById(req.params.id)
        .select('_id status documents parentJob jobVisitKind')
        .populate('parentJob', '_id');
      if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized' });
      }

      const familyJobs = await loadDocumentFamilyJobs(job);
      const match = findDocumentInFamilyJobs(familyJobs, req.params.docId);
      const doc = match?.doc;
      if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });

      const nextValue = Boolean(req.body.isSiteInfo);
      // Mirror the flag onto the same document across all linked family jobs.
      for (const familyJob of familyJobs) {
        let changed = false;
        for (const item of familyJob.documents || []) {
          if (
            String(item._id) === String(req.params.docId) ||
            String(item.key || '') === String(doc.key || '')
          ) {
            item.isSiteInfo = nextValue;
            changed = true;
          }
        }
        if (changed) await familyJob.save();
      }

      broadcastJobUpdate();
      res.json({ success: true });
    } catch (error) {
      const status = error.status || 500;
      res.status(status).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/jobs/:id/incomplete-return-request (TECHNICIAN or ADMIN / OFFICE_MANAGER) ──
router.post(
  '/:id/incomplete-return-request',
  [
    param('id').isMongoId().withMessage('Invalid job ID'),
    body('reasonType').isIn(INCOMPLETE_RETURN_REASON_TYPES).withMessage('Invalid reason type'),
    body('describeReason').optional().isString(),
    body('manufacturer').optional().isObject(),
    body('manufacturer.partsNeeded').optional().isString(),
    body('manufacturer.rmaStatus').optional().isIn(RMA_STATUSES).withMessage('Invalid RMA status'),
    body('needsManagerContactStatic').optional().isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const parent = await Job.findById(req.params.id)
        .select(
          '_id title status assignedTechnician secondaryAssignedTechnician parentJob incompleteReturnRequest statusHistory'
        )
        .populate('parentJob', 'assignedTechnician secondaryAssignedTechnician');

      if (!parent) return res.status(404).json({ success: false, error: 'Job not found' });
      if (parent.parentJob) {
        return res.status(400).json({ success: false, error: 'Use the original job, not a return visit row' });
      }
      if (!canSubmitIncompleteReturnRequest(req.user, parent)) {
        return res.status(403).json({
          success: false,
          error:
            'You are not allowed to submit an Incomplete / Return request for this job (assigned technician, admin, or office manager with access only).',
        });
      }
      if (parent.incompleteReturnRequest?.status === 'PENDING') {
        return res.status(400).json({ success: false, error: 'An Incomplete / Return request is already pending approval.' });
      }
      if (parent.incompleteReturnRequest?.status === 'APPROVED') {
        return res.status(400).json({
          success: false,
          error: 'This job is no longer open for a new Incomplete / Return request.',
        });
      }
      const existingReturnVisit = await Job.exists({
        parentJob: parent._id,
        jobVisitKind: 'RETURN',
      });
      if (existingReturnVisit) {
        return res.status(400).json({
          success: false,
          error: 'A linked return visit has already been created for this job.',
        });
      }

      const reasonType = req.body.reasonType;
      const describeReason = String(req.body.describeReason || '').trim();
      const needsManagerContactStatic = Boolean(req.body.needsManagerContactStatic);
      let manufacturer = { partsNeeded: '', rmaStatus: 'WAITING' };
      if (reasonType === 'MANUFACTURER') {
        manufacturer.partsNeeded = String(req.body.manufacturer?.partsNeeded || '').trim();
        const rma = req.body.manufacturer?.rmaStatus || 'WAITING';
        manufacturer.rmaStatus = RMA_STATUSES.includes(rma) ? rma : 'WAITING';
        if (!manufacturer.partsNeeded) {
          return res.status(400).json({
            success: false,
            error: 'Parts needed is required for manufacturer issues.',
          });
        }
      }
      if (reasonType === 'OUR_ISSUE' && !describeReason) {
        return res.status(400).json({
          success: false,
          error: 'Describe reason is required for our issue.',
        });
      }

      const storedDescribeReason = reasonType === 'OUR_ISSUE' ? describeReason : '';

      parent.incompleteReturnRequest = {
        status: 'PENDING',
        reasonType,
        describeReason: storedDescribeReason,
        needsManagerContactStatic,
        manufacturer: reasonType === 'MANUFACTURER' ? manufacturer : { partsNeeded: '', rmaStatus: 'WAITING' },
        submittedBy: req.user._id,
        submittedAt: new Date(),
        reviewedBy: null,
        reviewedAt: null,
        adminReviewNotes: '',
      };
      parent.markModified('incompleteReturnRequest');
      pushStatusHistoryNote(
        parent,
        req.user._id,
        `Incomplete / Return request submitted (${reasonType}) - pending Admin / Office Manager approval.`
      );
      await parent.save();

      createNotification({
        type: 'JOB_INCOMPLETE_RETURN_REQUESTED',
        message: `${actorWithRole(req.user)} submitted an Incomplete / Return request for "${parent.title}" (approval required).`,
        jobId: parent._id,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      const updated = await withJobDetailPopulate(Job.findById(parent._id));
      res.status(201).json({ success: true, data: updated });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/jobs/:id/incomplete-return-request/review ─────────────
router.patch(
  '/:id/incomplete-return-request/review',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    param('id').isMongoId().withMessage('Invalid job ID'),
    body('decision').isIn(['APPROVED', 'REJECTED']).withMessage('decision must be APPROVED or REJECTED'),
    body('adminReviewNotes').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const parent = await Job.findById(req.params.id).select(
        '_id title status assignedTechnician secondaryAssignedTechnician parentJob incompleteReturnRequest statusHistory'
      );

      if (!parent) return res.status(404).json({ success: false, error: 'Job not found' });
      if (!canAccessJob(req.user, parent)) {
        return res.status(403).json({ success: false, error: 'Not authorized' });
      }
      if (parent.parentJob) {
        return res.status(400).json({ success: false, error: 'Not applicable to a return visit row' });
      }
      if (parent.incompleteReturnRequest?.status !== 'PENDING') {
        return res.status(400).json({ success: false, error: 'No pending Incomplete / Return request to review.' });
      }

      const submittedBy = parent.incompleteReturnRequest.submittedBy;
      if (submittedBy && String(submittedBy) === String(req.user._id)) {
        return res.status(400).json({
          success: false,
          error: 'You cannot approve or reject an Incomplete / Return request that you submitted. Ask another admin or office manager.',
        });
      }

      const decision = req.body.decision;
      const adminReviewNotes = String(req.body.adminReviewNotes || '').trim();

      parent.incompleteReturnRequest.status = decision;
      parent.incompleteReturnRequest.reviewedBy = req.user._id;
      parent.incompleteReturnRequest.reviewedAt = new Date();
      parent.incompleteReturnRequest.adminReviewNotes = adminReviewNotes;
      parent.markModified('incompleteReturnRequest');

      const reasonLabel =
        parent.incompleteReturnRequest.reasonType === 'MANUFACTURER' ? 'Manufacturer issue' : 'Our issue';
      const reviewLine =
        `Incomplete / Return request ${decision === 'APPROVED' ? 'approved' : 'rejected'} (${reasonLabel}).${adminReviewNotes ? ` Notes: ${adminReviewNotes}` : ''}`;
      pushStatusHistoryNote(parent, req.user._id, reviewLine);
      await parent.save();

      const techRecipients = [];
      if (parent.assignedTechnician) techRecipients.push(parent.assignedTechnician);
      if (parent.secondaryAssignedTechnician) techRecipients.push(parent.secondaryAssignedTechnician);

      const type =
        decision === 'APPROVED' ? 'JOB_INCOMPLETE_RETURN_APPROVED' : 'JOB_INCOMPLETE_RETURN_REJECTED';
      const msg =
        decision === 'APPROVED'
          ? `${actorWithRole(req.user)} approved the Incomplete / Return request for "${parent.title}".`
          : `${actorWithRole(req.user)} rejected the Incomplete / Return request for "${parent.title}".`;

      createNotification({
        type,
        message: msg,
        jobId: parent._id,
        meta: {
          actionLabel: 'Click to view job details.',
          reviewDecision: decision,
          reviewedAt: parent.incompleteReturnRequest.reviewedAt,
          adminReviewNotes: adminReviewNotes || undefined,
        },
        recipientIds: techRecipients,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      const updated = await withJobDetailPopulate(Job.findById(parent._id));

      res.json({
        success: true,
        data: updated,
        openSetReturnVisit: decision === 'APPROVED',
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/jobs/:id/return-visit (ADMIN, OFFICE_MANAGER) ──────────
router.post(
  '/:id/return-visit',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    param('id').isMongoId().withMessage('Invalid job ID'),
    body('scheduledDate').notEmpty().withMessage('Return date is required').custom(validateScheduledDate),
    body('notes').optional().isString(),
    body('paymentDiscussionNeeded').optional().isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const parent = await Job.findById(req.params.id)
        .select(
          '_id title description status customer companyName customerName customerPhone customerEmail address jobType programmingSubtype estimatedCost notes assignedTechnician secondaryAssignedTechnician createdBy parentJob jobVisitKind returnWorkflow incompleteReturnRequest statusHistory documents'
        )
        .populate('parentJob', 'assignedTechnician secondaryAssignedTechnician');

      if (!parent) return res.status(404).json({ success: false, error: 'Job not found' });
      if (parent.parentJob) {
        return res.status(400).json({ success: false, error: 'Return visits can only be created from the original job, not a return row' });
      }
      if (!canCreateReturnVisitJob(req.user, parent)) {
        if (parent.incompleteReturnRequest?.status !== 'APPROVED') {
          return res.status(403).json({
            success: false,
            error:
              'The technician’s Incomplete / Return request must be approved before you can schedule a return visit.',
          });
        }
        return res.status(403).json({ success: false, error: 'Not authorized to create a return visit for this job.' });
      }
      const existingReturnVisit = await Job.exists({
        parentJob: parent._id,
        jobVisitKind: 'RETURN',
      });
      if (existingReturnVisit) {
        return res.status(400).json({
          success: false,
          error: 'A linked return visit has already been created for this job.',
        });
      }

      const normalizedDate = normalizeDateOnly(req.body.scheduledDate);
      const notes = typeof req.body.notes === 'string' ? req.body.notes.trim() : '';
      const paymentDiscussionNeeded =
        req.body.paymentDiscussionNeeded === undefined ? true : Boolean(req.body.paymentDiscussionNeeded);

      const childData = {
        title: parent.title,
        description: parent.description || '',
        customer: parent.customer,
        companyName: parent.companyName,
        customerName: parent.customerName,
        customerPhone: parent.customerPhone,
        customerEmail: parent.customerEmail,
        address: parent.address,
        scheduledDate: normalizedDate,
        status: JOB_STATUS.ASSIGNED,
        assignedTechnician: parent.assignedTechnician || undefined,
        secondaryAssignedTechnician: parent.secondaryAssignedTechnician || undefined,
        createdBy: req.user._id,
        parentJob: parent._id,
        jobVisitKind: 'RETURN',
        jobType: parent.jobType,
        programmingSubtype: parent.programmingSubtype,
        estimatedCost: parent.estimatedCost,
        notes: notes || undefined,
        documents: cloneDocumentEntries(parent.documents),
        statusHistory: [
          ...cloneStatusHistoryEntries(parent.statusHistory),
          {
            fromStatus: null,
            toStatus: JOB_STATUS.ASSIGNED,
            changedBy: req.user._id,
            changedAt: new Date(),
            notes: 'Return visit scheduled and assigned',
          },
        ],
      };

      const child = await Job.create(childData);
      await child.populate([
        { path: 'assignedTechnician', select: 'name email' },
        { path: 'secondaryAssignedTechnician', select: 'name email' },
        { path: 'createdBy', select: 'name email' },
        { path: 'customer', select: 'name phone email address firstPageRequired' },
        { path: 'parentJob', select: 'title scheduledDate status' },
      ]);
      const parentFsrDoc = await getFsrDocumentByJobId(parent._id);
      await createFsrDocumentForJob(child, {
        levitonExternalLink: parentFsrDoc?.levitonExternalLink || '',
      });
      await attachFsrSummariesToJobs([child]);

      if (!parent.returnWorkflow) parent.returnWorkflow = {};
      parent.returnWorkflow.reason = 'RETURN_VISIT';
      parent.returnWorkflow.returnNotes = notes;
      parent.returnWorkflow.paymentDiscussionNeeded = paymentDiscussionNeeded;
      parent.markModified('returnWorkflow');

      pushStatusHistoryNote(
        parent,
        req.user._id,
        `Return visit job created for ${normalizedDate} (linked child job).`
      );
      await parent.save();

      const techRecipients = [];
      if (parent.assignedTechnician) techRecipients.push(parent.assignedTechnician);
      if (parent.secondaryAssignedTechnician) techRecipients.push(parent.secondaryAssignedTechnician);

      const payHint = paymentDiscussionNeeded ? ' Payment / billing may need coordination.' : '';
      createNotification({
        type: 'JOB_RETURN_VISIT_CREATED',
        message: `${actorWithRole(req.user)} scheduled a return visit for "${parent.title}" on ${normalizedDate}.${payHint}`,
        jobId: parent._id,
        meta: notes ? { note: notes } : undefined,
        recipientIds: techRecipients,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      res.status(201).json({ success: true, data: { childJob: child, parentJob: parent } });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/jobs/:id/return-workflow ─────────────────────────────
router.patch(
  '/:id/return-workflow',
  [
    param('id').isMongoId().withMessage('Invalid job ID'),
    body('reason').optional().isIn(RETURN_WORKFLOW_REASONS).withMessage('Invalid reason'),
    body('returnNotes').optional().isString(),
    body('paymentDiscussionNeeded').optional().isBoolean(),
    body('manufacturer').optional().isObject(),
    body('manufacturer.partsNeeded').optional().isString(),
    body('manufacturer.rmaStatus').optional().isIn(RMA_STATUSES).withMessage('Invalid RMA status'),
    body('ourIssue').optional().isObject(),
    body('ourIssue.techRequestedAdminContact').optional().isBoolean(),
    body('ourIssue.reviewStatus').optional().isIn(OUR_ISSUE_REVIEW_STATUSES).withMessage('Invalid review status'),
    body('ourIssue.reviewNotes').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const workflowJob = await loadReturnWorkflowTargetJob(req.params.id);
      if (!workflowJob) return res.status(404).json({ success: false, error: 'Job not found' });
      if (!canEditReturnWorkflow(req.user, workflowJob)) {
        return res.status(403).json({ success: false, error: 'Not authorized to update return workflow' });
      }

      if (!workflowJob.returnWorkflow) {
        workflowJob.returnWorkflow = {};
      }

      const isPrivileged = [ROLES.ADMIN, ROLES.OFFICE_MANAGER].includes(req.user.role);
      const prevOur = workflowJob.returnWorkflow?.ourIssue?.techRequestedAdminContact;
      const prevRma = workflowJob.returnWorkflow?.manufacturer?.rmaStatus;
      const prevParts = workflowJob.returnWorkflow?.manufacturer?.partsNeeded;

      if (req.body.reason !== undefined) workflowJob.returnWorkflow.reason = req.body.reason;
      if (req.body.returnNotes !== undefined) {
        workflowJob.returnWorkflow.returnNotes = String(req.body.returnNotes || '').trim();
      }
      if (req.body.paymentDiscussionNeeded !== undefined) {
        workflowJob.returnWorkflow.paymentDiscussionNeeded = Boolean(req.body.paymentDiscussionNeeded);
      }

      if (req.body.manufacturer) {
        if (req.body.manufacturer.partsNeeded !== undefined) {
          workflowJob.returnWorkflow.manufacturer = workflowJob.returnWorkflow.manufacturer || {};
          workflowJob.returnWorkflow.manufacturer.partsNeeded = String(
            req.body.manufacturer.partsNeeded || ''
          ).trim();
        }
        if (req.body.manufacturer.rmaStatus !== undefined) {
          workflowJob.returnWorkflow.manufacturer = workflowJob.returnWorkflow.manufacturer || {};
          workflowJob.returnWorkflow.manufacturer.rmaStatus = req.body.manufacturer.rmaStatus;
        }
      }

      if (req.body.ourIssue) {
        if (!isPrivileged && req.body.ourIssue.reviewStatus !== undefined) {
          return res.status(403).json({ success: false, error: 'Technicians cannot set review status directly' });
        }
        workflowJob.returnWorkflow.ourIssue = workflowJob.returnWorkflow.ourIssue || {};
        if (req.body.ourIssue.techRequestedAdminContact !== undefined) {
          const nextFlag = Boolean(req.body.ourIssue.techRequestedAdminContact);
          workflowJob.returnWorkflow.ourIssue.techRequestedAdminContact = nextFlag;
          if (!isPrivileged) {
            if (nextFlag) {
              if (workflowJob.returnWorkflow.ourIssue.reviewStatus !== 'APPROVED') {
                workflowJob.returnWorkflow.ourIssue.reviewStatus = 'PENDING';
              }
            } else if (workflowJob.returnWorkflow.ourIssue.reviewStatus !== 'APPROVED') {
              workflowJob.returnWorkflow.ourIssue.reviewStatus = 'NONE';
              workflowJob.returnWorkflow.ourIssue.reviewNotes = '';
              workflowJob.returnWorkflow.ourIssue.reviewedBy = null;
              workflowJob.returnWorkflow.ourIssue.reviewedAt = null;
            }
          }
        }
        if (isPrivileged) {
          if (req.body.ourIssue.reviewStatus !== undefined) {
            workflowJob.returnWorkflow.ourIssue.reviewStatus = req.body.ourIssue.reviewStatus;
          }
          if (req.body.ourIssue.reviewNotes !== undefined) {
            workflowJob.returnWorkflow.ourIssue.reviewNotes = String(req.body.ourIssue.reviewNotes || '').trim();
          }
        }
      }

      workflowJob.markModified('returnWorkflow');
      await workflowJob.save();
      await workflowJob.populate([
        { path: 'assignedTechnician', select: 'name email' },
        { path: 'secondaryAssignedTechnician', select: 'name email' },
        { path: 'customer', select: 'name phone email address firstPageRequired' },
      ]);

      const nextOur = workflowJob.returnWorkflow?.ourIssue?.techRequestedAdminContact;
      if (!prevOur && nextOur) {
        createNotification({
          type: 'JOB_RETURN_REVIEW_REQUESTED',
          message: `${actorWithRole(req.user)} flagged "${workflowJob.title}" for an internal (our) issue - review required before the job can be completed.`,
          jobId: workflowJob._id,
          recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
          excludeUserId: req.user._id,
        });
      }

      const nextRma = workflowJob.returnWorkflow?.manufacturer?.rmaStatus;
      const nextParts = workflowJob.returnWorkflow?.manufacturer?.partsNeeded;
      const mfgPing =
        req.body.manufacturer &&
        (req.body.manufacturer.partsNeeded !== undefined || req.body.manufacturer.rmaStatus !== undefined) &&
        (nextParts !== prevParts || nextRma !== prevRma);
      if (mfgPing) {
        createNotification({
          type: 'JOB_RETURN_WORKFLOW_UPDATED',
          message: `${actorWithRole(req.user)} updated manufacturer / RMA details on "${workflowJob.title}" (RMA: ${nextRma}).`,
          jobId: workflowJob._id,
          recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
          excludeUserId: req.user._id,
        });
      }

      broadcastJobUpdate();
      res.json({ success: true, data: workflowJob });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/jobs/:id/our-issue-review ─────────────────────────────
router.patch(
  '/:id/our-issue-review',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    param('id').isMongoId().withMessage('Invalid job ID'),
    body('reviewStatus').isIn(['APPROVED', 'REJECTED']).withMessage('reviewStatus must be APPROVED or REJECTED'),
    body('reviewNotes').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const workflowJob = await loadReturnWorkflowTargetJob(req.params.id);
      if (!workflowJob) return res.status(404).json({ success: false, error: 'Job not found' });
      if (!canAccessJob(req.user, workflowJob)) {
        return res.status(403).json({ success: false, error: 'Not authorized' });
      }

      workflowJob.returnWorkflow = workflowJob.returnWorkflow || {};
      workflowJob.returnWorkflow.ourIssue = workflowJob.returnWorkflow.ourIssue || {};
      workflowJob.returnWorkflow.ourIssue.reviewStatus = req.body.reviewStatus;
      workflowJob.returnWorkflow.ourIssue.reviewNotes = String(req.body.reviewNotes || '').trim();
      workflowJob.returnWorkflow.ourIssue.reviewedBy = req.user._id;
      workflowJob.returnWorkflow.ourIssue.reviewedAt = new Date();
      workflowJob.markModified('returnWorkflow');
      await workflowJob.save();

      const recipientIds = [];
      if (workflowJob.assignedTechnician) recipientIds.push(workflowJob.assignedTechnician);
      if (workflowJob.secondaryAssignedTechnician) recipientIds.push(workflowJob.secondaryAssignedTechnician);

      createNotification({
        type: 'JOB_RETURN_REVIEW_RESOLVED',
        message: `${actorWithRole(req.user)} ${req.body.reviewStatus === 'APPROVED' ? 'approved' : 'rejected'} the internal issue review for "${workflowJob.title}".`,
        jobId: workflowJob._id,
        recipientIds,
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      res.json({ success: true, data: workflowJob });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/jobs/:id/status ──────────────────────────────────────
router.patch(
  '/:id/status',
  [
    body('status')
      .isIn(Object.values(JOB_STATUS))
      .withMessage(`Status must be one of: ${Object.values(JOB_STATUS).join(', ')}`),
    body('notes').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const result = await JobService.transitionStatus(
        req.params.id,
        req.body.status,
        req.user,
        req.body.notes
      );

      if (result.error) {
        return res.status(result.status).json({ success: false, error: result.error });
      }

      // Build notification recipients based on new status
      const job = result.data;
      const notifRecipientIds = [];
      const notifRoles = [];
      const STATUS_MESSAGES = {
        CONFIRMED: `Job "${job.title}" has been confirmed`,
        ASSIGNED: `Job "${job.title}" has been assigned`,
        IN_PROGRESS: `Job "${job.title}" is now in progress`,
        COMPLETED: `Job "${job.title}" has been completed`,
        BILLED: `Job "${job.title}" has been billed`,
        PAID: `Job "${job.title}" has been marked as paid`,
        CLOSED: `Job "${job.title}" has been closed`,
      };

      // Notify the relevant people
      if ([JOB_STATUS.IN_PROGRESS, JOB_STATUS.COMPLETED].includes(req.body.status)) {
        const actorIsAdmin = [ROLES.ADMIN, ROLES.OFFICE_MANAGER].includes(req.user.role);
        const statusLabel = req.body.status === JOB_STATUS.IN_PROGRESS ? 'In Progress' : 'Completed';
        const techName = job.assignedTechnician?.name;

        if (actorIsAdmin && techName) {

          STATUS_MESSAGES[req.body.status] =
            `"${job.title}" marked as ${statusLabel} on behalf of ${techName}`;
          // Notify the assigned tech
          if (job.assignedTechnician?._id) notifRecipientIds.push(job.assignedTechnician._id);
          if (job.secondaryAssignedTechnician?._id) notifRecipientIds.push(job.secondaryAssignedTechnician._id);
        }
        // Notify admins and managers
        notifRoles.push(ROLES.ADMIN, ROLES.OFFICE_MANAGER);
      }
      if ([JOB_STATUS.BILLED, JOB_STATUS.PAID, JOB_STATUS.CLOSED].includes(req.body.status)) {
        notifRoles.push(ROLES.ADMIN, ROLES.OFFICE_MANAGER);
        // Technicians are NOT notified for PAID / CLOSED - those statuses are hidden from them
      }
      if (req.body.status === JOB_STATUS.CONFIRMED) {
        notifRoles.push(ROLES.ADMIN, ROLES.OFFICE_MANAGER);
      }

      const notificationNotes = typeof req.body.notes === 'string' ? req.body.notes.trim() : '';

      createNotification({
        type: `JOB_${req.body.status === 'IN_PROGRESS' ? 'STARTED' : req.body.status}`,
        message: `${STATUS_MESSAGES[req.body.status] || `Job "${job.title}" status updated`} by ${actorWithRole(req.user)}`,
        jobId: job._id,
        meta: notificationNotes ? { note: notificationNotes } : undefined,
        recipientIds: notifRecipientIds,
        recipientRoles: notifRoles,
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      res.json({ success: true, data: result.data, message: `Status updated to ${req.body.status}` });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/jobs/:id/assign (ADMIN, OFFICE_MANAGER) ──────────────
router.patch(
  '/:id/assign',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('technicianId').isMongoId().withMessage('Valid technician ID required'),
    body('secondaryTechnicianId').optional({ values: 'falsy' }).isMongoId().withMessage('Valid secondary technician ID required'),
    body('notes').optional().isString(),
    body('assignmentChecklist').optional().isObject().withMessage('Assignment checklist must be an object'),
    body('assignmentChecklist.firstPageReceived').optional().isBoolean().withMessage('firstPageReceived must be true or false'),
    body('assignmentChecklist.printsDrawingsReceived').optional().isBoolean().withMessage('printsDrawingsReceived must be true or false'),
    body('assignmentChecklist.siteContactInfoReceived').optional().isBoolean().withMessage('siteContactInfoReceived must be true or false'),
    body('assignmentDocumentRequirements').optional().isArray().withMessage('assignmentDocumentRequirements must be an array'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const result = await JobService.assignTechnician(
        req.params.id,
        req.body.technicianId,
        req.user,
        req.body.notes,
        req.body.assignmentChecklist,
        req.body.secondaryTechnicianId || null,
        req.body.assignmentDocumentRequirements || []
      );

      if (result.error) {
        return res.status(result.status).json({ success: false, error: result.error });
      }

      // Notify the assigned technician immediately when assigned
      const assignedJob = result.data;
      const assignmentNote = typeof req.body.notes === 'string' ? req.body.notes.trim() : '';
      createNotification({
        type: 'JOB_ASSIGNED',
        message: `Job "${assignedJob.title}" has been assigned to you by ${actorWithRole(req.user)}. Instructions: ${req.body.notes}`,
        jobId: assignedJob._id,
        recipientIds: [req.body.technicianId],
        excludeUserId: req.user._id,
      });
      if (req.body.secondaryTechnicianId) {
        createNotification({
          type: 'JOB_ASSIGNED',
          message: `Job "${assignedJob.title}" has been assigned to you as Secondary Technician by ${actorWithRole(req.user)}. Instructions: ${req.body.notes}`,
          jobId: assignedJob._id,
          recipientIds: [req.body.secondaryTechnicianId],
          excludeUserId: req.user._id,
        });
      }
      // Also notify admins and managers
      createNotification({
        type: 'JOB_ASSIGNED',
        message: `Job "${assignedJob.title}" has been assigned to ${assignedJob.assignedTechnician?.name || 'a technician'}${assignedJob.secondaryAssignedTechnician?.name ? ` and ${assignedJob.secondaryAssignedTechnician.name}` : ''} by ${actorWithRole(req.user)}`,
        jobId: assignedJob._id,
        meta: assignmentNote ? { note: assignmentNote } : undefined,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      res.json({ success: true, data: result.data, message: 'Technician assigned' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/jobs/:id/assignment-document-requirements ────────────
router.patch(
  '/:id/assignment-document-requirements',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [body('requirements').isArray().withMessage('requirements must be an array')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    try {
      const job = await Job.findById(req.params.id);
      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to update this job' });
      }

      const previousRows = Array.isArray(job.assignmentDocumentRequirements)
        ? job.assignmentDocumentRequirements.map((row) =>
          row?.toObject ? row.toObject() : { ...row }
        )
        : [];

      const merged = buildAssignmentRequirementRows(
        req.body.requirements.map((row) => ({ label: row?.label || '' })),
        req.body.requirements.map((row, idx) => ({
          key: row?.key || toRequirementKey(row?.label || '', idx),
          label: String(row?.label || '').trim(),
          checked: Boolean(row?.checked),
          textValue: String(row?.textValue || '').trim(),
          document: row?.document?.key
            ? {
              key: row.document.key,
              fileName: row.document.fileName || '',
              contentType: row.document.contentType || 'application/octet-stream',
              size: Number(row.document.size || 0),
              uploadedBy: row.document.uploadedBy || null,
              uploadedAt: row.document.uploadedAt || null,
            }
            : null,
        }))
      );

      const textNoteChanges = collectAssignmentRequirementTextNoteChanges(previousRows, merged);

      job.assignmentDocumentRequirements = merged;
      if (textNoteChanges.length) {
        const historyLine = textNoteChanges
          .map((e) => `"${e.label}" (${e.summary})`)
          .join('; ');
        job.statusHistory.push({
          fromStatus: job.status,
          toStatus: job.status,
          changedBy: req.user._id,
          changedAt: new Date(),
          notes: `Requirement notes updated by ${actorWithRole(req.user)}: ${historyLine}.`,
        });
        notifyAssignmentRequirementNoteChanges({
          job,
          entries: textNoteChanges,
          actorUser: req.user,
        });
      }
      await job.save();
      await syncAssignmentRequirementsToFamily(job, merged).catch(() => {});
      await job.populate('documents.uploadedBy', 'name email role');
      broadcastJobUpdate();
      return res.json({ success: true, data: job, message: 'Assignment document requirements updated' });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/jobs/:id/assignment-documents/presign ─────────────────
router.post(
  '/:id/assignment-documents/presign',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('requirementKey').isString().withMessage('requirementKey is required'),
    body('fileName').isString().withMessage('fileName is required'),
    body('contentType').optional().isString(),
    body('size').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    try {
      const job = await Job.findById(req.params.id).select(
        '_id assignmentDocumentRequirements parentJob jobType programmingSubtype'
      );
      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to update this job' });
      }

      let requirement = (job.assignmentDocumentRequirements || []).find(
        (row) => row?.key === req.body.requirementKey
      );
      if (!requirement && job.parentJob) {
        const parentId = job.parentJob?._id || job.parentJob;
        const parentDoc = await Job.findById(parentId).select('assignmentDocumentRequirements').lean();
        requirement = (parentDoc?.assignmentDocumentRequirements || []).find(
          (row) => row?.key === req.body.requirementKey
        );
        if (requirement) {
          job.assignmentDocumentRequirements = parentDoc.assignmentDocumentRequirements;
          await job.save();
        }
      }
      if (!requirement) {
        // Lazily resolve requirements from the job type (e.g. job is still in TENTATIVE with empty DB requirements)
        const resolved = await resolveAssignmentRequirementsForJob(job);
        requirement = resolved.find((row) => row?.key === req.body.requirementKey);
        if (requirement) {
          job.assignmentDocumentRequirements = resolved;
          await job.save();
        }
      }
      if (!requirement) {
        return res.status(400).json({ success: false, error: 'Invalid requirement key' });
      }

      const key = buildDocumentKey(job._id.toString(), req.body.fileName);
      const presignedUrl = await getUploadUrl({
        key,
        contentType: req.body.contentType || 'application/octet-stream',
        expiresIn: 300,
      });

      return res.json({
        success: true,
        data: {
          requirementKey: req.body.requirementKey,
          key,
          fileName: req.body.fileName,
          contentType: req.body.contentType || 'application/octet-stream',
          size: Number(req.body.size || 0),
          presignedUrl,
          expiresIn: 300,
        },
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── POST /api/jobs/:id/assignment-documents/complete ────────────────
router.post(
  '/:id/assignment-documents/complete',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('requirementKey').isString().withMessage('requirementKey is required'),
    body('key').isString().withMessage('key is required'),
    body('fileName').isString().withMessage('fileName is required'),
    body('contentType').optional().isString(),
    body('size').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    try {
      const head = await headObject(req.body.key);
      if (!head) {
        return res.status(400).json({ success: false, error: 'Uploaded file not found in storage' });
      }

      const job = await Job.findById(req.params.id);
      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to update this job' });
      }

      let rows = Array.isArray(job.assignmentDocumentRequirements)
        ? [...job.assignmentDocumentRequirements]
        : [];
      if (rows.length === 0) {
        const resolved = await resolveAssignmentRequirementsForJob(job);
        if (resolved.length > 0) {
          job.assignmentDocumentRequirements = resolved;
          rows = resolved;
        }
      }
      const rowIndex = rows.findIndex((row) => row?.key === req.body.requirementKey);
      if (rowIndex === -1) {
        return res.status(400).json({ success: false, error: 'Invalid requirement key' });
      }

      const currentRow = rows[rowIndex]?.toObject ? rows[rowIndex].toObject() : rows[rowIndex];
      const previousKey = currentRow?.document?.key;
      rows[rowIndex] = {
        ...currentRow,
        checked: true,
        document: {
          key: req.body.key,
          fileName: req.body.fileName,
          contentType: req.body.contentType || head.ContentType || 'application/octet-stream',
          size: Number(req.body.size || head.ContentLength || 0),
          uploadedBy: req.user._id,
          uploadedAt: new Date(),
        },
      };
      job.assignmentDocumentRequirements = rows;
      const changedFieldName = currentRow?.label || req.body.fileName || 'Document';
      job.statusHistory.push({
        fromStatus: job.status,
        toStatus: job.status,
        changedBy: req.user._id,
        changedAt: new Date(),
        notes: `${changedFieldName} is ${previousKey ? 'updated' : 'uploaded'} by ${actorWithRole(req.user)}.`,
      });
      await job.save();
      await syncAssignmentRequirementsToFamily(job, rows).catch(() => {});

      if (previousKey && previousKey !== req.body.key) {
        await deleteObject(previousKey).catch(() => { });
      }
      notifyAssignmentDocumentChange({
        job,
        documentFieldName: changedFieldName,
        action: previousKey ? 'updated' : 'uploaded',
        actorUser: req.user,
      });
      broadcastJobUpdate();

      return res.json({
        success: true,
        data: {
          assignmentDocumentRequirements: job.assignmentDocumentRequirements,
        },
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── GET /api/jobs/:id/assignment-documents/:requirementKey/url ──────
router.get(
  '/:id/assignment-documents/:requirementKey/url',
  async (req, res) => {
    try {
      const job = await Job.findById(req.params.id).select(
        '_id status assignedTechnician secondaryAssignedTechnician assignmentDocumentRequirements parentJob'
      );
      if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to view this job' });
      }
      let row = (job.assignmentDocumentRequirements || []).find(
        (item) => item?.key === req.params.requirementKey
      );
      if (!row?.document?.key && job.parentJob) {
        const parentId = job.parentJob?._id || job.parentJob;
        const parentDoc = await Job.findById(parentId).select('assignmentDocumentRequirements').lean();
        row = (parentDoc?.assignmentDocumentRequirements || []).find(
          (item) => item?.key === req.params.requirementKey
        );
      }
      if (!row?.document?.key) {
        return res.status(404).json({ success: false, error: 'Document not found' });
      }
      const url = await getDownloadUrl({
        key: row.document.key,
        fileName: row.document.fileName || 'document',
        expiresIn: 900,
      });
      return res.json({ success: true, data: { url } });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── DELETE /api/jobs/:id/assignment-documents/:requirementKey ───────
router.delete(
  '/:id/assignment-documents/:requirementKey',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const job = await Job.findById(req.params.id);
      if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
      if (!canAccessJob(req.user, job)) {
        return res.status(403).json({ success: false, error: 'Not authorized to update this job' });
      }
      const rows = Array.isArray(job.assignmentDocumentRequirements)
        ? [...job.assignmentDocumentRequirements]
        : [];
      const rowIndex = rows.findIndex((row) => row?.key === req.params.requirementKey);
      if (rowIndex === -1) {
        return res.status(404).json({ success: false, error: 'Requirement not found' });
      }
      const currentRow = rows[rowIndex]?.toObject ? rows[rowIndex].toObject() : rows[rowIndex];
      const oldKey = currentRow?.document?.key;
      const changedFieldName = currentRow?.label || 'Document';
      rows[rowIndex] = {
        ...currentRow,
        document: null,
      };
      job.assignmentDocumentRequirements = rows;
      job.statusHistory.push({
        fromStatus: job.status,
        toStatus: job.status,
        changedBy: req.user._id,
        changedAt: new Date(),
        notes: `${changedFieldName} is deleted by ${actorWithRole(req.user)}.`,
      });
      await job.save();
      await syncAssignmentRequirementsToFamily(job, rows).catch(() => {});
      if (oldKey) {
        await deleteObject(oldKey).catch(() => { });
      }
      notifyAssignmentDocumentChange({
        job,
        documentFieldName: changedFieldName,
        action: 'deleted',
        actorUser: req.user,
      });
      broadcastJobUpdate();
      return res.json({
        success: true,
        data: { assignmentDocumentRequirements: job.assignmentDocumentRequirements },
        message: 'Assignment document deleted',
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/jobs/:id/reassign (ADMIN, OFFICE_MANAGER) ────────────
router.patch(
  '/:id/reassign',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('technicianId').isMongoId().withMessage('Valid technician ID required'),
    body('secondaryTechnicianId').optional({ values: 'falsy' }).isMongoId().withMessage('Valid secondary technician ID required'),
    body('notes').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const job = await Job.findById(req.params.id)
        .populate('assignedTechnician', 'name email certificates')
        .populate('secondaryAssignedTechnician', 'name email certificates');

      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }

      // Must be in ASSIGNED or IN_PROGRESS to reassign
      const reassignableStatuses = [JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS];
      if (!reassignableStatuses.includes(job.status)) {
        return res.status(400).json({
          success: false,
          error: `Cannot reassign a job in ${job.status} status. Job must be in ASSIGNED or IN_PROGRESS.`,
        });
      }

      const oldTechId = job.assignedTechnician?._id?.toString();
      const oldSecondaryTechId = job.secondaryAssignedTechnician?._id?.toString();
      const oldTechName = job.assignedTechnician?.name || 'previous technician';
      const oldSecondaryTechName = job.secondaryAssignedTechnician?.name || '';
      const previousStatus = job.status;
      const nextTechId = req.body.technicianId.toString();
      const nextSecondaryTechId = req.body.secondaryTechnicianId
        ? req.body.secondaryTechnicianId.toString()
        : null;

      if (nextSecondaryTechId && nextSecondaryTechId === nextTechId) {
        return res.status(400).json({
          success: false,
          error: 'Primary and secondary technicians must be different',
        });
      }

      // Check new tech availability on scheduled date
      if (job.scheduledDate) {
        const unavailReason = await JobService.checkTechAvailability(
          req.body.technicianId,
          job.scheduledDate,
          job._id
        );
        if (unavailReason) {
          const newTech = await User.findById(req.body.technicianId).select('name');
          return res.status(400).json({
            success: false,
            error: `Technician ${newTech?.name || ''} is unavailable on this date: ${unavailReason}`,
          });
        }
        if (nextSecondaryTechId) {
          const secondaryUnavailReason = await JobService.checkTechAvailability(
            nextSecondaryTechId,
            job.scheduledDate,
            job._id
          );
          if (secondaryUnavailReason) {
            const secondaryTech = await User.findById(nextSecondaryTechId).select('name');
            return res.status(400).json({
              success: false,
              error: `Secondary technician ${secondaryTech?.name || ''} is unavailable on this date: ${secondaryUnavailReason}`,
            });
          }
        }
      }

      // Fetch new technician's name
      const newTech = await User.findById(req.body.technicianId).select('name');
      const newTechName = newTech?.name || 'new technician';
      let newSecondaryTechName = '';
      if (nextSecondaryTechId) {
        const newSecondaryTech = await User.findById(nextSecondaryTechId).select('name role');
        if (!newSecondaryTech || newSecondaryTech.role !== ROLES.TECHNICIAN) {
          return res.status(400).json({ success: false, error: 'Secondary technician not found' });
        }
        newSecondaryTechName = newSecondaryTech.name;
      }

      // Enforce certification for cert-required job types on primary only
      const reassignCertError = await JobService.ensureTechCertifiedForJobType(
        job.jobType,
        [req.body.technicianId]
      );
      if (reassignCertError) {
        return res.status(400).json({ success: false, error: reassignCertError });
      }

      // Update job: new technician, reset status to ASSIGNED
      job.assignedTechnician = req.body.technicianId;
      job.secondaryAssignedTechnician = nextSecondaryTechId;
      job.status = JOB_STATUS.ASSIGNED;
      job.statusHistory.push({
        fromStatus: previousStatus,
        toStatus: JOB_STATUS.ASSIGNED,
        changedBy: req.user._id,
        notes: req.body.notes || `Reassigned from ${oldTechName} to ${newTechName}`,
      });
      await job.save();

      // Re-populate for response
      await job.populate('assignedTechnician', 'name email certificates');
      await job.populate('secondaryAssignedTechnician', 'name email certificates');
      await job.populate('createdBy', 'name email');

      // Reassign notifications: notify only affected technicians.
      // 1) Secondary changed -> notify new secondary + old secondary + unchanged primary
      if (oldSecondaryTechId !== nextSecondaryTechId) {
        if (nextSecondaryTechId) {
          createNotification({
            type: 'JOB_REASSIGNED',
            message: `You have been assigned to this job as the secondary technician. The primary technician is ${newTechName}.${req.body.notes ? ` Assignment note: ${req.body.notes}` : ''}`,
            jobId: job._id,
            recipientIds: [nextSecondaryTechId],
            excludeUserId: req.user._id,
          });
        }
        if (oldSecondaryTechId && oldSecondaryTechId !== nextTechId) {
          createNotification({
            type: 'JOB_REASSIGNED',
            message: `You have been unassigned from ${job.title}.`,
            jobId: job._id,
            recipientIds: [oldSecondaryTechId],
            excludeUserId: req.user._id,
          });
        }
        if (oldTechId && oldTechId === nextTechId && oldSecondaryTechName) {
          const secondaryChangeMessage = newSecondaryTechName
            ? `The secondary technician for this job has been changed from ${oldSecondaryTechName} to ${newSecondaryTechName}.`
            : `Secondary tech ${oldSecondaryTechName} is removed from job.`;
          createNotification({
            type: 'JOB_REASSIGNED',
            message: `${secondaryChangeMessage}${req.body.notes ? ` Assignment note: ${req.body.notes}` : ''}`,
            jobId: job._id,
            recipientIds: [oldTechId],
            excludeUserId: req.user._id,
          });
        }
      }

      // 2) Primary changed -> notify new primary + old primary + unchanged secondary
      if (oldTechId !== nextTechId) {
        const primaryContext = newSecondaryTechName
          ? ` The secondary technician is ${newSecondaryTechName}.`
          : '';
        createNotification({
          type: 'JOB_REASSIGNED',
          message: `You have been assigned to this job as the primary technician.${primaryContext}${req.body.notes ? ` Assignment note: ${req.body.notes}` : ''}`,
          jobId: job._id,
          recipientIds: [nextTechId],
          excludeUserId: req.user._id,
        });
        if (oldTechId && oldTechId !== nextSecondaryTechId) {
          createNotification({
            type: 'JOB_REASSIGNED',
            message: `You have been unassigned from ${job.title}.`,
            jobId: job._id,
            recipientIds: [oldTechId],
            excludeUserId: req.user._id,
          });
        }
        if (oldSecondaryTechId && oldSecondaryTechId === nextSecondaryTechId && oldTechName) {
          createNotification({
            type: 'JOB_REASSIGNED',
            message: `The primary technician for this job has been changed from ${oldTechName} to ${newTechName}.${req.body.notes ? ` Assignment note: ${req.body.notes}` : ''}`,
            jobId: job._id,
            recipientIds: [oldSecondaryTechId],
            excludeUserId: req.user._id,
          });
        }
      }
      // Also notify admins and managers
      createNotification({
        type: 'JOB_REASSIGNED',
        message: `Job "${job.title}" reassigned from ${oldTechName}${oldSecondaryTechName ? ` + ${oldSecondaryTechName}` : ''} to ${newTechName}${newSecondaryTechName ? ` + ${newSecondaryTechName}` : ''} by ${actorWithRole(req.user)}.${req.body.notes ? ` Notes: ${req.body.notes}` : ''}`,
        jobId: job._id,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      res.json({ success: true, data: job, message: `Reassigned to ${newTechName}` });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/jobs/:id/assignment-checklist (ADMIN, OFFICE_MANAGER) ──
router.patch(
  '/:id/assignment-checklist',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('firstPageReceived').optional().isBoolean().withMessage('firstPageReceived must be true or false'),
    body('printsDrawingsReceived').optional().isBoolean().withMessage('printsDrawingsReceived must be true or false'),
    body('siteContactInfoReceived').optional().isBoolean().withMessage('siteContactInfoReceived must be true or false'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const job = await Job.findById(req.params.id);
      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }

      const prevChecklist = {
        firstPageReceived: Boolean(job.assignmentChecklist?.firstPageReceived),
        printsDrawingsReceived: Boolean(job.assignmentChecklist?.printsDrawingsReceived),
        siteContactInfoReceived: Boolean(job.assignmentChecklist?.siteContactInfoReceived),
      };

      const nextChecklist = {
        firstPageReceived: Boolean(req.body.firstPageReceived ?? job.assignmentChecklist?.firstPageReceived),
        printsDrawingsReceived: Boolean(req.body.printsDrawingsReceived ?? job.assignmentChecklist?.printsDrawingsReceived),
        siteContactInfoReceived: Boolean(req.body.siteContactInfoReceived ?? job.assignmentChecklist?.siteContactInfoReceived),
      };

      const labelByKey = {
        firstPageReceived: 'First page received',
        printsDrawingsReceived: 'Prints/drawings received',
        siteContactInfoReceived: 'Site contact info received',
      };
      const summaryLines = [];
      for (const key of Object.keys(labelByKey)) {
        if (prevChecklist[key] !== nextChecklist[key]) {
          summaryLines.push(`${labelByKey[key]}: ${nextChecklist[key] ? 'yes' : 'no'}`);
        }
      }

      if (!summaryLines.length) {
        await job.populate('assignedTechnician', 'name email certificates');
        await job.populate('secondaryAssignedTechnician', 'name email certificates');
        await job.populate('createdBy', 'name email');
        return res.json({ success: true, data: job, message: 'Assignment checklist unchanged' });
      }

      job.assignmentChecklist = nextChecklist;
      for (let i = job.statusHistory.length - 1; i >= 0; i -= 1) {
        if (job.statusHistory[i]?.toStatus === JOB_STATUS.ASSIGNED) {
          job.statusHistory[i].assignmentChecklist = nextChecklist;
          break;
        }
      }
      if (summaryLines.length) {
        job.statusHistory.push({
          fromStatus: job.status,
          toStatus: job.status,
          changedBy: req.user._id,
          changedAt: new Date(),
          notes: `Assignment checklist updated by ${actorWithRole(req.user)}: ${summaryLines.join('; ')}.`,
        });
        notifyAssignmentChecklistUpdated({
          job,
          summaryLines,
          actorUser: req.user,
        });
      }
      await job.save();
      const clRootId = job.parentJob?._id || job.parentJob || job._id;
      const clFamilyJobs = await Job.find({
        $or: [{ _id: clRootId }, { parentJob: clRootId, jobVisitKind: 'RETURN' }],
      }).select('_id');
      const clOtherIds = clFamilyJobs.map((j) => j._id).filter((id) => String(id) !== String(job._id));
      if (clOtherIds.length > 0) {
        await Job.updateMany({ _id: { $in: clOtherIds } }, { $set: { assignmentChecklist: nextChecklist } }).catch(() => {});
      }
      await job.populate('assignedTechnician', 'name email certificates');
      await job.populate('secondaryAssignedTechnician', 'name email certificates');
      await job.populate('createdBy', 'name email');

      broadcastJobUpdate();
      res.json({ success: true, data: job, message: 'Assignment checklist updated' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PATCH /api/jobs/:id/revert (ADMIN, OFFICE_MANAGER) ─────────────
router.patch(
  '/:id/revert',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const beforeRevertJob = await Job.findById(req.params.id)
        .select('assignedTechnician secondaryAssignedTechnician status title')
        .lean();

      const result = await JobService.revertStatus(req.params.id, req.user);
      if (result.error) {
        return res.status(result.status).json({ success: false, error: result.error });
      }

      const job = result.data;

      // Reverting from IN_PROGRESS hides the FSR from the technician again
      // (unless already submitted - a submitted FSR should remain visible)
      if (result.revertedFrom === JOB_STATUS.IN_PROGRESS) {
        await FsrDocument.updateOne(
          { job: job._id, status: { $ne: FSR_STATUS.SUBMITTED } },
          { $set: { technicianVisible: false } }
        );
      }

      const message = `Job "${job.title}" status reverted from ${result.revertedFrom} to ${result.revertedTo} by ${actorWithRole(req.user)}`;
      const previousAssignedTechId = beforeRevertJob?.assignedTechnician?.toString();
      const previousSecondaryAssignedTechId = beforeRevertJob?.secondaryAssignedTechnician?.toString();

      // Notify the assigned technician only if the revert involves statuses visible to them
      // (PAID/CLOSED are hidden from techs, so don't notify them when reverting those)
      const techHiddenStatuses = [JOB_STATUS.PAID, JOB_STATUS.CLOSED];
      if (job.assignedTechnician && !techHiddenStatuses.includes(result.revertedFrom)) {
        createNotification({
          type: 'JOB_UPDATED',
          message,
          jobId: job._id,
          recipientIds: [job.assignedTechnician._id],
          excludeUserId: req.user._id,
        });
      }
      if (result.revertedFrom === JOB_STATUS.ASSIGNED && previousAssignedTechId) {
        createNotification({
          type: 'JOB_UPDATED',
          message: `Job "${job.title}" was reverted from ASSIGNED to CONFIRMED by ${actorWithRole(req.user)}. You have been unassigned.`,
          jobId: job._id,
          recipientIds: [previousAssignedTechId],
          excludeUserId: req.user._id,
        });
      }
      if (
        result.revertedFrom === JOB_STATUS.ASSIGNED &&
        previousSecondaryAssignedTechId &&
        previousSecondaryAssignedTechId !== previousAssignedTechId
      ) {
        createNotification({
          type: 'JOB_UPDATED',
          message: `Job "${job.title}" was reverted from ASSIGNED to CONFIRMED by ${actorWithRole(req.user)}. You have been unassigned.`,
          jobId: job._id,
          recipientIds: [previousSecondaryAssignedTechId],
          excludeUserId: req.user._id,
        });
      }
      // Notify all admins and managers
      createNotification({
        type: 'JOB_UPDATED',
        message,
        jobId: job._id,
        recipientRoles: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      res.json({
        success: true,
        data: job,
        message: `Status reverted to ${result.revertedTo}`,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── DELETE /api/jobs/:id (ADMIN, OFFICE_MANAGER) ────────────────────
router.delete(
  '/:id',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  async (req, res) => {
    try {
      const job = await Job.findById(req.params.id)
        .populate('assignedTechnician', 'name email');

      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }

      if (job.status === JOB_STATUS.BILLED) {
        return res.status(400).json({ success: false, error: 'Billed jobs cannot be deleted' });
      }

      const jobTitle = job.title;
      const techId = job.assignedTechnician?._id;
      const secondaryTechId = job.secondaryAssignedTechnician?._id;
      const fsrDoc = await getFsrDocumentByJobId(req.params.id);

      const s3Keys = [
        ...(fsrDoc?.assets || []).filter((a) => a?.key).map((a) => a.key),
        ...(job.documents || []).filter((d) => d?.key).map((d) => d.key),
        ...(job.assignmentDocumentRequirements || [])
          .filter((r) => r?.document?.key)
          .map((r) => r.document.key),
      ];

      await Job.findByIdAndDelete(req.params.id);

      if (s3Keys.length) {
        await Promise.all(s3Keys.map((key) => deleteObject(key).catch(() => null)));
      }
      if (fsrDoc) {
        await fsrDoc.deleteOne();
      }

      // Notify relevant people based on job visibility
      const notifRecipientIds = [];
      const notifRoles = [];

      // Notify tech if the job was already visible to them (ASSIGNED+)
      const techVisibleStatuses = [JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS, JOB_STATUS.COMPLETED];
      if (techId && techVisibleStatuses.includes(job.status)) {
        notifRecipientIds.push(techId);
      }
      if (secondaryTechId && techVisibleStatuses.includes(job.status)) {
        notifRecipientIds.push(secondaryTechId);
      }

      // Notify admins and managers (both can see all jobs including TENTATIVE)
      notifRoles.push(ROLES.ADMIN, ROLES.OFFICE_MANAGER);

      if (notifRecipientIds.length > 0 || notifRoles.length > 0) {
        createNotification({
          type: 'JOB_DELETED',
          message: `Job "${jobTitle}" has been deleted by ${actorWithRole(req.user)}`,
          jobId: null,
          meta: { jobTitle },
          recipientIds: notifRecipientIds,
          recipientRoles: notifRoles,
          excludeUserId: req.user._id,
        });
      }

      broadcastJobUpdate();
      res.json({ success: true, message: `Job "${jobTitle}" deleted` });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── PUT /api/jobs/:id (ADMIN, OFFICE_MANAGER) ───────────────────────
router.put(
  '/:id',
  authorize(ROLES.ADMIN, ROLES.OFFICE_MANAGER),
  [
    body('title').optional().notEmpty().withMessage('Title cannot be empty'),
    body('jobType').optional().isString().withMessage('Job type must be a string'),
    body('programmingSubtype').optional().isString().withMessage('Programming subtype must be a string'),
    body('levitonExternalFsrLink').optional().isString().withMessage('External FSR link must be a string'),
    body('customerEmail').optional().isEmail().withMessage('Invalid customer email'),
    body('scheduledDate').optional().custom(validateScheduledDate),
    body('estimatedCost').optional().isFloat({ min: 0 }).withMessage('Must be positive'),
    body('actualCost').optional().isFloat({ min: 0 }).withMessage('Must be positive'),
    body('siteInfoMode').optional().isIn(['TEXT', 'PDF']).withMessage('Invalid site info mode'),
    body('siteInfoText').optional().isString().withMessage('Site info must be a string'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      // Prevent editing BILLED jobs
      const existingJob = await Job.findById(req.params.id).lean();
      if (!existingJob) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }
      if (existingJob.status === JOB_STATUS.BILLED) {
        return res.status(400).json({ success: false, error: 'Billed jobs cannot be edited' });
      }

      if (req.body.jobType !== undefined) {
        req.body.jobType = normalizeJobType(req.body.jobType);
        if (!req.body.jobType) {
          return res.status(400).json({ success: false, error: 'Job type cannot be empty' });
        }
        await ensureJobTypeSaved(req.body.jobType);
      }

      if (
        req.body.jobType !== undefined ||
        req.body.programmingSubtype !== undefined
      ) {
        const finalJobType = normalizeJobType(
          req.body.jobType !== undefined ? req.body.jobType : existingJob.jobType,
        );
        const normSubtype = normalizeProgrammingSubtype(
          req.body.programmingSubtype !== undefined
            ? req.body.programmingSubtype
            : (existingJob.programmingSubtype || ''),
        );
        if (await jobTypeIsProgramming(finalJobType)) {
          if (!normSubtype || !PROGRAMMING_SUBTYPES.includes(normSubtype)) {
            return res.status(400).json({
              success: false,
              error:
                'Programming subtype is required and must be "New Start-Up" or "Existing Start-Up" for programming job types',
            });
          }
          req.body.programmingSubtype = normSubtype;
        } else {
          req.body.programmingSubtype = undefined;
        }
      }

      const levitonExternalFsrLink = req.body.levitonExternalFsrLink;
      if (req.body.levitonExternalFsrLink !== undefined) {
        delete req.body.levitonExternalFsrLink;
      }

      const result = await JobService.updateJobDetails(req.params.id, req.body);
      if (result.error) {
        return res.status(result.status).json({ success: false, error: result.error });
      }
      await syncUnsubmittedFsrDocumentForJob(result.data, {
        levitonExternalLink: levitonExternalFsrLink,
      });
      await attachFsrSummariesToJobs([result.data]);

      // Notify relevant people based on job visibility
      const updatedJob = result.data;
      const notifRecipientIds = [];
      const notifRoles = [ROLES.ADMIN, ROLES.OFFICE_MANAGER];

      // Notify tech if the job is already visible to them (ASSIGNED+)
      const techVisible = [JOB_STATUS.ASSIGNED, JOB_STATUS.IN_PROGRESS, JOB_STATUS.COMPLETED];
      if (updatedJob.assignedTechnician && techVisible.includes(updatedJob.status)) {
        notifRecipientIds.push(updatedJob.assignedTechnician._id || updatedJob.assignedTechnician);
      }
      if (updatedJob.secondaryAssignedTechnician && techVisible.includes(updatedJob.status)) {
        notifRecipientIds.push(updatedJob.secondaryAssignedTechnician._id || updatedJob.secondaryAssignedTechnician);
      }

      createNotification({
        type: 'JOB_UPDATED',
        message: `Job "${updatedJob.title}" details have been updated by ${actorWithRole(req.user)}`,
        jobId: updatedJob._id,
        recipientIds: notifRecipientIds,
        recipientRoles: notifRoles,
        excludeUserId: req.user._id,
      });

      broadcastJobUpdate();
      res.json({ success: true, data: result.data });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ── GET /api/jobs/:id/history ───────────────────────────────────────
router.get('/:id/history', async (req, res) => {
  try {
    const job = await Job.findById(req.params.id)
      .select('statusHistory status title assignedTechnician secondaryAssignedTechnician parentJob jobVisitKind')
      .populate('parentJob', 'assignedTechnician secondaryAssignedTechnician')
      .populate('statusHistory.changedBy', 'name email role')
      .populate('statusHistory.technician', 'name email');

    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    if (!canAccessJob(req.user, job)) {
      return res.status(403).json({ success: false, error: 'Not authorized to view this job history' });
    }

    let history = Array.isArray(job.statusHistory) ? job.statusHistory : [];
    if (job.parentJob) {
      const parentId = job.parentJob._id || job.parentJob;
      const parent = await Job.findById(parentId)
        .select('statusHistory')
        .populate('statusHistory.changedBy', 'name email role')
        .populate('statusHistory.technician', 'name email');
      history = mergeStatusHistoryEntries(parent?.statusHistory, job.statusHistory);
    }

    res.json({
      success: true,
      data: {
        jobId: job._id,
        title: job.title,
        currentStatus: job.status,
        history,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
