const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
const BUCKET =
  process.env.AWS_S3_BUCKET ||
  process.env.AWS_BUCKET_NAME ||
  process.env.S3_BUCKET ||
  process.env.S3_BUCKET_NAME;

if (!REGION || !BUCKET) {
  console.warn('S3 is not fully configured. Missing AWS region or bucket environment variables.');
}

const s3 = new S3Client({
  region: REGION,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

function ensureS3Config() {
  if (!REGION || !BUCKET) {
    const err = new Error(
      'S3 configuration missing: set AWS_REGION and one of AWS_S3_BUCKET/AWS_BUCKET_NAME/S3_BUCKET'
    );
    err.status = 500;
    throw err;
  }
}

function sanitizeFileName(name = '') {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 140) || 'document';
}

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml',
};

function mimeFromName(name = '') {
  const ext = String(name).split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || '';
}

function buildDocumentKey(jobId, originalName) {
  const safeName = sanitizeFileName(originalName);
  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  return `jobs/${jobId}/documents/${stamp}-${rand}-${safeName}`;
}

function buildCertificateKey(userId, jobTypeId, originalName) {
  const safeName = sanitizeFileName(originalName);
  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  return `users/${userId}/certificates/${jobTypeId}/${stamp}-${rand}-${safeName}`;
}

function buildFsrAssetKey(jobId, originalName) {
  const safeName = sanitizeFileName(originalName);
  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  return `jobs/${jobId}/fsr/${stamp}-${rand}-${safeName}`;
}

async function getUploadUrl({ key, contentType, expiresIn = 300 }) {
  ensureS3Config();
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
  });
  return getSignedUrl(s3, command, { expiresIn });
}

async function getDownloadUrl({ key, fileName, contentType, expiresIn = 900 }) {
  ensureS3Config();
  const inferred = mimeFromName(fileName);
  const resolvedType =
    contentType && contentType !== 'application/octet-stream'
      ? contentType
      : inferred || contentType || undefined;
  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ResponseContentDisposition: `inline; filename="${sanitizeFileName(fileName)}"`,
    ...(resolvedType ? { ResponseContentType: resolvedType } : {}),
  });
  return getSignedUrl(s3, command, { expiresIn });
}

async function headObject(key) {
  ensureS3Config();
  return s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
}

async function deleteObject(key) {
  ensureS3Config();
  return s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = {
  sanitizeFileName,
  buildDocumentKey,
  buildCertificateKey,
  buildFsrAssetKey,
  getUploadUrl,
  getDownloadUrl,
  headObject,
  deleteObject,
};
