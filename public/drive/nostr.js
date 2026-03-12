/**
 * Nostr event module for folder-based encrypted sharing.
 */

import { RELAYS, EVENT_KINDS } from "./config.js";
import { unixNow } from "../utils.js";

let pool = null;
let lastPublishedCreatedAt = 0;

function nextCreatedAt(proposedCreatedAt = unixNow()) {
  const nextValue = Math.max(proposedCreatedAt, lastPublishedCreatedAt + 1);
  lastPublishedCreatedAt = nextValue;
  return nextValue;
}

function getEventVersion(event) {
  const rawVersion = getTagValue(event, "version");
  const parsedVersion = Number.parseInt(rawVersion || "0", 10);
  return Number.isFinite(parsedVersion) ? parsedVersion : 0;
}

function compareEventsNewestFirst(left, right) {
  const leftVersion = getEventVersion(left);
  const rightVersion = getEventVersion(right);
  if (leftVersion !== rightVersion) {
    return rightVersion - leftVersion;
  }

  if (left.created_at !== right.created_at) {
    return right.created_at - left.created_at;
  }

  return (right.id || "").localeCompare(left.id || "");
}

function isEventNewer(candidate, existing) {
  if (!existing) return true;
  return compareEventsNewestFirst(candidate, existing) < 0;
}

function getFileEventIdentity(event, folderId) {
  const explicitId = getTagValue(event, "file_id");
  if (explicitId) {
    return `file_id:${explicitId}`;
  }

  return [
    getTagValue(event, "x") || "",
    getTagValue(event, "url") || "",
    getTagValue(event, "name") || "",
    getTagValue(event, "size") || "",
    getTagValue(event, "m") || "",
    folderId || "",
  ].join("|");
}

function createFileId() {
  if (typeof window.crypto?.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function initRelayPool() {
  if (pool) return pool;

  const { SimplePool } = window.NostrTools;
  if (!SimplePool) {
    throw new Error("nostr-tools not loaded. Please refresh the page.");
  }

  pool = new SimplePool();
  return pool;
}

export async function publishEvent(unsigned) {
  const event = await window.nostr.signEvent({
    ...unsigned,
    created_at: nextCreatedAt(unsigned.created_at),
  });
  const relayPool = initRelayPool();
  const publishPromises = relayPool.publish(RELAYS, event);
  const settled = await Promise.allSettled(publishPromises);
  const acceptedRelays = settled
    .map((result, index) => (result.status === "fulfilled" ? RELAYS[index] : null))
    .filter(Boolean);

  if (acceptedRelays.length === 0) {
    throw new Error("Failed to publish event to any relay");
  }

  return { id: event.id, acceptedRelays };
}

export async function fetchEvents(filter, timeoutMs = 5000) {
  const relayPool = initRelayPool();
  const events = await relayPool.querySync(RELAYS, filter, { timeout: timeoutMs });
  return events || [];
}

export async function publishFolderEvent(folderId, folderName) {
  const result = await publishEvent({
    kind: EVENT_KINDS.FOLDER,
    content: "",
    created_at: unixNow(),
    tags: [
      ["d", folderId],
      ["name", folderName],
    ],
  });

  return result.id;
}

export async function publishFileMetadata(metadata) {
  const {
    blobHash,
    blobUrl,
    createdAt,
    mimeType,
    fileSize,
    fileVersion,
    folderId,
    fileName,
    fileId,
    wrappedFDK,
  } = metadata;

  if (!folderId) {
    throw new Error("File metadata requires a folder_id");
  }

  const pubkey = await window.nostr.getPublicKey();
  const folderRef = getFolderAddress(pubkey, folderId);

  const tags = [
    ["file_id", fileId || createFileId()],
    ["version", String(fileVersion || 1)],
    ["x", blobHash],
    ["url", blobUrl],
    ["m", mimeType],
    ["size", fileSize.toString()],
    ["folder", folderRef],
    ["wrapped_fdk", wrappedFDK],
    ["enc", "aes-256-gcm"],
  ];

  if (fileName) {
    tags.push(["name", fileName]);
  }

  const result = await publishEvent({
    kind: EVENT_KINDS.FILE_METADATA,
    content: "",
    created_at: createdAt || unixNow(),
    tags,
  });

  return result.id;
}

export async function publishDeletionEvent(eventId, reason = "") {
  if (!eventId) {
    throw new Error("Missing event id for deletion");
  }

  const result = await publishEvent({
    kind: 5,
    content: reason || "",
    created_at: unixNow(),
    tags: [["e", eventId]],
  });

  return result.id;
}

export async function publishFolderShare(shareData) {
  const { createdAt, folderId, recipients, version } = shareData;
  const uniqueRecipients = [...new Set((recipients || []).map((item) => normalizePubkey(item.pubkey)))];
  const accessByRecipient = new Map(
    (recipients || []).map((item) => [normalizePubkey(item.pubkey), item.encryptedFolderKey]),
  );

  if (!folderId) {
    throw new Error("Missing folder id for folder share event");
  }

  if (uniqueRecipients.length === 0) {
    throw new Error("Cannot publish folder share event without recipients");
  }

  const tags = [["d", folderId], ["folder", folderId], ["version", String(version || 1)]];
  for (const recipient of uniqueRecipients) {
    tags.push(["p", recipient]);
    const encryptedFolderKey = accessByRecipient.get(recipient);
    if (!encryptedFolderKey) {
      throw new Error(`Missing encrypted folder key for recipient ${recipient}`);
    }
    tags.push(["access_key", recipient, encryptedFolderKey]);
  }

  const result = await publishEvent({
    kind: EVENT_KINDS.SHARE,
    content: "",
    created_at: createdAt || unixNow(),
    tags,
  });

  return result.id;
}

export async function fetchUserFolders(pubkey) {
  const normalizedPubkey = normalizePubkey(pubkey);
  const events = await fetchEvents({
    kinds: [EVENT_KINDS.FOLDER],
    authors: [normalizedPubkey],
    limit: 200,
  });

  const latestByFolderId = new Map();
  for (const event of events) {
    const folderId = getTagValue(event, "d");
    if (!folderId) continue;

    const existing = latestByFolderId.get(folderId);
    if (isEventNewer(event, existing)) {
      latestByFolderId.set(folderId, event);
    }
  }

  return [...latestByFolderId.values()].sort(compareEventsNewestFirst);
}

export async function fetchFilesInFolder(ownerPubkey, folderId) {
  const normalizedPubkey = normalizePubkey(ownerPubkey);
  const addressableRef = getFolderAddress(normalizedPubkey, folderId);
  const events = await fetchEvents({
    kinds: [EVENT_KINDS.FILE_METADATA],
    authors: [normalizedPubkey],
    limit: 500,
  });

  const latestByFileIdentity = new Map();

  for (const event of events) {
    const folderRef = getTagValue(event, "folder");
    const rawFolderId = getFolderIdFromRef(folderRef);
    if (folderRef !== addressableRef && rawFolderId !== folderId) {
      continue;
    }

    const identity = getFileEventIdentity(event, rawFolderId || folderId);
    const existing = latestByFileIdentity.get(identity);
    if (isEventNewer(event, existing)) {
      latestByFileIdentity.set(identity, event);
    }
  }

  return [...latestByFileIdentity.values()]
    .filter((event) => {
      const folderRef = getTagValue(event, "folder");
      const rawFolderId = getFolderIdFromRef(folderRef);
      return folderRef === addressableRef || rawFolderId === folderId;
    })
    .sort(compareEventsNewestFirst);
}

export async function fetchFolderShares({ recipientPubkey = null, folderId = null, ownerPubkey = null } = {}) {
  const filter = {
    kinds: [EVENT_KINDS.SHARE],
    limit: 300,
  };

  if (recipientPubkey) {
    filter["#p"] = [normalizePubkey(recipientPubkey)];
  }

  if (ownerPubkey) {
    filter.authors = [normalizePubkey(ownerPubkey)];
  }

  let events = await fetchEvents(filter);

  if (!events.length && ownerPubkey) {
    events = await fetchEvents({
      kinds: [EVENT_KINDS.SHARE],
      authors: [normalizePubkey(ownerPubkey)],
      limit: 300,
    });
  }

  if (folderId) {
    events = events.filter((event) => {
      const dTag = getTagValue(event, "d");
      const folderTag = getTagValue(event, "folder");
      return dTag === folderId || folderTag === folderId;
    });
  }

  return events.sort(compareEventsNewestFirst);
}

export async function fetchLatestFolderShare(folderId, ownerPubkey = null) {
  const events = await fetchFolderShares({ folderId, ownerPubkey });
  return events[0] || null;
}

export async function fetchFolder(pubkey, folderId) {
  const normalizedPubkey = normalizePubkey(pubkey);
  const events = await fetchEvents({
    kinds: [EVENT_KINDS.FOLDER],
    authors: [normalizedPubkey],
    "#d": [folderId],
    limit: 50,
  });

  if (events.length > 0) {
    events.sort(compareEventsNewestFirst);
    return events[0];
  }

  const allAuthorFolders = await fetchUserFolders(normalizedPubkey);
  return allAuthorFolders.find((event) => getTagValue(event, "d") === folderId) || null;
}

export async function fetchFileMetadataByHash(blobHash) {
  const events = await fetchEvents({
    kinds: [EVENT_KINDS.FILE_METADATA],
    "#x": [blobHash],
    limit: 50,
  });

  if (!events.length) return null;
  events.sort(compareEventsNewestFirst);
  return events[0];
}

export async function fetchFileMetadata(blobHash) {
  return fetchFileMetadataByHash(blobHash);
}

export async function fetchLatestMetadata(blobHash) {
  return fetchFileMetadataByHash(blobHash);
}

export async function fetchFolderFiles(folderId, ownerPubkey = null) {
  const effectiveOwner = ownerPubkey || await window.nostr.getPublicKey();
  return fetchFilesInFolder(effectiveOwner, folderId);
}

export async function fetchFolderShareEvents(folderId, ownerPubkey = null) {
  return fetchFolderShares({ folderId, ownerPubkey });
}

export async function fetchSharedFoldersForRecipient(recipientPubkey) {
  const shares = await fetchFolderShares({ recipientPubkey });
  const deduped = new Map();

  for (const share of shares) {
    const folderId = getTagValue(share, "folder") || getTagValue(share, "d");
    if (!folderId) continue;

    const key = `${share.pubkey}:${folderId}`;
    const existing = deduped.get(key);
    if (isEventNewer(share, existing)) {
      deduped.set(key, share);
    }
  }

  return [...deduped.values()].sort(compareEventsNewestFirst);
}

export async function fetchUserProfile(pubkey) {
  const normalizedPubkey = normalizePubkey(pubkey);
  const events = await fetchEvents({
    kinds: [0], // kind 0 = user metadata
    authors: [normalizedPubkey],
    limit: 1,
  });

  if (!events.length) return null;
  
  try {
    const metadataEvent = events[0];
    const metadata = JSON.parse(metadataEvent.content);
    return {
      pubkey: normalizedPubkey,
      name: metadata.name || null,
      display_name: metadata.display_name || null,
      picture: metadata.picture || null,
    };
  } catch (error) {
    console.warn(`Failed to parse profile metadata for ${normalizedPubkey}:`, error);
    return null;
  }
}

export function subscribeToFolderSharesForRecipient(recipientPubkey, handlers = {}, options = {}) {
  const { onEvent, onError } = handlers;
  const { sinceSecondsAgo = 300 } = options;
  const normalizedPubkey = normalizePubkey(recipientPubkey);
  const relayPool = initRelayPool();
  const seenEventIds = new Set();

  const sub = relayPool.subscribeMany(
    RELAYS,
    [
      {
        kinds: [EVENT_KINDS.SHARE],
        "#p": [normalizedPubkey],
        since: unixNow() - sinceSecondsAgo,
      },
    ],
    {
      onevent: (shareEvent) => {
        if (shareEvent.kind !== EVENT_KINDS.SHARE) return;
        if (seenEventIds.has(shareEvent.id)) return;
        seenEventIds.add(shareEvent.id);
        onEvent?.(shareEvent);
      },
      onclose: (reasons) => {
        if (reasons?.length) {
          onError?.(new Error(`Folder share subscription closed: ${reasons.join(", ")}`));
        }
      },
    },
  );

  return () => sub.close();
}

export function getTagValue(event, tagName) {
  return event.tags.find((tag) => tag[0] === tagName)?.[1] || null;
}

export function getAllTagValues(event, tagName) {
  return event.tags
    .filter((tag) => tag[0] === tagName)
    .map((tag) => tag[1])
    .filter(Boolean);
}

export function getAccessKeyForRecipient(shareEvent, recipientPubkey) {
  const normalizedRecipient = normalizePubkey(recipientPubkey);
  const match = shareEvent.tags.find(
    (tag) => tag[0] === "access_key" && normalizePubkey(tag[1]) === normalizedRecipient,
  );
  return match?.[2] || null;
}

export function getFolderAddress(pubkey, folderId) {
  return `${EVENT_KINDS.FOLDER}:${normalizePubkey(pubkey)}:${folderId}`;
}

export function getFolderIdFromRef(folderRef) {
  if (!folderRef) return null;
  const parts = folderRef.split(":");
  if (parts.length === 3 && parts[0] === String(EVENT_KINDS.FOLDER)) {
    return parts[2];
  }
  return folderRef;
}

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) {
    throw new Error("Invalid hex string");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function normalizePubkey(pubkey) {
  if (pubkey?.startsWith("npub")) {
    const decoded = window.NostrTools?.nip19?.decode(pubkey);
    if (!decoded || decoded.type !== "npub") {
      throw new Error("Invalid npub recipient key");
    }
    return decoded.data;
  }

  return pubkey;
}

function getLocalPrivateKeyBytes() {
  const nsec = window.localStorage.getItem("driveNsec");
  if (nsec?.startsWith("nsec")) {
    const decoded = window.NostrTools?.nip19?.decode(nsec);
    if (decoded?.type === "nsec") return decoded.data;
  }

  const hex = window.localStorage.getItem("drivePrivkeyHex");
  if (hex && /^[0-9a-f]{64}$/i.test(hex)) {
    return hexToBytes(hex.toLowerCase());
  }

  return null;
}

export async function encryptNIP44(plaintext, recipientPubkey) {
  const targetPubkey = normalizePubkey(recipientPubkey);

  if (window.nostr?.nip44?.encrypt) {
    return window.nostr.nip44.encrypt(targetPubkey, plaintext);
  }

  if (window.nostr?.nip44?.encryptAsync) {
    return window.nostr.nip44.encryptAsync(targetPubkey, plaintext);
  }

  const nip44 = window.NostrTools?.nip44;
  if (nip44?.v2?.utils?.getConversationKey && nip44?.v2?.encrypt) {
    const privateKey = getLocalPrivateKeyBytes();
    if (!privateKey) {
      throw new Error(
        "NIP-44 unavailable in extension. Set localStorage driveNsec or drivePrivkeyHex for nostr-tools fallback.",
      );
    }

    const conversationKey = nip44.v2.utils.getConversationKey(privateKey, targetPubkey);
    return nip44.v2.encrypt(plaintext, conversationKey);
  }

  throw new Error("NIP-44 encryption unavailable: extension and nostr-tools fallback are both unavailable");
}

export async function decryptNIP44(ciphertext, senderPubkey) {
  const sourcePubkey = normalizePubkey(senderPubkey);

  if (window.nostr?.nip44?.decrypt) {
    return window.nostr.nip44.decrypt(sourcePubkey, ciphertext);
  }

  if (window.nostr?.nip44?.decryptAsync) {
    return window.nostr.nip44.decryptAsync(sourcePubkey, ciphertext);
  }

  const nip44 = window.NostrTools?.nip44;
  if (nip44?.v2?.utils?.getConversationKey && nip44?.v2?.decrypt) {
    const privateKey = getLocalPrivateKeyBytes();
    if (!privateKey) {
      throw new Error(
        "NIP-44 unavailable in extension. Set localStorage driveNsec or drivePrivkeyHex for nostr-tools fallback.",
      );
    }

    const conversationKey = nip44.v2.utils.getConversationKey(privateKey, sourcePubkey);
    return nip44.v2.decrypt(ciphertext, conversationKey);
  }

  throw new Error("NIP-44 decryption unavailable: extension and nostr-tools fallback are both unavailable");
}
