/**
 * Send (or dry-run render) a test job notification email through the real
 * email pipeline: recipient lookup -> job context fetch -> template -> SMTP.
 *
 * Usage:
 *   node src/scripts/sendTestJobEmail.js <user-email> [TYPE]
 *   DRY_RUN=1 node src/scripts/sendTestJobEmail.js <user-email> [TYPE]   # writes HTML, sends nothing
 *
 * <user-email> must belong to an existing active user (the email goes to their
 * stored address). TYPE defaults to JOB_ASSIGNED; must be an allowlisted type.
 */
require('../config/env');
const fs = require('fs');
const path = require('path');

if (process.env.DRY_RUN) {
  // Patch the transport BEFORE EmailService builds it - renders to a file instead of sending.
  const nodemailer = require('nodemailer');
  nodemailer.createTransport = () => ({
    sendMail: async ({ to, subject, html }) => {
      const out = path.join(__dirname, 'test-email-preview.html');
      fs.writeFileSync(out, html);
      console.log(`[DRY RUN] would send to: ${to}`);
      console.log(`[DRY RUN] subject:       ${subject}`);
      console.log(`[DRY RUN] html written:  ${out}`);
    },
  });
}

const mongoose = require('mongoose');
const User = require('../models/User');
const Job = require('../models/Job');
const { sendJobEventEmails, EMAIL_EVENT_LABELS } = require('../services/EmailNotificationService');

(async () => {
  const [email, type = 'JOB_ASSIGNED'] = process.argv.slice(2);
  if (!email) {
    console.error('Usage: node src/scripts/sendTestJobEmail.js <user-email> [TYPE]');
    process.exit(1);
  }
  if (!EMAIL_EVENT_LABELS[type]) {
    console.error(`Type "${type}" is not email-enabled. Allowed:\n  ${Object.keys(EMAIL_EVENT_LABELS).join('\n  ')}`);
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);

  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) {
    console.error(`No user found with email ${email}`);
    process.exit(1);
  }
  const job = await Job.findOne().sort({ createdAt: -1 });
  if (!job) {
    console.error('No job in database to use as context');
    process.exit(1);
  }

  console.log(`Recipient: ${user.name} <${user.email}> (${user.role})`);
  console.log(`Job:       "${job.title}" (${job.status})`);
  console.log(`Type:      ${type} -> "${EMAIL_EVENT_LABELS[type]}"`);

  await sendJobEventEmails([user._id.toString()], {
    type,
    message: `[TEST] Job "${job.title}" has been assigned to you by Admin Sushil admin. This is a test of the email notification pipeline.`,
    jobId: job._id,
  });

  console.log(process.env.DRY_RUN ? '\nDry run complete.' : '\nEmail sent - check the inbox.');
  await mongoose.disconnect();
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
