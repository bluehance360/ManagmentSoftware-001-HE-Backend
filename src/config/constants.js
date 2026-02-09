/**
 * Application constants for Field Service Management
 */

// User roles
const ROLES = {
  ADMIN: 'ADMIN',
  OFFICE_MANAGER: 'OFFICE_MANAGER',
  TECHNICIAN: 'TECHNICIAN',
};

// Job statuses
const JOB_STATUS = {
  TENTATIVE: 'TENTATIVE',
  CONFIRMED: 'CONFIRMED',
  ASSIGNED: 'ASSIGNED',
  DISPATCHED: 'DISPATCHED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  BILLED: 'BILLED',
};

// Valid status transitions with required roles
// Key: current status -> Value: { nextStatus: [allowedRoles] }
//
// Flow: TENTATIVE → CONFIRMED → ASSIGNED → DISPATCHED → IN_PROGRESS → COMPLETED → BILLED
//   - ASSIGNED: visible to Manager for review. Manager adds a note and dispatches.
//   - DISPATCHED: now visible to the assigned Technician.
const STATUS_TRANSITIONS = {
  [JOB_STATUS.TENTATIVE]: {
    [JOB_STATUS.CONFIRMED]: [ROLES.ADMIN],
  },
  [JOB_STATUS.CONFIRMED]: {
    [JOB_STATUS.ASSIGNED]: [ROLES.ADMIN],
  },
  [JOB_STATUS.ASSIGNED]: {
    [JOB_STATUS.DISPATCHED]: [ROLES.OFFICE_MANAGER],
  },
  [JOB_STATUS.DISPATCHED]: {
    [JOB_STATUS.IN_PROGRESS]: [ROLES.TECHNICIAN],
  },
  [JOB_STATUS.IN_PROGRESS]: {
    [JOB_STATUS.COMPLETED]: [ROLES.TECHNICIAN],
  },
  [JOB_STATUS.COMPLETED]: {
    [JOB_STATUS.BILLED]: [ROLES.OFFICE_MANAGER],
  },
  [JOB_STATUS.BILLED]: {
    // Terminal state - no transitions allowed
  },
};

module.exports = {
  ROLES,
  JOB_STATUS,
  STATUS_TRANSITIONS,
};
