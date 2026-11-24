const { ROLES, JOB_STATUS } = require('../config/constants');

// Statuses at which an assigned technician can see a job.
const TECH_VISIBLE_STATUSES = [
  JOB_STATUS.ASSIGNED,
  JOB_STATUS.IN_PROGRESS,
  JOB_STATUS.COMPLETED,
  JOB_STATUS.BILLED,
  JOB_STATUS.PAID,
  JOB_STATUS.CLOSED,
];

/**
 * Whether `user` may see `job`. Admins / Office Managers see every job; a technician sees
 * jobs they are assigned to (primary or secondary) once assigned, plus return visits of a
 * parent job they were assigned to. `job.parentJob` must be populated with its technicians
 * for the return-visit rule to apply.
 */
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

function formatRoleLabel(role) {
  if (!role) return 'User';
  if (role === ROLES.OFFICE_MANAGER) return 'Office Manager';
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
}

/** "Name (Role)" - how actors are named in notification messages. */
function actorWithRole(user) {
  return `${user.name} (${formatRoleLabel(user.role)})`;
}

module.exports = {
  TECH_VISIBLE_STATUSES,
  canAccessJob,
  formatRoleLabel,
  actorWithRole,
};
