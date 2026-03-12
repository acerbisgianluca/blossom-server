import {
  generateKey,
  hexToKey,
  keyToHex,
  unwrapKey,
  wrapKey,
} from "./encryption.js";
import {
  decryptNIP44,
  encryptNIP44,
  fetchFilesInFolder,
  fetchFolder,
  fetchLatestFolderShare,
  fetchUserFolders,
  getAccessKeyForRecipient,
  getAllTagValues,
  getFolderIdFromRef,
  getTagValue,
  publishFileMetadata,
  publishFolderEvent,
  publishFolderShare,
} from "./nostr.js";

function normalizePubkey(pubkey) {
  const value = pubkey?.trim();
  if (!value) return "";

  if (value.startsWith("npub")) {
    const decoded = window.NostrTools?.nip19?.decode?.(value);
    if (!decoded || decoded.type !== "npub" || !decoded.data) {
      throw new Error("Invalid npub recipient key");
    }
    return decoded.data;
  }

  return value;
}

function getEventVersion(event) {
  const rawVersion = getTagValue(event, "version");
  const parsedVersion = Number.parseInt(rawVersion || "0", 10);
  return Number.isFinite(parsedVersion) ? parsedVersion : 0;
}

function uniquePubkeys(pubkeys = []) {
  const clean = pubkeys.map((pubkey) => normalizePubkey(pubkey)).filter(Boolean);
  return [...new Set(clean)];
}

function createRandomFolderId() {
  const bytes = window.crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function buildRecipientEntries(folderKey, recipients) {
  const entries = [];
  for (const recipient of recipients) {
    const encryptedFolderKey = await encryptNIP44(keyToHex(folderKey), recipient);
    entries.push({ pubkey: recipient, encryptedFolderKey });
  }
  return entries;
}

function extractMetadataPayload(metadataEvent) {
  return {
    blobHash: getTagValue(metadataEvent, "x"),
    blobUrl: getTagValue(metadataEvent, "url"),
    fileVersion: getEventVersion(metadataEvent),
    mimeType: getTagValue(metadataEvent, "m") || "application/octet-stream",
    fileSize: Number.parseInt(getTagValue(metadataEvent, "size") || "0", 10),
    fileName: getTagValue(metadataEvent, "name") || undefined,
    fileId: getTagValue(metadataEvent, "file_id") || undefined,
    folderId: getFolderIdFromRef(getTagValue(metadataEvent, "folder")) || undefined,
  };
}

async function resolveFolderAccess(folderId, ownerPubkey = null) {
  const myPubkey = normalizePubkey(await window.nostr.getPublicKey());
  const effectiveOwner = normalizePubkey(ownerPubkey || myPubkey);

  const folderEvent = await fetchFolder(effectiveOwner, folderId);
  if (!folderEvent) {
    throw new Error("Folder event not found");
  }

  const shareEvent = await fetchLatestFolderShare(folderId, folderEvent.pubkey);
  if (!shareEvent) {
    throw new Error("Folder share event not found");
  }

  const encryptedFolderKey = getAccessKeyForRecipient(shareEvent, myPubkey);
  if (!encryptedFolderKey) {
    throw new Error("Current user does not have access to this folder key");
  }

  const decryptedHex = await decryptNIP44(encryptedFolderKey, shareEvent.pubkey);
  const folderKey = hexToKey(decryptedHex);
  const recipients = uniquePubkeys(getAllTagValues(shareEvent, "p"));

  return {
    myPubkey,
    folderEvent,
    shareEvent,
    folderKey,
    recipients,
  };
}

export async function createFolder(name, recipients = []) {
  const myPubkey = normalizePubkey(await window.nostr.getPublicKey());
  const folderId = createRandomFolderId();
  const folderName = (name || "Untitled Folder").trim();
  const folderKey = await generateKey();
  const allowlist = uniquePubkeys([myPubkey, ...recipients]);

  await publishFolderEvent(folderId, folderName);
  const recipientEntries = await buildRecipientEntries(folderKey, allowlist);
  await publishFolderShare({ folderId, recipients: recipientEntries, version: 1 });

  return {
    folderId,
    folderName,
    ownerPubkey: myPubkey,
    recipients: allowlist,
    folderKey,
  };
}

export async function getFolder(folderId, ownerPubkey = null) {
  const pubkey = normalizePubkey(ownerPubkey || await window.nostr.getPublicKey());
  return fetchFolder(pubkey, folderId);
}

export async function listUserFolders() {
  const myPubkey = normalizePubkey(await window.nostr.getPublicKey());
  return fetchUserFolders(myPubkey);
}

export async function getFolderKey(folderId, ownerPubkey = null) {
  const { folderKey } = await resolveFolderAccess(folderId, ownerPubkey);
  return folderKey;
}

export async function shareFolder(folderId, recipientPubkey, ownerPubkey = null) {
  const { myPubkey, folderKey, recipients, shareEvent } = await resolveFolderAccess(folderId, ownerPubkey);
  const allowlist = uniquePubkeys([myPubkey, ...recipients, normalizePubkey(recipientPubkey)]);
  const recipientEntries = await buildRecipientEntries(folderKey, allowlist);
  await publishFolderShare({
    folderId,
    recipients: recipientEntries,
    createdAt: (shareEvent?.created_at || 0) + 1,
    version: getEventVersion(shareEvent) + 1,
  });
}

export async function rotateFolderKey(folderId, ownerPubkey = null) {
  const { myPubkey, folderEvent, folderKey, recipients, shareEvent } = await resolveFolderAccess(folderId, ownerPubkey);
  const files = await fetchFilesInFolder(folderEvent.pubkey, folderId);
  const newFolderKey = await generateKey();

  for (const fileEvent of files) {
    const wrappedFDK = getTagValue(fileEvent, "wrapped_fdk");
    if (!wrappedFDK) continue;

    const fileDataKey = await unwrapKey(wrappedFDK, folderKey);
    const nextWrappedFDK = await wrapKey(fileDataKey, newFolderKey);

    await publishFileMetadata({
      ...extractMetadataPayload(fileEvent),
      createdAt: (fileEvent.created_at || 0) + 1,
      fileVersion: getEventVersion(fileEvent) + 1,
      wrappedFDK: nextWrappedFDK,
      folderId,
    });
  }

  const allowlist = uniquePubkeys([myPubkey, ...recipients]);
  const recipientEntries = await buildRecipientEntries(newFolderKey, allowlist);
  await publishFolderShare({
    folderId,
    recipients: recipientEntries,
    createdAt: (shareEvent?.created_at || 0) + 1,
    version: getEventVersion(shareEvent) + 1,
  });
}

export async function revokeUser(folderId, recipientPubkey, ownerPubkey = null) {
  const { myPubkey, folderEvent, folderKey, recipients, shareEvent } = await resolveFolderAccess(folderId, ownerPubkey);
  const normalizedRecipientPubkey = normalizePubkey(recipientPubkey);
  const files = await fetchFilesInFolder(folderEvent.pubkey, folderId);
  const newFolderKey = await generateKey();

  for (const fileEvent of files) {
    const wrappedFDK = getTagValue(fileEvent, "wrapped_fdk");
    if (!wrappedFDK) continue;

    const fileDataKey = await unwrapKey(wrappedFDK, folderKey);
    const nextWrappedFDK = await wrapKey(fileDataKey, newFolderKey);

    await publishFileMetadata({
      ...extractMetadataPayload(fileEvent),
      createdAt: (fileEvent.created_at || 0) + 1,
      fileVersion: getEventVersion(fileEvent) + 1,
      wrappedFDK: nextWrappedFDK,
      folderId,
    });
  }

  const allowlist = uniquePubkeys([
    myPubkey,
    ...recipients.filter((recipient) => recipient !== normalizedRecipientPubkey),
  ]);
  const recipientEntries = await buildRecipientEntries(newFolderKey, allowlist);
  await publishFolderShare({
    folderId,
    recipients: recipientEntries,
    createdAt: (shareEvent?.created_at || 0) + 1,
    version: getEventVersion(shareEvent) + 1,
  });
}

export async function getFolderAccessState(folderId, ownerPubkey = null) {
  const { folderEvent, recipients } = await resolveFolderAccess(folderId, ownerPubkey);
  return {
    ownerPubkey: folderEvent.pubkey,
    folderName: getTagValue(folderEvent, "name") || folderId,
    recipients,
  };
}
