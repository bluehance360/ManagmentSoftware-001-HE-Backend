# Automated Notification Scheduler

Time-based job notifications, evaluated by a single in-process cron task.

## What it does

| Rule | Trigger | Recipients |
|------|---------|------------|
| **1 — Overdue assigned job** | A job has been `ASSIGNED` for **24+ hours** and is not yet `COMPLETED` | Admin, Office Manager, assigned technician, secondary technician |
| **2 — Documents missing before schedule** | A not-yet-started job has missing required documents as its scheduled date approaches — reminders at **24h / 12h / 6h / 3h / 1h** before the scheduled time | Admin, Office Manager |
| **3 — Started with pending documents** | A job is `IN_PROGRESS` but still has missing required documents | Admin, Office Manager |
| **4 — FSR unsubmitted (tech reminder)** | FSR became visible to the technician but has not been submitted — reminders at **+12h**, then **every 24h** | Assigned technician, secondary technician |
| **5 — FSR unsubmitted (admin/manager reminder)** | Same FSR condition, targeted at leadership — first at **next day 11:00 AM LA**, then **+12h** (11:00 PM), then **every 24h** | Admin, Office Manager |

## How it works

A single [`node-cron`](https://www.npmjs.com/package/node-cron) task runs **every 30 minutes** (`*/30 * * * *`, timezone `America/Los_Angeles`). On each tick it runs all five checks. Each check scans the relevant jobs/FSR documents, decides which notifications are due, and sends them through the existing `createNotification()` pipeline (in-app + Socket.io + Web Push).

The scheduler is registered in [`src/server.js`](../src/server.js) via `notificationScheduler.start()` immediately after `connectDB()`. Registration is synchronous; the first tick is 30 minutes out, by which point the DB is connected.

### Files

| File | Purpose |
|------|---------|
| `src/services/SchedulerService.js` | The cron task, all five rule implementations, and notification format helpers |
| `src/models/NotificationLog.js` | Deduplication ledger (one row per sent notification) |
| `src/models/Notification.js` | Enum types including `JOB_FSR_REMINDER_TECH`, `JOB_FSR_REMINDER_ADMIN` |
| `src/models/FsrDocument.js` | Added `technicianVisibleAt` field — the FSR reminder clock starts here |
| `src/scripts/runNotificationChecks.js` | Manual on-demand trigger (`pnpm run notify:check`) |
| `src/server.js` | Starts the scheduler on boot |

## Deduplication — `NotificationLog`

The cron re-evaluates every eligible job on every tick, so it must never send the same notification twice. Before sending, the scheduler **claims** a row in `NotificationLog`. The collection has a unique compound index on `{ job, type, ref }`, so the claim is atomic — if a row already exists the insert fails with a duplicate-key error and the send is skipped.

This makes the system safe across server restarts and overlapping ticks: the ledger is the source of truth, not in-memory state.

### The `ref` discriminator

`ref` lets the same notification *type* legitimately fire again when the underlying trigger genuinely changes:

| Rule | `type` | `ref` | Effect |
|------|--------|-------|--------|
| 1 | `OVERDUE_24H` | assignment timestamp (ISO) | **Reassigning a job resets the 24h clock.** A reassignment pushes a new `ASSIGNED` entry into `statusHistory`; the scheduler measures from the *latest* one, producing a new `ref`, so the new technician's 24h window is tracked independently. |
| 2 | `DOC_REMINDER_24H` … `DOC_REMINDER_1H` | the job's `scheduledDate` | **Rescheduling a job re-arms all 5 reminders** for the new date. |
| 3 | `DOC_STARTED_PENDING` | `''` (empty) | Fires exactly once per job. |
| 4 | `FSR_TECH_REMINDER` | ISO timestamp of the exact due instant | **Each checkpoint is independently deduplicated.** If the FSR is hidden and re-revealed (e.g. admin reverts the job), `technicianVisibleAt` is updated and an entirely new set of checkpoints fires. |
| 5 | `FSR_ADMIN_REMINDER` | ISO timestamp of the exact due instant | Same reset behaviour as Rule 4 — reverts that clear `technicianVisible` restart the admin clock too. |

## Scheduled-time assumption & timezone

`Job.scheduledDate` is a date-only string (`YYYY-MM-DD`) with no time component. For Rule 2, the job's scheduled *time* is defined as **08:00 America/Los_Angeles** on that date.

`SchedulerService.scheduledStartUtc()` converts that to a precise UTC instant. It is DST-correct without any date library — it reads the LA UTC offset for the date via `Intl.DateTimeFormat.formatToParts` (using a midday reference instant so the offset is always read on the correct side of the 02:00 DST switch).

| `scheduledDate` | Scheduled time (UTC) | Note |
|-----------------|----------------------|------|
| `2026-01-15` | `16:00:00Z` | PST (UTC-8) |
| `2026-07-15` | `15:00:00Z` | PDT (UTC-7) |
| `2026-03-08` | `15:00:00Z` | DST spring-forward day — correct |

To change the assumed start hour, edit `SCHEDULED_HOUR_LOCAL` in `SchedulerService.js`.

## Reminder windows (Rule 2)

Each reminder is eligible inside a **35-minute window** that opens at `scheduledTime − Nh`. The window is slightly wider than the 30-minute cron interval so a tick is never missed; the `NotificationLog` still guarantees a single send.

A consequence: if a job is created *after* a given window has already passed, that reminder is skipped — you cannot send a "24h before" reminder for a job that did not exist 24h before. The smaller-interval reminders still fire normally.

## "Missing required documents" — definition

A job has missing required documents when at least one row in `assignmentDocumentRequirements` is:

- `checked === true` (marked as required for this job), **and**
- has no uploaded `document.key`, **and**
- has no `textValue`

This matches the validation already used in `JobService.assignTechnician`. If no documents have been marked as required, the job has nothing to remind about.

## Configuration

All knobs are constants at the top of `SchedulerService.js`:

```js
const TIMEZONE = 'America/Los_Angeles';
const SCHEDULED_HOUR_LOCAL = 8;                 // job start hour for Rule 2
const CRON_EXPRESSION = '*/30 * * * *';         // every 30 minutes
const OVERDUE_HOURS = 24;                       // Rule 1 threshold
const DOC_REMINDER_THRESHOLDS = [24, 12, 6, 3, 1]; // Rule 2 reminders (hours)
const REMINDER_WINDOW_MS = 35 * 60 * 1000;      // Rule 2 eligibility window
```

## Operational notes

- **Process restarts** — `node-cron` runs in-process; on restart the task simply re-registers and resumes on the next `:00` / `:30`. The `NotificationLog` prevents any duplicates across the restart.
- **Failure isolation** — each of the three checks is wrapped in its own `try/catch`; one failing query never blocks the others.
- **Overlap protection** — the task is registered with `noOverlap: true`, so a tick is skipped if the previous run is somehow still in progress.
- **`createNotification` is non-throwing** — it logs and swallows its own errors, so a claimed-but-failed send will not crash a tick. (Net effect: claim-before-send can, in theory, "lose" a notification if delivery fails — an accepted trade-off to guarantee no duplicates.)

---

## How to test

### Quick path — manual trigger

```bash
cd backend
pnpm run notify:check
```

This runs all three checks once against the live DB and prints how many notifications each rule sent. Safe to run repeatedly (dedup ledger).

### Rule 1 — overdue assigned job

1. Create a job and assign a technician (status → `ASSIGNED`).
2. In MongoDB, back-date the `ASSIGNED` entry: set the `statusHistory` entry's `changedAt` to **25+ hours ago**.
   ```js
   db.jobs.updateOne(
     { _id: ObjectId("<jobId>"), "statusHistory.toStatus": "ASSIGNED" },
     { $set: { "statusHistory.$.changedAt": new Date(Date.now() - 25*3600*1000) } }
   )
   ```
3. Run `pnpm run notify:check` → expect **Rule 1 = 1**.
4. Verify admin, manager, and the assigned technician each received a `JOB_OVERDUE_INCOMPLETE` notification (check `db.notifications` or the in-app bell).
5. Run it again → **Rule 1 = 0** (deduped).
6. **Reset test:** reassign the job to another tech, then back-date the *new* `ASSIGNED` entry's `changedAt` by 25h. Run again → **Rule 1 = 1** (new `ref`, clock reset).

### Rule 2 — document reminders

1. Create a job, mark a document requirement as `checked` but leave it without a file/text (`assignmentDocumentRequirements`).
2. Set `scheduledDate` so that **08:00 LA on that date is ~24h from now** (e.g. if it's 09:00 today, set tomorrow's date — 08:00 tomorrow is ~23h out, inside the 24h window).
   - Easier: temporarily shrink a threshold or widen `REMINDER_WINDOW_MS` for testing, **or** set `scheduledDate` to today and rely on the 1h/3h windows depending on current LA time.
3. Run `pnpm run notify:check` → expect **Rule 2 = 1** if the current time falls inside one of the 35-min windows.
4. Verify admin + manager received `JOB_DOCS_MISSING_REMINDER` (technicians should **not**).
5. To exercise all five intervals without waiting, set `scheduledDate` and run the check at the corresponding wall-clock times, or unit-test `scheduledStartUtc` + window math directly.
6. **Re-arm test:** change `scheduledDate`, re-enter a window, run again → fires again (new `ref`).

> Tip: to verify the timing math without waiting, check `scheduledStartUtc()`:
> ```bash
> node -e "console.log(require('./src/services/SchedulerService').scheduledStartUtc('2026-07-15').toISOString())"
> # => 2026-07-15T15:00:00.000Z  (08:00 PDT)
> ```

### Rule 3 — started with pending documents

1. Create a job, mark a document requirement as `checked` with no file/text.
2. Move the job to `IN_PROGRESS`.
3. Run `pnpm run notify:check` → expect **Rule 3 = 1**.
4. Verify admin + manager received `JOB_STARTED_DOCS_PENDING` (technicians should **not**).
5. Upload the missing document, run again → **Rule 3 = 0** (already fired once; and now nothing is missing anyway).

### Rule 4 — FSR tech reminder

1. Create a programming job, assign a technician, and move the job to `IN_PROGRESS`.
2. The technician opens the FSR → `technicianVisible: true` and `technicianVisibleAt` are set.
3. Back-date `technicianVisibleAt` by **13+ hours** in MongoDB:
   ```js
   db.fsrdocuments.updateOne(
     { job: ObjectId("<jobId>") },
     { $set: { technicianVisibleAt: new Date(Date.now() - 13*3600*1000) } }
   )
   ```
4. Run `pnpm run notify:check` → expect **Rule 4 = 1**.
5. Verify the assigned technician received `JOB_FSR_REMINDER_TECH`.
6. Run again → **Rule 4 = 0** (deduped).
7. **Reset / re-arm:** delete the ledger row and back-date by 25+ hours to test the 24h repeat:
   ```js
   db.notificationlogs.deleteMany({ job: ObjectId("<jobId>"), type: "FSR_TECH_REMINDER" })
   db.fsrdocuments.updateOne(
     { job: ObjectId("<jobId>") },
     { $set: { technicianVisibleAt: new Date(Date.now() - 25*3600*1000) } }
   )
   ```
8. Verify the technician clock resets when the job is reverted (admin undoes IN_PROGRESS → ASSIGNED): `technicianVisible` is cleared, the FSR is excluded from the query, and no more reminders fire until the tech re-opens the FSR.

### Rule 5 — FSR admin/manager reminder

1. Same setup as Rule 4.
2. Set `technicianVisibleAt` to **yesterday at any time before 11:00 AM LA** so the "next day 11 AM" window has passed:
   ```js
   db.fsrdocuments.updateOne(
     { job: ObjectId("<jobId>") },
     { $set: { technicianVisibleAt: new Date(Date.now() - 25*3600*1000) } }
   )
   ```
   (Adjust the offset so the computed `nextDayAtAdminHourUtc` falls inside the current 35-minute window.)
3. Run `pnpm run notify:check` → expect **Rule 5 = 1**.
4. Verify admin + manager received `JOB_FSR_REMINDER_ADMIN` (technicians should **not**).
5. Run again → **Rule 5 = 0** (deduped).

> **Tip:** verify the admin reminder time math:
> ```bash
> node -e "console.log(require('./src/services/SchedulerService').nextDayAtAdminHourUtc(new Date()).toISOString())"
> # => UTC instant for 11:00 AM LA tomorrow
> ```

### Verifying the live cron

- Start the server (`pnpm dev`). You should see:
  `[Scheduler] Notification scheduler started (cron "*/30 * * * *", tz America/Los_Angeles)`
- The first real tick runs at the next `:00` or `:30`. To verify faster, temporarily set `CRON_EXPRESSION` to `'* * * * *'` (every minute) in `SchedulerService.js`, restart, and watch — then revert.

### Inspecting the dedup ledger

```js
db.notificationlogs.find({ job: ObjectId("<jobId>") })
// To force a notification to be re-sendable, delete its log row:
db.notificationlogs.deleteOne({ job: ObjectId("<jobId>"), type: "OVERDUE_24H" })
```
