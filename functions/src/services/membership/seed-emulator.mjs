import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const EXPECTED_PROJECT = "demo-mediprisma";
const EXPECTED_AUTH_HOST = "127.0.0.1:9099";
const EXPECTED_FIRESTORE_HOST = "127.0.0.1:8080";

if (
  process.env.GCLOUD_PROJECT !== EXPECTED_PROJECT ||
  process.env.FIREBASE_AUTH_EMULATOR_HOST !== EXPECTED_AUTH_HOST ||
  process.env.FIRESTORE_EMULATOR_HOST !== EXPECTED_FIRESTORE_HOST
) {
  throw new Error("EMULATOR_ONLY");
}

const app = getApps()[0] || initializeApp({ projectId: EXPECTED_PROJECT });
const auth = getAuth(app);
const db = getFirestore(app, "mediprisma");
const password = "StudioDev123!";
const users = [
  {
    uid: "studio-owner",
    email: "studio-owner@example.test",
    memberships: [
      { tenant_id: "hospital-a", role: "owner", display_name: "Hospital A" },
      { tenant_id: "hospital-b", role: "builder", display_name: "Hospital B" },
    ],
  },
  {
    uid: "studio-reviewer",
    email: "studio-reviewer@example.test",
    memberships: [
      { tenant_id: "hospital-a", role: "reviewer", display_name: "Hospital A" },
    ],
  },
];

for (const fixture of users) {
  try {
    await auth.createUser({
      uid: fixture.uid,
      email: fixture.email,
      emailVerified: true,
      password,
      displayName: fixture.uid === "studio-owner" ? "Studio Owner" : "Studio Reviewer",
    });
  } catch (error) {
    if (error?.code !== "auth/uid-already-exists" && error?.code !== "auth/email-already-exists") {
      throw error;
    }
  }
  const batch = db.batch();
  for (const membership of fixture.memberships) {
    batch.set(
      db.doc(`users/${fixture.uid}/memberships/${membership.tenant_id}`),
      {
        uid: fixture.uid,
        ...membership,
        status: "active",
        updated_at: new Date().toISOString(),
        updated_by: "emulator-seed",
      },
    );
  }
  await batch.commit();
}

process.stdout.write(
  `Seeded ${users.length} synthetic Studio members in ${EXPECTED_PROJECT}.\n`,
);
