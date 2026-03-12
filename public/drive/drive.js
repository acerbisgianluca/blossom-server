/**
 * High-level encrypted drive API
 * Orchestrates encryption, upload, and Nostr publishing
 */

import {
  encryptFile,
  decryptFile,
  keyToHex,
  hexToKey,
} from "./encryption.js";
import { uploadBlob, downloadBlob } from "./blossom.js";
import {
  publishFolderEvent,
  publishFileMetadata,
  publishShareEvent,
  fetchFilesForUser,
  fetchSharesForUser,
  fetchFolder,
  fetchFileMetadataByHash,
  encryptNIP44,
  decryptNIP44,
} from "./nostr.js";

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
  let key;

  // Read file
  onProgress("reading-file");
  const fileBuffer = await file.arrayBuffer();

  // Encrypt
  onProgress("encrypting");
  const { key: encKey, encrypted } = await encryptFile(fileBuffer);
  key = encKey;

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
    encryptedSize: encrypted.byteLength,
    fileName: file.name,
    folderId,
  });

  // Publish owner self-share (always, for stateless key recovery)
  onProgress("publishing-owner-share");
  const keyHex = keyToHex(key);
  const encryptedKey = await encryptNIP44(keyHex, pubkey);
  await publishShareEvent({
    blobHash: blob.sha256,
    recipientPubkey: pubkey,
    encryptedFileKey: encryptedKey,
  });

  // Publish shares for recipients
  if (recipients.length > 0) {
    onProgress("publishing-recipient-shares");
    for (const recipientPubkey of recipients) {
      const encKey = await encryptNIP44(keyHex, recipientPubkey);
      await publishShareEvent({
        blobHash: blob.sha256,
        recipientPubkey,
        encryptedFileKey: encKey,
      });
    }
  }

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
  const metadataEvent = await fetchFileMetadataByHash(blobHash);
  if (!metadataEvent) {
    throw new Error("No metadata event found for this blob hash");
  }

  const encTag = metadataEvent.tags.find((t) => t[0] === "enc");
  if (!encTag || encTag[1] !== "aes-256-gcm") {
    throw new Error("Unsupported or missing file encryption metadata");
  }

  const mimeType = metadataEvent.tags.find((t) => t[0] === "m")?.[1] || "application/octet-stream";
  const fileName = metadataEvent.tags.find((t) => t[0] === "name")?.[1] || `decrypted-${blobHash.slice(0, 12)}`;

  // Fetch share event for current user
  onProgress("fetching-share-event");
  const shares = await fetchSharesForUser(pubkey, blobHash);

  if (shares.length === 0) {
    throw new Error("No share event found for this blob");
  }

  // Prefer newest share event for this recipient/hash.
  shares.sort((a, b) => b.created_at - a.created_at);
  const shareEvent = shares[0];
  const encryptedKeyTag = shareEvent.tags.find((t) => t[0] === "key");
  if (!encryptedKeyTag) {
    throw new Error("Share event missing 'key' tag");
  }

  // Decrypt file key from share
  onProgress("decrypting-key");
  const senderPubkey = shareEvent.pubkey;
  const decryptedKeyHex = await decryptNIP44(encryptedKeyTag[1], senderPubkey);
  const key = hexToKey(decryptedKeyHex);

  // Download encrypted blob
  onProgress("downloading-blob");
  const encryptedBlob = await downloadBlob(blobHash);

  // Decrypt blob
  onProgress("decrypting-blob");
  const plaintext = await decryptFile(encryptedBlob, key);

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
  const pubkey = await window.nostr.getPublicKey();

  // Fetch owner's self-share to recover key
  onProgress("fetching-owner-share");
  const shares = await fetchSharesForUser(pubkey, blobHash);

  const ownerShare = shares.find((s) => s.pubkey === pubkey);
  if (!ownerShare) {
    throw new Error("Cannot re-share: owner share event not found");
  }

  const keyTag = ownerShare.tags.find((t) => t[0] === "key");
  if (!keyTag) {
    throw new Error("Owner share event missing key");
  }

  // Decrypt key from owner share
  onProgress("decrypting-owner-key");
  const decryptedKeyHex = await decryptNIP44(keyTag[1], pubkey);

  // Encrypt for recipient
  onProgress("encrypting-for-recipient");
  const encryptedKey = await encryptNIP44(decryptedKeyHex, recipientPubkey);

  // Publish share event
  onProgress("publishing-share");
  await publishShareEvent({
    blobHash,
    recipientPubkey,
    encryptedFileKey: encryptedKey,
  });

  onProgress("complete");
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
