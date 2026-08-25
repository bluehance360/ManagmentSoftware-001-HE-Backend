/**
 * Manual trigger for the notification scheduler.
 *
 * Runs all three SchedulerService checks once against the live database and
 * prints how many notifications were sent, then exits. Use this to test the
 * notification rules on demand instead of waiting for the 30-minute cron tick.
 *
 *   Run: pnpm run notify:check       (from the backend/ directory)
 *
 * It is safe to run repeatedly - the NotificationLog dedup ledger ensures a
 * given notification is never sent twice.
 */

require('../config/env');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const scheduler = require('../services/SchedulerService');

(async () => {
  try {
    await connectDB();
    // connectDB retries in the background on failure; wait until actually connected.
    if (mongoose.connection.readyState !== 1) {
      await new Promise((resolve, reject) => {
        mongoose.connection.once('connected', resolve);
        mongoose.connection.once('error', reject);
        setTimeout(() => reject(new Error('DB connection timed out')), 15000);
      });
    }

    console.log('[notify:check] Running all notification checks...');
    const result = await scheduler.runAllChecks();

    console.log('[notify:check] Done. Notifications sent this run:');
    console.log(`  Rule 1  overdue assigned jobs:        ${result.overdue}`);
    console.log(`  Rule 2  missing-document reminders:   ${result.docReminders}`);
    console.log(`  Rule 3  started w/ pending documents: ${result.startedPendingDocs}`);
    console.log(`  Rule 4  FSR unsubmitted - tech:       ${result.fsrTechReminders}`);
    console.log(`  Rule 5  FSR unsubmitted - admin/mgr:  ${result.fsrAdminReminders}`);

    // Drain fire-and-forget notification emails before the process exits
    await require('../services/EmailNotificationService').waitForEmailQueue();

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('[notify:check] Failed:', err.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  }
})();
