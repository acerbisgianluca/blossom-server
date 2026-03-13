/**
 * High-level folder-centric encrypted drive API.
 */

import {
  decryptFile,
  encryptFile,
  generateKey,
  unwrapKey,
  wrapKey,
} from "./encryption.js";
import { downloadBlob, uploadBlob } from "./blossom.js";
import { getBlossomUrl } from "./config.js";
import { newExpirationValue, unixNow } from "../utils.js";
import { deleteFile as deleteFileRecord, deleteFolder as deleteFolderRecord } from "./deletion.js";
import {
  fetchFilesInFolder,
  fetchFolder,
  fetchPaidFolders,
  getFolderIdFromRef,
  fetchLatestMetadata,
  publishFileMetadata,
  fetchSharedFoldersForRecipient,
  fetchUserFolders,
  getTagValue,
} from "./nostr.js";
import { startZapReceiptListener, unlockFolderWithZap } from "./payments.js";
import {
  createFolder as createFolderRecord,
  grantAccess,
  getFolderKey,
  listRecipients as listFolderRecipients,
  revokeAccess,
  rotateFolderKey as rotateFolderAccessKey,
} from "./folders.js";

function normalizePubkey(pubkey) {
  const value = (pubkey || "").trim();
  if (!value) return "";

  if (value.startsWith("npub")) {
    const decoded = window.NostrTools?.nip19?.decode?.(value);
    if (!decoded || decoded.type !== "npub" || !decoded.data) {
      throw new Error("Invalid npub public key");
    }
    return String(decoded.data).toLowerCase();
  }

  return value.toLowerCase();
}

function parseFolderAddress(address) {
  const parts = (address || "").split(":");
  if (parts.length !== 3) return null;
  if (parts[0] !== "30000") return null;
  return {
    ownerPubkey: parts[1],
    folderId: parts[2],
  };
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

function titleCase(value) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function buildAutoFolderName(files) {
  const isoDate = new Date().toISOString().slice(0, 10);
  const firstName = files?.[0]?.name || "Batch";
  const stem = firstName.replace(/\.[^.]+$/, "");
  const normalized = stem.replace(/[0-9]+/g, " ").replace(/[_-]+/g, " ").trim();
  const prefix = normalized ? titleCase(normalized) : "Folder";
  return `${prefix} Upload ${isoDate}`;
}

function mapFileEvent(event) {
  return {
    blobHash: getTagValue(event, "x"),
    blobUrl: getTagValue(event, "url"),
    fileName: getTagValue(event, "name") || `file-${(getTagValue(event, "x") || "blob").slice(0, 10)}`,
    mimeType: getTagValue(event, "m") || "application/octet-stream",
    size: Number.parseInt(getTagValue(event, "size") || "0", 10),
    folderId: getFolderIdFromRef(getTagValue(event, "folder")),
    uploadedAt: event.created_at,
    uploader: event.pubkey,
  };
}

function isPaidFolder(folderEvent) {
  const price = Number.parseInt(getTagValue(folderEvent, "price") || "0", 10);
  return Number.isFinite(price) && price > 0;
}

async function enrichFolderEvent(folderEvent) {
  const folderId = getTagValue(folderEvent, "d");
  const files = await fetchFilesInFolder(folderEvent.pubkey, folderId);
  return {
    folderId,
    folderName: getTagValue(folderEvent, "name") || folderId,
    ownerPubkey: folderEvent.pubkey,
    createdAt: folderEvent.created_at,
    priceMsats: Number.parseInt(getTagValue(folderEvent, "price") || "0", 10) || null,
    zapTarget: getTagValue(folderEvent, "zap") || null,
    fileCount: files.length,
  };
}

async function getUploadsFromBlossom() {
  const pubkey = await window.nostr.getPublicKey();
  const authHeader = await getListAuthHeader(pubkey);
  const response = await fetch(`${getBlossomUrl()}/list/${pubkey}`, {
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

export async function createFolder(name, recipients = [], options = {}) {
  return createFolderRecord(name, recipients, options);
}

export async function uploadFiles(folderId, files, options = {}, onProgress = () => {}) {
  const fileList = Array.from(files || []);
  if (fileList.length === 0) {
    throw new Error("No files selected");
  }

  let targetFolderId = folderId;
  let targetFolderName = options.folderName || "";
  let folderKey = null;
  const ownerPubkey = await window.nostr.getPublicKey();

  if (!targetFolderId) {
    const createdFolder = await createFolderRecord(
      targetFolderName || buildAutoFolderName(fileList),
      options.recipients || [],
    );
    targetFolderId = createdFolder.folderId;
    targetFolderName = createdFolder.folderName;
    folderKey = createdFolder.folderKey;
  } else {
    const folderEvent = await fetchFolder(ownerPubkey, targetFolderId);
    targetFolderName = (folderEvent && getTagValue(folderEvent, "name")) || targetFolderName || targetFolderId;
  }

  if (!folderKey) {
    folderKey = await getFolderKey(targetFolderId, ownerPubkey);
  }

  const results = await Promise.all(
    fileList.map(async (file, index) => {
      onProgress({ index, fileName: file.name, stage: "reading-file" });
      const fileBuffer = await file.arrayBuffer();

      onProgress({ index, fileName: file.name, stage: "encrypting" });
      const fileKey = await generateKey();
      const encrypted = await encryptFile(fileBuffer, fileKey);
      const wrappedFDK = await wrapKey(fileKey, folderKey);

      onProgress({ index, fileName: file.name, stage: "uploading" });
      const blob = await uploadBlob(encrypted, file.type || "application/octet-stream");

      onProgress({ index, fileName: file.name, stage: "publishing-metadata" });
      await publishFileMetadata({
        blobHash: blob.sha256,
        blobUrl: blob.url,
        fileVersion: 1,
        mimeType: file.type || "application/octet-stream",
        fileSize: fileBuffer.byteLength,
        folderId: targetFolderId,
        fileName: file.name,
        wrappedFDK,
      });

      onProgress({ index, fileName: file.name, stage: "complete", blobHash: blob.sha256 });

      return {
        blobHash: blob.sha256,
        blobUrl: blob.url,
        fileName: file.name,
      };
    }),
  );

  return {
    folderId: targetFolderId,
    folderName: targetFolderName,
    files: results,
  };
}

export async function downloadFile(blobHash, onProgress = () => {}) {
  onProgress("fetching-metadata-event");
  const metadataEvent = await fetchLatestMetadata(blobHash);
  if (!metadataEvent) {
    throw new Error("No metadata event found for this blob hash");
  }

  const wrappedFDK = getTagValue(metadataEvent, "wrapped_fdk");
  const folderId = getFolderIdFromRef(getTagValue(metadataEvent, "folder"));
  if (!wrappedFDK || !folderId) {
    throw new Error("Metadata missing folder or wrapped_fdk tag");
  }

  onProgress("fetching-folder-key");
  const folderKey = await getFolderKey(folderId, metadataEvent.pubkey);
  const fileKey = await unwrapKey(wrappedFDK, folderKey);

  onProgress("downloading-blob");
  const encryptedBlob = await downloadBlob(blobHash);

  onProgress("decrypting-blob");
  const plaintext = await decryptFile(encryptedBlob, fileKey);
  const mimeType = getTagValue(metadataEvent, "m") || "application/octet-stream";
  const fileName = getTagValue(metadataEvent, "name") || `decrypted-${blobHash.slice(0, 12)}`;

  return {
    blob: new Blob([plaintext], { type: mimeType }),
    fileName,
    mimeType,
  };
}

export async function shareFolder(folderId, pubkey, ownerPubkey = null) {
  return grantAccess(folderId, pubkey, ownerPubkey);
}

export async function revokeUser(folderId, pubkey, ownerPubkey = null) {
  return revokeAccess(folderId, pubkey, ownerPubkey);
}

export async function revokeFolderAccess(folderId, pubkey, ownerPubkey = null) {
  return revokeAccess(folderId, pubkey, ownerPubkey);
}

export async function rotateFolderKey(folderId, ownerPubkey = null) {
  return rotateFolderAccessKey(folderId, ownerPubkey);
}

export async function listFolders() {
  const folderEvents = await fetchUserFolders(await window.nostr.getPublicKey());
  const folders = await Promise.all(folderEvents.map((event) => enrichFolderEvent(event)));
  return folders.sort((a, b) => b.createdAt - a.createdAt);
}

export async function listFiles(folderId, ownerPubkey = null) {
  const effectiveOwner = ownerPubkey || await window.nostr.getPublicKey();
  const fileEvents = await fetchFilesInFolder(effectiveOwner, folderId);
  return fileEvents.map((event) => mapFileEvent(event));
}

export async function listSharedWithMe() {
  const myPubkey = normalizePubkey(await window.nostr.getPublicKey());
  const shareEvents = await fetchSharedFoldersForRecipient(myPubkey);

  const folders = await Promise.allSettled(
    shareEvents
      .map(async (shareEvent) => {
        const folderAddress = getTagValue(shareEvent, "a");
        const parsedAddress = parseFolderAddress(folderAddress);
        const folderId = parsedAddress?.folderId || getTagValue(shareEvent, "folder") || getTagValue(shareEvent, "d");
        const ownerPubkey = normalizePubkey(parsedAddress?.ownerPubkey || shareEvent.pubkey);

        // Ignore self-owned folders in "shared with me".
        if (ownerPubkey === myPubkey) {
          return null;
        }

        const folderEvent = await fetchFolder(ownerPubkey, folderId);
        const files = await fetchFilesInFolder(ownerPubkey, folderId);

        return {
          folderId,
          folderName: (folderEvent && getTagValue(folderEvent, "name")) || folderId,
          ownerPubkey,
          sharedAt: shareEvent.created_at,
          priceMsats: Number.parseInt(getTagValue(folderEvent || shareEvent, "price") || "0", 10) || null,
          zapTarget: getTagValue(folderEvent || shareEvent, "zap") || null,
          fileCount: files.length,
        };
      }),
  );

  return folders
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .filter(Boolean)
    .sort((a, b) => b.sharedAt - a.sharedAt);
}

export async function getFolderRecipients(folderId, ownerPubkey = null) {
  return listFolderRecipients(folderId, ownerPubkey);
}

export async function listRecipients(folderId, ownerPubkey = null) {
  return listFolderRecipients(folderId, ownerPubkey);
}

export async function listSharedFolders() {
  return listSharedWithMe();
}

export async function listLockedFolders() {
  const myPubkey = normalizePubkey(await window.nostr.getPublicKey());
  const [paidFolderEvents, sharedFolders] = await Promise.all([
    fetchPaidFolders(),
    listSharedWithMe(),
  ]);

  const sharedSet = new Set(sharedFolders.map((folder) => `${normalizePubkey(folder.ownerPubkey)}:${folder.folderId}`));

  const locked = [];
  for (const folderEvent of paidFolderEvents) {
    if (!isPaidFolder(folderEvent)) continue;

    const folderId = getTagValue(folderEvent, "d");
    const ownerPubkey = normalizePubkey(folderEvent.pubkey);
    if (!folderId || !ownerPubkey) continue;
    if (ownerPubkey === myPubkey) continue;

    const shareKey = `${ownerPubkey}:${folderId}`;
    if (sharedSet.has(shareKey)) continue;

    locked.push({
      folderId,
      folderName: getTagValue(folderEvent, "name") || folderId,
      ownerPubkey,
      createdAt: folderEvent.created_at,
      fileCount: 0,
      priceMsats: Number.parseInt(getTagValue(folderEvent, "price") || "0", 10) || null,
      zapTarget: getTagValue(folderEvent, "zap") || null,
      locked: true,
      source: "locked",
    });
  }

  return locked.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function unlockFolder(folderId, ownerPubkey) {
  return unlockFolderWithZap(folderId, ownerPubkey);
}

export function startFolderPaymentListener(ownerPubkey, handlers = {}) {
  return startZapReceiptListener(ownerPubkey, handlers);
}

export async function listRawUploads() {
  return getUploadsFromBlossom();
}

export async function deleteFile(blobHash) {
  return deleteFileRecord(blobHash);
}

export async function deleteFolder(folderId) {
  return deleteFolderRecord(folderId);
}
