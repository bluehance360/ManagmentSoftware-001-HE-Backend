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
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  BILLED: 'BILLED',
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
    [JOB_STATUS.IN_PROGRESS]: [ROLES.TECHNICIAN],
  },
  [JOB_STATUS.IN_PROGRESS]: {
    [JOB_STATUS.COMPLETED]: [ROLES.TECHNICIAN],
  },
  [JOB_STATUS.COMPLETED]: {
    [JOB_STATUS.BILLED]: [ROLES.ADMIN, ROLES.OFFICE_MANAGER],
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
