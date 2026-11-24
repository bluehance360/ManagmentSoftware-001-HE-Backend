/**
 * Application constants for Field Service Management
 */

// User roles
const ROLES = {
  ADMIN: 'ADMIN',
  OFFICE_MANAGER: 'OFFICE_MANAGER',
  TECHNICIAN: 'TECHNICIAN',
};

const TIMEOUT_REQUEST_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
};

// Job statuses
const JOB_STATUS = {
  TENTATIVE:   'TENTATIVE',
  CONFIRMED:   'CONFIRMED',
  ASSIGNED:    'ASSIGNED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED:   'COMPLETED',
  BILLED:      'BILLED',
  PAID:        'PAID',
  CLOSED:      'CLOSED',
};

// Valid status transitions with required roles
// Key: current status -> Value: { nextStatus: [allowedRoles] }
//
// Flow: TENTATIVE → CONFIRMED → ASSIGNED → IN_PROGRESS → COMPLETED → BILLED
//   - ASSIGNED: tech is notified immediately and can start work.
const STATUS_TRANSITIONS = {
  [JOB_STATUS.TENTATIVE]: {
    [JOB_STATUS.CONFIRMED]: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
  },
  [JOB_STATUS.CONFIRMED]: {
    [JOB_STATUS.ASSIGNED]: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
  },
  [JOB_STATUS.ASSIGNED]: {
    [JOB_STATUS.IN_PROGRESS]: [ROLES.TECHNICIAN, ROLES.ADMIN, ROLES.OFFICE_MANAGER],
  },
  [JOB_STATUS.IN_PROGRESS]: {
    [JOB_STATUS.COMPLETED]: [ROLES.TECHNICIAN, ROLES.ADMIN, ROLES.OFFICE_MANAGER],
  },
  [JOB_STATUS.COMPLETED]: {
    [JOB_STATUS.BILLED]: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
  },
  [JOB_STATUS.BILLED]: {
    [JOB_STATUS.PAID]: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
  },
  [JOB_STATUS.PAID]: {
    [JOB_STATUS.CLOSED]: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
  },
  [JOB_STATUS.CLOSED]: {
    // Terminal state - no further transitions
  },
};

/**
 * Lifecycle of a job receipt:
 *   SUBMITTED  - photos uploaded by a technician, waiting for office review (office enters the amount)
 *   APPROVED   - office approved the expense, not paid out yet
 *   REIMBURSED - office paid the technician back (can be marked straight from SUBMITTED)
 *   REJECTED   - office rejected it (with a reason); excluded from totals. The uploader can
 *                edit it, which resubmits it.
 */
const RECEIPT_STATUS = {
  SUBMITTED: 'SUBMITTED',
  APPROVED: 'APPROVED',
  REIMBURSED: 'REIMBURSED',
  REJECTED: 'REJECTED',
};

const RECEIPT_MAX_PHOTOS = 5;
/** $100,000 - a sanity cap that catches typos like a missing decimal point. */
const RECEIPT_MAX_AMOUNT_CENTS = 10_000_000;

module.exports = {
  ROLES,
  JOB_STATUS,
  STATUS_TRANSITIONS,
  TIMEOUT_REQUEST_STATUS,
  RECEIPT_STATUS,
  RECEIPT_MAX_PHOTOS,
  RECEIPT_MAX_AMOUNT_CENTS,
};
