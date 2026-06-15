import '../mod/env.js';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const LEGACY_COLLECTIONS = [
  'build_deploy_events',
  'deployment_receipts',
  'funding_events',
  'orbkit_service_events',
  'orbkit_services',
  'project_structure_events',
  'project_structure_snapshots',
  'wallet_balance_cache',
];

const LEGACY_RUNTIME_KEYS = [
  'buildDeployEvents',
  'deploymentReceipts',
  'fundingEvents',
  'orbkitServiceEvents',
  'orbkitServices',
  'projectStructureEvents',
  'projectStructureSnapshots',
  'walletBalanceCache',
];

function normalizePrivateKey(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function hasExplicitFirebaseCredentials() {
  return Boolean(
    process.env.FIREBASE_PROJECT_ID
    && process.env.FIREBASE_CLIENT_EMAIL
    && process.env.FIREBASE_PRIVATE_KEY,
  );
}

function createFirebaseApp() {
  if (getApps().length > 0) {
    return getApps()[0];
  }

  if (hasExplicitFirebaseCredentials()) {
    return initializeApp({
      credential: cert({
        projectId: String(process.env.FIREBASE_PROJECT_ID).trim(),
        clientEmail: String(process.env.FIREBASE_CLIENT_EMAIL).trim(),
        privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL || undefined,
    });
  }

  return initializeApp({
    credential: applicationDefault(),
    databaseURL: process.env.FIREBASE_DATABASE_URL || undefined,
  });
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function deleteCollection(collectionRef, options = {}) {
  const batchSize = Number(options.batchSize || 200);
  let deleted = 0;

  for (;;) {
    const snap = await collectionRef.limit(batchSize).get();
    if (snap.empty) break;

    if (options.dryRun) {
      deleted += snap.size;
      break;
    }

    const batch = collectionRef.firestore.batch();
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    deleted += snap.size;
  }

  return deleted;
}

async function main() {
  const dryRun = hasFlag('--dry-run');
  const firestore = getFirestore(createFirebaseApp());
  const metadata = firestore.collection(process.env.FIREBASE_METADATA_COLLECTION || '_meta');
  const deletedCollections = [];
  const missingCollections = [];

  for (const name of LEGACY_COLLECTIONS) {
    const collectionRef = firestore.collection(name);
    const probe = await collectionRef.limit(1).get();
    if (probe.empty) {
      missingCollections.push(name);
      continue;
    }

    const deletedDocs = await deleteCollection(collectionRef, { dryRun });
    deletedCollections.push({ name, deletedDocs });
  }

  const metadataDocIds = [
    ...LEGACY_COLLECTIONS.map((name) => `collection:${name}`),
    ...LEGACY_COLLECTIONS.map((name) => `runtime:${name}`),
    ...LEGACY_RUNTIME_KEYS.map((name) => `runtime:${name}`),
  ];
  const existingMetadataDocs = [];
  for (const id of metadataDocIds) {
    const doc = await metadata.doc(id).get();
    if (doc.exists) existingMetadataDocs.push(id);
  }

  if (!dryRun && existingMetadataDocs.length > 0) {
    const batch = firestore.batch();
    for (const id of existingMetadataDocs) {
      batch.delete(metadata.doc(id));
    }
    await batch.commit();
  }

  const remainingCollections = (await firestore.listCollections())
    .map((collection) => collection.id)
    .sort((left, right) => left.localeCompare(right));

  const action = dryRun ? 'Would delete' : 'Deleted';
  console.log(`${action} legacy runtime collections:`);
  if (deletedCollections.length === 0) {
    console.log('- none');
  } else {
    for (const item of deletedCollections) {
      console.log(`- ${item.name}: ${item.deletedDocs} document(s)`);
    }
  }
  console.log(`${action} legacy metadata docs: ${existingMetadataDocs.length}`);
  console.log(`Already empty or absent: ${missingCollections.length}`);
  console.log('Remaining top-level collections:');
  for (const name of remainingCollections) {
    console.log(`- ${name}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
