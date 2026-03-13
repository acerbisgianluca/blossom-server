import {
  generateKey,
  hexToKey,
  keyToHex,
  unwrapKey,
  wrapKey,
} from "./encryption.js";
import {
  buildFolderAddress,
  decryptNIP44,
  encryptNIP44,
  fetchFilesInFolder,
  fetchFolder,
  fetchShareEventsForFolder,
  fetchLatestFolderShare,
  fetchUserFolders,
  getFolderIdFromRef,
  getTagValue,
  publishDeletion,
  publishFileMetadata,
  publishFolderEvent,
  publishShareEvent,
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
  const folderRef = getTagValue(metadataEvent, "a") || getTagValue(metadataEvent, "folder");
  return {
    blobHash: getTagValue(metadataEvent, "x"),
    blobUrl: getTagValue(metadataEvent, "url"),
    fileVersion: getEventVersion(metadataEvent),
    mimeType: getTagValue(metadataEvent, "m") || "application/octet-stream",
    fileSize: Number.parseInt(getTagValue(metadataEvent, "size") || "0", 10),
    fileName: getTagValue(metadataEvent, "name") || undefined,
    fileId: getTagValue(metadataEvent, "file_id") || undefined,
    folderId: getFolderIdFromRef(folderRef) || undefined,
  };
}

async function resolveFolderContext(folderId, ownerPubkey = null) {
  const myPubkey = normalizePubkey(await window.nostr.getPublicKey());
  const effectiveOwner = normalizePubkey(ownerPubkey || myPubkey);
  const folderEvent = await fetchFolder(effectiveOwner, folderId);
  if (!folderEvent) {
    throw new Error("Folder event not found");
  }

  const folderAddress = buildFolderAddress(folderEvent);
  return {
    myPubkey,
    ownerPubkey: folderEvent.pubkey,
    folderEvent,
    folderAddress,
  };
}

function mustBeOwner(context) {
  if (context.myPubkey !== context.ownerPubkey) {
    throw new Error("Only the folder owner can change sharing state");
  }
}

export async function getShareEvent(folderId, recipientPubkey, ownerPubkey = null) {
  const context = await resolveFolderContext(folderId, ownerPubkey);
  const recipient = normalizePubkey(recipientPubkey);
  return fetchLatestFolderShare(folderId, context.ownerPubkey, recipient);
}

async function resolveFolderAccessKey(folderId, ownerPubkey = null, accessorPubkey = null) {
  const context = await resolveFolderContext(folderId, ownerPubkey);
  const recipient = normalizePubkey(accessorPubkey || context.myPubkey);
  const shareEvent = await getShareEvent(folderId, recipient, context.ownerPubkey);

  if (!shareEvent) {
    throw new Error("Folder share event not found for this user");
  }

  const encryptedFolderKey = getTagValue(shareEvent, "key");
  if (!encryptedFolderKey) {
    throw new Error("Folder share event is missing encrypted folder key");
  }

  const decryptedHex = await decryptNIP44(encryptedFolderKey, shareEvent.pubkey);
  const folderKey = hexToKey(decryptedHex);

  return {
    ...context,
    shareEvent,
    folderKey,
  };
}

export async function listRecipients(folderId, ownerPubkey = null) {
  const { folderAddress } = await resolveFolderContext(folderId, ownerPubkey);
  const shareEvents = await fetchShareEventsForFolder(folderAddress);
  return uniquePubkeys(shareEvents.map((shareEvent) => getTagValue(shareEvent, "p")));
}

async function publishSharesForRecipients(folderId, ownerPubkey, folderKey, recipients) {
  const uniqueRecipients = uniquePubkeys(recipients);
  const entries = await buildRecipientEntries(folderKey, uniqueRecipients);
  for (const entry of entries) {
    await publishShareEvent({
      folderId,
      ownerPubkey,
      recipientPubkey: entry.pubkey,
      encryptedKey: entry.encryptedFolderKey,
    });
  }
}

export async function createFolder(name, recipients = [], options = {}) {
  const myPubkey = normalizePubkey(await window.nostr.getPublicKey());
  const folderId = createRandomFolderId();
  const folderName = (name || "Untitled Folder").trim();
  const folderKey = await generateKey();
  const allowlist = uniquePubkeys([myPubkey, ...recipients]);

  await publishFolderEvent(folderId, folderName, options);
  await publishSharesForRecipients(folderId, myPubkey, folderKey, allowlist);

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
  const { folderKey } = await resolveFolderAccessKey(folderId, ownerPubkey);
  return folderKey;
}

export async function grantAccess(folderId, recipientPubkey, ownerPubkey = null, options = {}) {
  const paymentEventId = options.paymentEventId || null;
  const context = await resolveFolderAccessKey(folderId, ownerPubkey);
  mustBeOwner(context);

  const recipient = normalizePubkey(recipientPubkey);
  const encryptedKey = await encryptNIP44(keyToHex(context.folderKey), recipient);
  await publishShareEvent({
    folderId,
    ownerPubkey: context.ownerPubkey,
    recipientPubkey: recipient,
    encryptedKey,
    payment: paymentEventId || null,
    createdAt: (context.shareEvent?.created_at || 0) + 1,
  });
}

async function rewrapFolderFiles(folderEvent, folderId, oldFolderKey, newFolderKey) {
  const files = await fetchFilesInFolder(folderEvent.pubkey, folderId);

  for (const fileEvent of files) {
    const wrappedFDK = getTagValue(fileEvent, "wrapped_fdk");
    if (!wrappedFDK) continue;

    const fileDataKey = await unwrapKey(wrappedFDK, oldFolderKey);
    const nextWrappedFDK = await wrapKey(fileDataKey, newFolderKey);

    await publishFileMetadata({
      ...extractMetadataPayload(fileEvent),
      createdAt: (fileEvent.created_at || 0) + 1,
      fileVersion: getEventVersion(fileEvent) + 1,
      wrappedFDK: nextWrappedFDK,
      folderId,
    });
  }
}

async function rotateFolderKeyForRecipients(folderId, ownerPubkey, oldFolderKey, recipients) {
  const folderEvent = await fetchFolder(ownerPubkey, folderId);
  if (!folderEvent) {
    throw new Error("Folder event not found");
  }

  const newFolderKey = await generateKey();
  await rewrapFolderFiles(folderEvent, folderId, oldFolderKey, newFolderKey);
  await publishSharesForRecipients(folderId, ownerPubkey, newFolderKey, recipients);
}

export async function rotateFolderKey(folderId, ownerPubkey = null) {
  const context = await resolveFolderAccessKey(folderId, ownerPubkey);
  mustBeOwner(context);
  const recipients = await listRecipients(folderId, context.ownerPubkey);
  await rotateFolderKeyForRecipients(folderId, context.ownerPubkey, context.folderKey, recipients);
}

export async function revokeAccess(folderId, recipientPubkey, ownerPubkey = null) {
  const context = await resolveFolderAccessKey(folderId, ownerPubkey);
  mustBeOwner(context);

  const revokedRecipient = normalizePubkey(recipientPubkey);
  const shareEvent = await getShareEvent(folderId, revokedRecipient, context.ownerPubkey);
  if (shareEvent?.id) {
    await publishDeletion(shareEvent.id, "access revoked");
  }

  const recipients = (await listRecipients(folderId, context.ownerPubkey))
    .filter((recipient) => recipient !== revokedRecipient);
  if (!recipients.includes(context.ownerPubkey)) {
    recipients.push(context.ownerPubkey);
  }

  await rotateFolderKeyForRecipients(folderId, context.ownerPubkey, context.folderKey, recipients);
}

export async function shareFolder(folderId, recipientPubkey, ownerPubkey = null) {
  return grantAccess(folderId, recipientPubkey, ownerPubkey);
}

export async function revokeUser(folderId, recipientPubkey, ownerPubkey = null) {
  return revokeAccess(folderId, recipientPubkey, ownerPubkey);
}

export async function getFolderAccessState(folderId, ownerPubkey = null) {
  const context = await resolveFolderContext(folderId, ownerPubkey);
  const recipients = await listRecipients(folderId, context.ownerPubkey);

  return {
    ownerPubkey: context.folderEvent.pubkey,
    folderName: getTagValue(context.folderEvent, "name") || folderId,
    recipients,
  };
}
