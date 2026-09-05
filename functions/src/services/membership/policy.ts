export const TENANT_ROLES = ["owner", "builder", "reviewer", "member"] as const;
export type TenantRole = typeof TENANT_ROLES[number];

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface MembershipRecord {
  uid: string;
  tenant_id: string;
  role: TenantRole;
  status: "active" | "disabled";
  display_name?: string;
}

/**
 * Validate the canonical membership shape accepted by the Admin Function.
 *
 * @param {unknown} value Untrusted JSON request body.
 * @return {MembershipRecord} A bounded membership record.
 */
export function normalizeMembershipInput(value: unknown): MembershipRecord {
  const input = (value && typeof value === "object" ? value : {}) as
    Record<string, unknown>;
  const uid = typeof input.uid === "string" ? input.uid.trim() : "";
  const tenantId = typeof input.tenant_id === "string" ?
    input.tenant_id.trim() : "";
  const role = typeof input.role === "string" ? input.role.trim() : "";
  const status = input.status;
  const displayName = typeof input.display_name === "string" ?
    input.display_name.trim().slice(0, 120) : "";
  if (
    !IDENTIFIER.test(uid) ||
    !IDENTIFIER.test(tenantId) ||
    !TENANT_ROLES.includes(role as TenantRole) ||
    !["active", "disabled"].includes(String(status))
  ) {
    throw new Error("INVALID_MEMBERSHIP");
  }
  return {
    uid,
    tenant_id: tenantId,
    role: role as TenantRole,
    status: status as MembershipRecord["status"],
    ...(displayName ? {display_name: displayName} : {}),
  };
}

/**
 * Require an active owner membership for the tenant being administered.
 *
 * @param {unknown} value Stored actor membership.
 * @param {string} actorUid Verified Firebase uid.
 * @param {string} tenantId Tenant being changed.
 */
export function assertMembershipManager(
  value: unknown,
  actorUid: string,
  tenantId: string,
): void {
  const record = value as Partial<MembershipRecord> | null;
  if (
    !record ||
    record.uid !== actorUid ||
    record.tenant_id !== tenantId ||
    record.status !== "active" ||
    record.role !== "owner"
  ) {
    throw new Error("MEMBERSHIP_ADMIN_FORBIDDEN");
  }
}
