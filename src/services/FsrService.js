const FsrDocument = require('../models/FsrDocument');
const { toLocalDateOnly } = require('../utils/dateOnly');

const FSR_TEMPLATE = {
  STANDARD: 'STANDARD',
  WATTSTOPPER: 'WATTSTOPPER',
  LEVITON_EXTERNAL: 'LEVITON_EXTERNAL',
};

const FSR_STATUS = {
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  SUBMITTED: 'SUBMITTED',
};

const FSR_TEMPLATE_LABELS = {
  [FSR_TEMPLATE.STANDARD]: 'Standard FSR',
  [FSR_TEMPLATE.WATTSTOPPER]: 'Wattstopper FSR',
  [FSR_TEMPLATE.LEVITON_EXTERNAL]: 'Leviton External FSR',
};

function normalizeJobType(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function resolveFsrTemplateForJobType(jobType) {
  const normalized = normalizeJobType(jobType);
  if (normalized === 'wattstopper') return FSR_TEMPLATE.WATTSTOPPER;
  if (normalized === 'leviton') return FSR_TEMPLATE.LEVITON_EXTERNAL;
  return FSR_TEMPLATE.STANDARD;
}

function normalizeLevitonExternalLink(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildFsrSummary(doc) {
  if (!doc) return null;
  return {
    _id: doc._id,
    templateKey: doc.templateKey,
    templateLabel: FSR_TEMPLATE_LABELS[doc.templateKey] || doc.templateKey,
    status: doc.status,
    submittedAt: doc.submittedAt || null,
    hasExternalLink: Boolean(doc.levitonExternalLink),
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
    .select('job templateKey status submittedAt levitonExternalLink')
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
  const templateKey = resolveFsrTemplateForJobType(jobDoc.jobType);
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
        status: FSR_STATUS.NOT_STARTED,
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
  if (!doc || doc.status === FSR_STATUS.SUBMITTED) return doc;

  const nextTemplateKey = resolveFsrTemplateForJobType(jobDoc.jobType);
  doc.templateKey = nextTemplateKey;
  doc.status = FSR_STATUS.NOT_STARTED;
  doc.submissionData = undefined;
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
