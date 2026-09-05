import type {Request, Response} from "express";
import {getApps, initializeApp} from "firebase-admin/app";
import {getFirestore, type Firestore} from "firebase-admin/firestore";
import {verifyFirebaseIdToken} from "../../middleware/auth";
import {assertMembershipManager, normalizeMembershipInput} from "./policy";

/**
 * Return the canonical named Firestore database.
 *
 * @return {Firestore} Admin Firestore client.
 */
function adminDatabase(): Firestore {
  const app = getApps()[0] || initializeApp();
  return getFirestore(app, "mediprisma");
}

/**
 * Create or update a tenant membership after owner authorization.
 *
 * @param {Request} req Authenticated HTTP request.
 * @param {Response} res HTTP response.
 */
export async function handleMembershipAdmin(
  req: Request,
  res: Response,
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({error: "METHOD_NOT_ALLOWED"});
    return;
  }
  const actor = await verifyFirebaseIdToken(req, res);
  if (!actor) return;
  if (actor.isAnonymous) {
    res.status(403).json({error: "REAL_ACCOUNT_REQUIRED"});
    return;
  }
  try {
    const membership = normalizeMembershipInput(req.body);
    const db = adminDatabase();
    const actorRef = db.doc(
      `users/${actor.uid}/memberships/${membership.tenant_id}`,
    );
    const actorSnapshot = await actorRef.get();
    assertMembershipManager(
      actorSnapshot.exists ? actorSnapshot.data() : null,
      actor.uid,
      membership.tenant_id,
    );

    const targetRef = db.doc(
      `users/${membership.uid}/memberships/${membership.tenant_id}`,
    );
    const auditRef = db.collection(
      `tenants/${membership.tenant_id}/membershipAudit`,
    ).doc();
    const timestamp = new Date().toISOString();
    const batch = db.batch();
    batch.set(targetRef, {
      ...membership,
      updated_at: timestamp,
      updated_by: actor.uid,
    }, {merge: true});
    batch.set(auditRef, {
      tenant_id: membership.tenant_id,
      actor_uid: actor.uid,
      target_uid: membership.uid,
      role: membership.role,
      status: membership.status,
      created_at: timestamp,
    });
    await batch.commit();
    res.status(200).json({membership});
  } catch (error) {
    const code = error instanceof Error ?
      error.message : "MEMBERSHIP_ADMIN_FAILED";
    const status = code === "MEMBERSHIP_ADMIN_FORBIDDEN" ? 403 :
      code === "INVALID_MEMBERSHIP" ? 400 : 500;
    res.status(status).json({error: code});
  }
}
