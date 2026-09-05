import {assertMembershipManager, normalizeMembershipInput} from "../functions/src/services/membership/policy";

describe("tenant membership authority", () => {
  it("accepts only allowlisted roles and canonical tenant_id", () => {
    expect(normalizeMembershipInput({
      uid: "builder-a",
      tenant_id: "hospital-a",
      role: "builder",
      status: "active",
      display_name: "Hospital A",
    })).toEqual({
      uid: "builder-a",
      tenant_id: "hospital-a",
      role: "builder",
      status: "active",
      display_name: "Hospital A",
    });
    expect(() => normalizeMembershipInput({uid: "builder-a", tenant_id: "../other", role: "owner"})).toThrow("INVALID_MEMBERSHIP");
    expect(() => normalizeMembershipInput({uid: "builder-a", tenant_id: "hospital-a", role: "admin"})).toThrow("INVALID_MEMBERSHIP");
    expect(() => normalizeMembershipInput({
      uid: "builder-a", tenant_id: "hospital-a", role: "builder", status: "actve",
    })).toThrow("INVALID_MEMBERSHIP");
  });

  it("allows only an active owner in the same tenant to manage memberships", () => {
    expect(() => assertMembershipManager({
      uid: "owner-a", tenant_id: "hospital-a", role: "owner", status: "active",
    }, "owner-a", "hospital-a")).not.toThrow();
    expect(() => assertMembershipManager({
      uid: "owner-a", tenant_id: "hospital-b", role: "owner", status: "active",
    }, "owner-a", "hospital-a")).toThrow("MEMBERSHIP_ADMIN_FORBIDDEN");
    expect(() => assertMembershipManager({
      uid: "builder-a", tenant_id: "hospital-a", role: "builder", status: "active",
    }, "builder-a", "hospital-a")).toThrow("MEMBERSHIP_ADMIN_FORBIDDEN");
  });
});
