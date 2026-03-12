/**
 * High-level encrypted drive API
 * Orchestrates encryption, upload, and Nostr publishing
 */

import {
  generateKey,
  encryptFile,
  decryptFile,
  hexToKey,
  keyToHex,
  wrapKey,
  unwrapKey,
  rotateAccessKey as rotateWrappedAccessKey,
} from "./encryption.js";
import { uploadBlob, downloadBlob } from "./blossom.js";
import { getBlossomUrl } from "./config.js";
import { newExpirationValue, unixNow } from "../utils.js";
import {
  publishFolderEvent,
  publishFileMetadata,
  publishShareEvent,
  fetchFilesForUser,
  fetchSharesForUser,
  fetchLatestShareEvent,
  fetchFolder,
  fetchLatestMetadata,
  getTagValue,
  getAllTagValues,
  getAccessKeyForRecipient,
  encryptNIP44,
  decryptNIP44,
} from "./nostr.js";

function uniquePubkeys(pubkeys = []) {
  const clean = pubkeys.map((p) => p?.trim()).filter(Boolean);
  return [...new Set(clean)];
}

function base64UrlEncode(data) {
  return btoa(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function getListAuthHeader(pubkey) {
  const auth = await window.nostr.signEvent({
    kind: 24242,
    content: "Authorize List",
    created_at: unixNow(),
    tags: [
      ["t", "list"],
      ["expiration", newExpirationValue()],
      ["pubkey", pubkey],
    ],
  });
  return `Nostr ${base64UrlEncode(JSON.stringify(auth))}`;
}

async function buildRecipientAccessEntries(fak, recipients) {
  const entries = [];
  for (const recipient of recipients) {
    const encryptedFAK = await encryptNIP44(keyToHex(fak), recipient);
    entries.push({ pubkey: recipient, encryptedFAK });
  }
  return entries;
}

function extractMetadataPayload(metadataEvent) {
  return {
    blobHash: getTagValue(metadataEvent, "x"),
    blobUrl: getTagValue(metadataEvent, "url"),
    mimeType: getTagValue(metadataEvent, "m") || "application/octet-stream",
    fileSize: Number.parseInt(getTagValue(metadataEvent, "size") || "0", 10),
    fileName: getTagValue(metadataEvent, "name") || undefined,
    folderId: getTagValue(metadataEvent, "folder") || undefined,
  };
}

async function resolveCurrentKeyMaterial(blobHash) {
  const myPubkey = await window.nostr.getPublicKey();
  const metadataEvent = await fetchLatestMetadata(blobHash);
  if (!metadataEvent) {
    throw new Error("No metadata event found for this blob hash");
  }

  const wrappedFDK = getTagValue(metadataEvent, "wrapped_key");
  if (!wrappedFDK) {
    throw new Error("Metadata missing wrapped_key tag");
  }

  const shareEvent = await fetchLatestShareEvent(blobHash, metadataEvent.pubkey);
  if (!shareEvent) {
    throw new Error("No share event found for this blob hash");
  }

  const encryptedFAK = getAccessKeyForRecipient(shareEvent, myPubkey);
  if (!encryptedFAK) {
    throw new Error("Current user has no access key entry for this file");
  }

  const fakHex = await decryptNIP44(encryptedFAK, shareEvent.pubkey);
  const fak = hexToKey(fakHex);
  const fdk = await unwrapKey(wrappedFDK, fak);

  return {
    myPubkey,
    fdk,
    fak,
    metadataEvent,
    shareEvent,
  };
}

/**
 * Upload a file to encrypted drive
 * @param {File} file - Browser File object
 * @param {string} folderId - Folder ID (optional)
 * @param {string[]} recipients - Recipient pubkeys to share with (optional, defaults to owner only)
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{blobHash: string, blobUrl: string}>}
 */
export async function uploadFile(file, folderId = null, recipients = [], onProgress = () => {}) {
  const pubkey = await window.nostr.getPublicKey();
  const allowlist = uniquePubkeys([pubkey, ...recipients]);

  // Read file
  onProgress("reading-file");
  const fileBuffer = await file.arrayBuffer();

  // Generate FDK/FAK and encrypt file payload
  onProgress("encrypting");
  const fdk = await generateKey();
  const fak = await generateKey();
  const encrypted = await encryptFile(fileBuffer, fdk);
  const wrappedFDK = await wrapKey(fdk, fak);

  // Upload blob
  onProgress("uploading");
  const blob = await uploadBlob(encrypted, file.type || "application/octet-stream");

  // Publish metadata event
  onProgress("publishing-metadata");
  await publishFileMetadata({
    blobHash: blob.sha256,
    blobUrl: blob.url,
    mimeType: file.type || "application/octet-stream",
    fileSize: fileBuffer.byteLength,
    fileName: file.name,
    folderId,
    wrappedFDK,
  });

  // Publish one share event with allowlisted recipients and per-recipient encrypted FAK.
  onProgress("publishing-share-event");
  const recipientEntries = await buildRecipientAccessEntries(fak, allowlist);
  await publishShareEvent({ blobHash: blob.sha256, recipients: recipientEntries });

  onProgress("complete");
  return {
    blobHash: blob.sha256,
    blobUrl: blob.url,
  };
}

/**
 * Download and decrypt a file
 * @param {string} blobHash - SHA256 hash of encrypted blob
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{blob: Blob, fileName: string, mimeType: string}>} Decrypted payload for local download
 */
export async function downloadFile(blobHash, onProgress = () => {}) {
  const pubkey = await window.nostr.getPublicKey();

  // Resolve metadata first so we can recover original filename/type.
  onProgress("fetching-metadata-event");
  const metadataEvent = await fetchLatestMetadata(blobHash);
  if (!metadataEvent) {
    throw new Error("No metadata event found for this blob hash");
  }

  const encTag = metadataEvent.tags.find((t) => t[0] === "enc");
  if (!encTag || encTag[1] !== "aes-256-gcm") {
    throw new Error("Unsupported or missing file encryption metadata");
  }

  const mimeType = metadataEvent.tags.find((t) => t[0] === "m")?.[1] || "application/octet-stream";
  const fileName = metadataEvent.tags.find((t) => t[0] === "name")?.[1] || `decrypted-${blobHash.slice(0, 12)}`;

  const wrappedFDK = getTagValue(metadataEvent, "wrapped_key");
  if (!wrappedFDK) {
    throw new Error("Metadata event missing wrapped_key tag");
  }

  // Fetch share event for current user
  onProgress("fetching-share-event");
  const shares = await fetchSharesForUser(pubkey, blobHash);
  const ownerShares = shares.filter((event) => event.pubkey === metadataEvent.pubkey);
  const candidateShares = ownerShares.length > 0 ? ownerShares : shares;
  candidateShares.sort((a, b) => b.created_at - a.created_at);
  const shareEvent = candidateShares[0];
  if (!shareEvent) throw new Error("No share event found for this blob");

  // Decrypt FAK from share, then unwrap FDK from metadata.
  onProgress("decrypting-key");
  const encryptedFAK = getAccessKeyForRecipient(shareEvent, pubkey);
  if (!encryptedFAK) {
    throw new Error("Share event missing access key for this user");
  }
  const fakHex = await decryptNIP44(encryptedFAK, shareEvent.pubkey);
  const fak = hexToKey(fakHex);
  const fdk = await unwrapKey(wrappedFDK, fak);

  // Download encrypted blob
  onProgress("downloading-blob");
  const encryptedBlob = await downloadBlob(blobHash);

  // Decrypt blob
  onProgress("decrypting-blob");
  const plaintext = await decryptFile(encryptedBlob, fdk);

  const blob = new Blob([plaintext], { type: mimeType });
  return { blob, fileName, mimeType };
}

/**
 * Share a file with a recipient
 * Requires owner to recover file key from their self-share event
 * @param {string} blobHash - SHA256 hash of blob
 * @param {string} recipientPubkey - Recipient pubkey
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<void>}
 */
export async function shareFile(blobHash, recipientPubkey, onProgress = () => {}) {
  onProgress("resolving-current-access");
  const { myPubkey, fak, shareEvent } = await resolveCurrentKeyMaterial(blobHash);

  const existingRecipients = getAllTagValues(shareEvent, "p");
  const recipients = uniquePubkeys([myPubkey, ...existingRecipients, recipientPubkey]);

  onProgress("publishing-share");
  const recipientEntries = await buildRecipientAccessEntries(fak, recipients);
  await publishShareEvent({ blobHash, recipients: recipientEntries });

  onProgress("complete");
}

/**
 * Rotate FAK for a file while keeping recipient set unchanged.
 * @param {string} blobHash - SHA256 hash of blob
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<void>}
 */
export async function rotateAccessKey(blobHash, onProgress = () => {}) {
  onProgress("resolving-current-access");
  const { myPubkey, fdk, metadataEvent, shareEvent } = await resolveCurrentKeyMaterial(blobHash);

  const recipients = uniquePubkeys([myPubkey, ...getAllTagValues(shareEvent, "p")]);
  const { fak: newFAK, wrappedFDK } = await rotateWrappedAccessKey(fdk);

  onProgress("publishing-rotated-metadata");
  await publishFileMetadata({
    ...extractMetadataPayload(metadataEvent),
    wrappedFDK,
  });

  onProgress("publishing-share");
  const recipientEntries = await buildRecipientAccessEntries(newFAK, recipients);
  await publishShareEvent({ blobHash, recipients: recipientEntries });

  onProgress("complete");
}

/**
 * Revoke a user by rotating FAK, rewrapping FDK, and republishing allowlist.
 * @param {string} blobHash - SHA256 hash of blob
 * @param {string} revokedPubkey - Pubkey to remove
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<void>}
 */
export async function revokeUser(blobHash, revokedPubkey, onProgress = () => {}) {
  onProgress("resolving-current-access");
  const { myPubkey, fdk, metadataEvent, shareEvent } = await resolveCurrentKeyMaterial(blobHash);

  const recipients = uniquePubkeys([
    myPubkey,
    ...getAllTagValues(shareEvent, "p").filter((p) => p !== revokedPubkey),
  ]);

  const { fak: newFAK, wrappedFDK } = await rotateWrappedAccessKey(fdk);

  onProgress("publishing-rotated-metadata");
  await publishFileMetadata({
    ...extractMetadataPayload(metadataEvent),
    wrappedFDK,
  });

  onProgress("publishing-share");
  const recipientEntries = await buildRecipientAccessEntries(newFAK, recipients);
  await publishShareEvent({ blobHash, recipients: recipientEntries });

  onProgress("complete");
}

/**
 * Replace file allowlist and optionally rotate FAK.
 * @param {string} blobHash - SHA256 hash of blob
 * @param {string[]} recipients - Desired recipient pubkeys
 * @param {{rotate?: boolean}} options - Rotation settings
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<void>}
 */
export async function updateFileRecipients(blobHash, recipients, options = {}, onProgress = () => {}) {
  const { rotate = true } = options;
  onProgress("resolving-current-access");

  const { myPubkey, fdk, fak, metadataEvent } = await resolveCurrentKeyMaterial(blobHash);
  const finalRecipients = uniquePubkeys([myPubkey, ...(recipients || [])]);

  let nextFAK = fak;
  let wrappedFDK = getTagValue(metadataEvent, "wrapped_key");

  if (rotate) {
    const rotated = await rotateWrappedAccessKey(fdk);
    nextFAK = rotated.fak;
    wrappedFDK = rotated.wrappedFDK;

    onProgress("publishing-rotated-metadata");
    await publishFileMetadata({
      ...extractMetadataPayload(metadataEvent),
      wrappedFDK,
    });
  }

  onProgress("publishing-share");
  const recipientEntries = await buildRecipientAccessEntries(nextFAK, finalRecipients);
  await publishShareEvent({ blobHash, recipients: recipientEntries });

  onProgress("complete");
}

/**
 * List current user's uploaded blobs from Blossom /list/:pubkey endpoint.
 * @returns {Promise<Array>} List of blob descriptors
 */
export async function listMyUploads() {
  const pubkey = await window.nostr.getPublicKey();
  const authHeader = await getListAuthHeader(pubkey);
  const baseUrl = getBlossomUrl();

  const response = await fetch(`${baseUrl}/list/${pubkey}`, {
    method: "GET",
    headers: {
      authorization: authHeader,
    },
  });

  if (!response.ok) {
    throw new Error(`Unable to list uploads: ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch current access state for an uploaded file.
 * @param {string} blobHash - SHA256 hash of blob
 * @returns {Promise<{ownerPubkey: string, recipients: string[]}>}
 */
export async function getFileAccessState(blobHash) {
  const metadataEvent = await fetchLatestMetadata(blobHash);
  if (!metadataEvent) {
    return { ownerPubkey: "", recipients: [] };
  }

  let shareEvent = await fetchLatestShareEvent(blobHash, metadataEvent.pubkey);

  // Fallback: query owner's recipient-scoped events and filter by file hash.
  if (!shareEvent) {
    const ownerShares = await fetchSharesForUser(metadataEvent.pubkey, blobHash);
    const authoredShares = ownerShares.filter((event) => event.pubkey === metadataEvent.pubkey);
    authoredShares.sort((a, b) => b.created_at - a.created_at);
    shareEvent = authoredShares[0] || null;
  }

  if (!shareEvent) {
    return { ownerPubkey: metadataEvent.pubkey, recipients: [metadataEvent.pubkey] };
  }

  const recipients = uniquePubkeys(getAllTagValues(shareEvent, "p"));
  return {
    ownerPubkey: metadataEvent.pubkey,
    recipients,
  };
}

/**
 * Create a folder
 * @param {string} folderId - Unique folder ID
 * @param {string} folderName - Human-readable name
 * @returns {Promise<void>}
 */
export async function createFolder(folderId, folderName) {
  await publishFolderEvent(folderId, folderName);
}

/**
 * List files in a folder
 * @param {string} ownerPubkey - Folder owner pubkey
 * @param {string} folderId - Folder ID
 * @returns {Promise<Array>} File metadata events
 */
export async function listFolder(ownerPubkey, folderId) {
  return fetchFilesForUser(ownerPubkey, folderId);
}

/**
 * Get folder details
 * @param {string} ownerPubkey - Folder owner pubkey
 * @param {string} folderId - Folder ID
 * @returns {Promise<Object|null>} Folder event or null
 */
export async function getFolder(ownerPubkey, folderId) {
  return fetchFolder(ownerPubkey, folderId);
}
