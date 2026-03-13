/**
 * Deletion workflow for encrypted drive items.
 */

import { deleteBlob } from "./blossom.js";
import {
  fetchFileMetadata,
  fetchFolder,
  fetchFolderFiles,
  fetchFolderShareEvents,
  getFolderIdFromRef,
  getTagValue,
  publishDeletionEvent,
} from "./nostr.js";

function normalizePubkey(pubkey) {
  if (pubkey?.startsWith("npub")) {
    const decoded = window.NostrTools?.nip19?.decode?.(pubkey);
    if (decoded?.type === "npub" && decoded.data) {
      return decoded.data;
    }
  }

  return pubkey;
}

function isOwner(event, pubkey) {
  return !!event && event.pubkey === pubkey;
}

function eventHasTag(event, tagName, value) {
  return event.tags?.some((tag) => tag[0] === tagName && tag[1] === value) || false;
}

export async function publishDeletion(eventId, reason = "") {
  return publishDeletionEvent(eventId, reason);
}

export async function deleteBlobFromBlossom(hash) {
  if (!hash) return false;
  return deleteBlob(hash);
}

export async function deleteFile(blobHash) {
  if (!blobHash) {
    throw new Error("Missing blob hash for deletion");
  }

  const metadataEvent = await fetchFileMetadata(blobHash);
  if (!metadataEvent) {
    throw new Error("File metadata event not found");
  }

  const myPubkey = normalizePubkey(await window.nostr.getPublicKey());
  if (!isOwner(metadataEvent, myPubkey)) {
    return { deleted: false, reason: "not-owner" };
  }

  const folderRef = getTagValue(metadataEvent, "a") || getTagValue(metadataEvent, "folder");
  const folderId = getFolderIdFromRef(folderRef);
  const fileId = getTagValue(metadataEvent, "file_id");
  const relatedShares = folderId
    ? (await fetchFolderShareEvents(folderId, myPubkey)).filter((event) =>
        eventHasTag(event, "x", blobHash) || (fileId && eventHasTag(event, "file_id", fileId)),
      )
    : [];

  await publishDeletion(metadataEvent.id, "file deleted");
  for (const shareEvent of relatedShares) {
    if (!isOwner(shareEvent, myPubkey)) continue;
    await publishDeletion(shareEvent.id, "file share deleted");
  }

  try {
    const deleted = await deleteBlobFromBlossom(blobHash);
    if (!deleted) {
      console.warn(`Failed to delete blob ${blobHash} from Blossom`);
    }
  } catch (error) {
    console.warn(`Failed to delete blob ${blobHash} from Blossom:`, error);
  }

  return { deleted: true };
}

export async function deleteFolder(folderId) {
  if (!folderId) {
    throw new Error("Missing folder id for deletion");
  }

  const myPubkey = normalizePubkey(await window.nostr.getPublicKey());
  const folderEvent = await fetchFolder(myPubkey, folderId);
  if (!folderEvent) {
    throw new Error("Folder event not found");
  }

  if (!isOwner(folderEvent, myPubkey)) {
    return { deleted: false, reason: "not-owner" };
  }

  const files = await fetchFolderFiles(folderId, myPubkey);
  for (const fileEvent of files) {
    const blobHash = getTagValue(fileEvent, "x");
    if (!blobHash) continue;
    await deleteFile(blobHash);
  }

  const shareEvents = await fetchFolderShareEvents(folderId, myPubkey);
  for (const shareEvent of shareEvents) {
    if (!isOwner(shareEvent, myPubkey)) continue;
    await publishDeletion(shareEvent.id, "folder share deleted");
  }

  await publishDeletion(folderEvent.id, "folder deleted");

  return { deleted: true };
}
