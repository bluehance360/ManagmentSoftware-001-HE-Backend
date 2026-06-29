const FsrDocument = require('../models/FsrDocument');
const FsrSignatureRequest = require('../models/FsrSignatureRequest');
const { toLocalDateOnly } = require('../utils/dateOnly');

const FSR_TEMPLATE = {
  STANDARD: 'STANDARD',
  WATTSTOPPER: 'WATTSTOPPER',
  LEVITON_EXTERNAL: 'LEVITON_EXTERNAL',
  KORE: 'KORE',
};

const FSR_STATUS = {
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  SUBMITTED: 'SUBMITTED',
};

const FSR_TEMPLATE_SOURCE = {
  AUTO: 'AUTO',
  MANUAL_OVERRIDE: 'MANUAL_OVERRIDE',
};

const FSR_TEMPLATE_LABELS = {
  [FSR_TEMPLATE.STANDARD]: 'Standard FSR',
  [FSR_TEMPLATE.WATTSTOPPER]: 'Wattstopper FSR',
  [FSR_TEMPLATE.LEVITON_EXTERNAL]: 'Leviton External FSR',
  [FSR_TEMPLATE.KORE]: 'Kore FSR',
};

function normalizeJobType(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function hasProgrammingSubtype(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function resolveFsrTemplateForJobType(jobType, opts = {}) {
  const normalized = normalizeJobType(jobType);
  if (normalized === 'wattstopper') return FSR_TEMPLATE.WATTSTOPPER;
  if (normalized === 'leviton') return FSR_TEMPLATE.LEVITON_EXTERNAL;
  if (normalized === 'kore') return FSR_TEMPLATE.KORE;
  return opts.isProgramming || hasProgrammingSubtype(opts.programmingSubtype)
    ? FSR_TEMPLATE.STANDARD
    : null;
}

function normalizeLevitonExternalLink(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return '';
  return /^[a-z][a-z\d+\-.]*:/i.test(normalized) ? normalized : `https://${normalized}`;
}

function buildFsrSummary(doc) {
  if (!doc) return null;
  return {
    _id: doc._id,
    templateKey: doc.templateKey,
    templateSource: doc.templateSource || FSR_TEMPLATE_SOURCE.AUTO,
    templateLabel: FSR_TEMPLATE_LABELS[doc.templateKey] || doc.templateKey,
    status: doc.status,
    technicianVisible: Boolean(doc.technicianVisible),
    submittedAt: doc.submittedAt || null,
    hasExternalLink: Boolean(doc.levitonExternalLink),
    levitonExternalLink: doc.levitonExternalLink || '',
  };
}

function setJobFsrSummary(job, summary) {
  if (!job) return;
  if (typeof job.set === 'function') {
    job.set('fsrSummary', summary, { strict: false });
    return;
  }
  job.fsrSummary = summary;
}

async function attachFsrSummariesToJobs(jobs) {
  const list = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  if (!list.length) return jobs;

  const jobIds = list
    .map((job) => String(job?._id || ''))
    .filter(Boolean);

  if (!jobIds.length) return jobs;

  const docs = await FsrDocument.find({ job: { $in: jobIds } })
    .select('job templateKey status technicianVisible submittedAt levitonExternalLink')
    .lean();

  const summaryByJobId = new Map(
    docs.map((doc) => [String(doc.job), buildFsrSummary(doc)])
  );

  list.forEach((job) => {
    setJobFsrSummary(job, summaryByJobId.get(String(job._id)) || null);
  });

  return jobs;
}

async function createFsrDocumentForJob(jobDoc, opts = {}) {
  if (!jobDoc?._id) return null;
  const templateKey = resolveFsrTemplateForJobType(jobDoc.jobType, {
    isProgramming: opts.isProgramming,
    programmingSubtype: jobDoc.programmingSubtype,
  });
  if (!templateKey) return null;
  const levitonExternalLink =
    templateKey === FSR_TEMPLATE.LEVITON_EXTERNAL
      ? normalizeLevitonExternalLink(opts.levitonExternalLink)
      : '';

  return FsrDocument.findOneAndUpdate(
    { job: jobDoc._id },
    {
      $setOnInsert: {
        job: jobDoc._id,
        templateKey,
        templateSource: FSR_TEMPLATE_SOURCE.AUTO,
        status: FSR_STATUS.NOT_STARTED,
        technicianVisible: false,
        levitonExternalLink,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function getFsrDocumentByJobId(jobId) {
  return FsrDocument.findOne({ job: jobId });
}

async function syncUnsubmittedFsrDocumentForJob(jobDoc, opts = {}) {
  if (!jobDoc?._id) return null;
  const doc = await FsrDocument.findOne({ job: jobDoc._id });
  const defaultTemplateKey = resolveFsrTemplateForJobType(jobDoc.jobType, {
    isProgramming: opts.isProgramming,
    programmingSubtype: jobDoc.programmingSubtype,
  });

  if (!doc) {
    return defaultTemplateKey ? createFsrDocumentForJob(jobDoc, opts) : null;
  }
  if (doc.status === FSR_STATUS.SUBMITTED) return doc;

  const nextTemplateKey =
    doc.templateSource === FSR_TEMPLATE_SOURCE.MANUAL_OVERRIDE ? doc.templateKey : defaultTemplateKey;
  const templateChanged = doc.templateKey !== nextTemplateKey;
  if (!nextTemplateKey) {
    await FsrSignatureRequest.updateMany(
      { fsrDocument: doc._id, status: 'PENDING' },
      { $set: { status: 'CANCELLED' } }
    );
    await doc.deleteOne();
    return null;
  }
  doc.templateKey = nextTemplateKey;
  doc.status = FSR_STATUS.NOT_STARTED;
  doc.submissionData = undefined;
  doc.draftSignatures = {};
  doc.jobSnapshot = undefined;
  doc.assets = [];
  doc.submittedBy = null;
  doc.submittedAt = null;
  doc.levitonExternalLink =
    nextTemplateKey === FSR_TEMPLATE.LEVITON_EXTERNAL
      ? normalizeLevitonExternalLink(
          opts.levitonExternalLink !== undefined ? opts.levitonExternalLink : doc.levitonExternalLink
        )
      : '';

  await doc.save();
  if (templateChanged) {
    await FsrSignatureRequest.updateMany(
      { fsrDocument: doc._id, status: 'PENDING' },
      { $set: { status: 'CANCELLED' } }
    );
  }
  return doc;
}

function extractJobAddress(job) {
  if (typeof job?.address === 'string') return job.address.trim();
  if (job?.address && typeof job.address === 'object') {
    return [
      job.address.street,
      job.address.city,
      job.address.state,
      job.address.zip,
    ]
      .filter(Boolean)
      .join(', ')
      .trim();
  }
  return String(job?.customer?.address || '').trim();
}

function buildJobSnapshot(job) {
  return {
    projectName: String(job?.title || '').trim(),
    siteAddress: extractJobAddress(job),
    date: toLocalDateOnly(),
    technicianName: String(job?.assignedTechnician?.name || '').trim(),
    secondaryTechnicianName: String(job?.secondaryAssignedTechnician?.name || '').trim(),
    companyName: String(job?.companyName || '').trim(),
    customerName: String(job?.customer?.name || job?.customerName || '').trim(),
  };
}

function formatFsrDocument(doc) {
  if (!doc) return null;
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  plain.templateLabel = FSR_TEMPLATE_LABELS[plain.templateKey] || plain.templateKey;
  plain.summary = buildFsrSummary(plain);
  return plain;
}

module.exports = {
  FSR_TEMPLATE,
  FSR_STATUS,
  FSR_TEMPLATE_SOURCE,
  FSR_TEMPLATE_LABELS,
  resolveFsrTemplateForJobType,
  normalizeLevitonExternalLink,
  buildFsrSummary,
  attachFsrSummariesToJobs,
  createFsrDocumentForJob,
  getFsrDocumentByJobId,
  syncUnsubmittedFsrDocumentForJob,
  buildJobSnapshot,
  formatFsrDocument,
};
