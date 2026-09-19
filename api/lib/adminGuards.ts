// Pure guard logic for admin-role mutations — extracted for unit testing.
//
// Lockout footgun: without these checks an admin can demote themselves or
// demote the last remaining admin, leaving the deployment with no way to
// reach the admin panel short of direct SQL.

export interface AdminDemotionCheck {
  actorId: number;
  targetId: number;
  /** Is the target currently an admin (before this mutation)? */
  targetIsAdmin: boolean;
  /** Number of admins currently in the system (before this mutation). */
  adminCount: number;
  newRole: "user" | "admin";
}

/** Returns an error message when the demotion must be blocked, else null. */
export function adminDemotionError(check: AdminDemotionCheck): string | null {
  if (check.newRole === "admin") return null; // promotions are always safe
  if (!check.targetIsAdmin) return null; // demoting a non-admin changes nothing
  if (check.actorId === check.targetId) {
    return "You cannot demote yourself — ask another admin to change your role.";
  }
  if (check.adminCount <= 1) {
    return "Cannot demote the last remaining admin — promote another user first.";
  }
  return null;
}
