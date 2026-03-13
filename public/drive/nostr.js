/**
 * Nostr event module for folder-based encrypted sharing.
 */

import { RELAYS, EVENT_KINDS } from "./config.js";
import { unixNow } from "../utils.js";

let pool = null;
let lastPublishedCreatedAt = 0;

function getFolderKinds() {
  return [EVENT_KINDS.FOLDER];
}

function getShareKinds() {
  return [EVENT_KINDS.SHARE];
}

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

export async function publishFolderEvent(folderId, folderName, options = {}) {
  const { price = null, zap = null } = options;
  const tags = [
    ["d", folderId],
    ["name", folderName],
  ];

  if (price != null && Number.isFinite(Number(price)) && Number(price) > 0) {
    tags.push(["amount", String(Math.trunc(Number(price)))]);
    tags.push(["price", String(Math.trunc(Number(price)))]);
  }

  if (zap) {
    tags.push(["zap", String(zap)]);
  }

  const result = await publishEvent({
    kind: EVENT_KINDS.FOLDER,
    content: "",
    created_at: unixNow(),
    tags,
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
    ["a", folderRef],
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
  const { createdAt, folderId, recipients, ownerPubkey } = shareData;

  if (!folderId) {
    throw new Error("Missing folder id for folder share event");
  }

  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error("Cannot publish folder share event without recipients");
  }

  const owner = normalizePubkey(ownerPubkey || await window.nostr.getPublicKey());
  const published = [];
  for (const entry of recipients) {
    const recipient = normalizePubkey(entry?.pubkey);
    const encryptedFolderKey = entry?.encryptedFolderKey;
    if (!recipient || !encryptedFolderKey) continue;

    const id = await publishShareEvent({
      folderId,
      ownerPubkey: owner,
      recipientPubkey: recipient,
      encryptedKey: encryptedFolderKey,
      createdAt,
    });
    published.push(id);
  }

  if (published.length === 0) {
    throw new Error("No valid recipients for folder share publish");
  }

  return published[0];
}

export async function publishShareEvent(shareData) {
  const {
    createdAt,
    folderId,
    ownerPubkey,
    payment,
    recipientPubkey,
    encryptedKey,
  } = shareData;

  const recipient = normalizePubkey(recipientPubkey);
  const owner = normalizePubkey(ownerPubkey || await window.nostr.getPublicKey());

  if (!folderId) {
    throw new Error("Missing folder id for share event");
  }
  if (!recipient) {
    throw new Error("Missing recipient pubkey for share event");
  }
  if (!encryptedKey) {
    throw new Error("Missing encrypted folder key for share event");
  }

  const folderAddress = getFolderAddress(owner, folderId);
  const dTag = getShareDTag(folderId, recipient);

  const tags = [
    ["d", dTag],
    ["a", folderAddress],
    ["p", recipient],
    ["key", encryptedKey],
  ];

  if (payment) {
    tags.push(["payment", payment]);
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
    kinds: getFolderKinds(),
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

export async function fetchPaidFolders(limit = 300) {
  const events = await fetchEvents({
    kinds: getFolderKinds(),
    limit,
  });

  const latestByFolderAddress = new Map();
  for (const event of events) {
    const folderId = getTagValue(event, "d");
    const price = getTagValue(event, "amount") || getTagValue(event, "price");
    if (!folderId || !price) continue;

    const folderAddress = getFolderAddress(event.pubkey, folderId);
    const existing = latestByFolderAddress.get(folderAddress);
    if (isEventNewer(event, existing)) {
      latestByFolderAddress.set(folderAddress, event);
    }
  }

  return [...latestByFolderAddress.values()].sort(compareEventsNewestFirst);
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
    const folderRef = getTagValue(event, "a") || getTagValue(event, "folder");
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
      const folderRef = getTagValue(event, "a") || getTagValue(event, "folder");
      const rawFolderId = getFolderIdFromRef(folderRef);
      return folderRef === addressableRef || rawFolderId === folderId;
    })
    .sort(compareEventsNewestFirst);
}

export async function fetchFolderShares({ recipientPubkey = null, folderId = null, ownerPubkey = null } = {}) {
  if (folderId && ownerPubkey) {
    const address = getFolderAddress(ownerPubkey, folderId);
    const events = await fetchShareEventsForFolder(address);
    if (!recipientPubkey) {
      return events;
    }

    const target = normalizePubkey(recipientPubkey);
    return events.filter((event) => normalizePubkey(getTagValue(event, "p")) === target);
  }

  if (recipientPubkey && !folderId) {
    return fetchShareEventsForUser(recipientPubkey);
  }

  const filter = {
    kinds: getShareKinds(),
    limit: 500,
  };

  if (ownerPubkey) {
    filter.authors = [normalizePubkey(ownerPubkey)];
  }
  if (recipientPubkey) {
    filter["#p"] = [normalizePubkey(recipientPubkey)];
  }

  let events = await fetchEvents(filter);
  if (folderId) {
    events = events.filter((event) => getFolderIdFromShareEvent(event) === folderId);
  }

  return dedupeShareEvents(events);
}

export async function fetchLatestFolderShare(folderId, ownerPubkey = null, recipientPubkey = null) {
  const events = await fetchFolderShares({ folderId, ownerPubkey, recipientPubkey });
  return events[0] || null;
}

export async function fetchFolder(pubkey, folderId) {
  const normalizedPubkey = normalizePubkey(pubkey);
  const events = await fetchEvents({
    kinds: getFolderKinds(),
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
  const shares = await fetchShareEventsForUser(recipientPubkey);
  const deduped = new Map();

  for (const share of shares) {
    const folderAddress = getTagValue(share, "a") || null;
    const folderId = getFolderIdFromShareEvent(share);
    if (!folderId) continue;

    const key = folderAddress || `${share.pubkey}:${folderId}`;
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
        kinds: getShareKinds(),
        "#p": [normalizedPubkey],
        since: unixNow() - sinceSecondsAgo,
      },
    ],
    {
      onevent: (shareEvent) => {
        if (!getShareKinds().includes(shareEvent.kind)) return;
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

  const eventRecipient = normalizePubkey(getTagValue(shareEvent, "p"));
  if (eventRecipient === normalizedRecipient) {
    const keyTag = shareEvent.tags.find((tag) => tag[0] === "key" && tag[1]);
    if (keyTag?.[1]) return keyTag[1];
  }

  const keyByRecipientTag = shareEvent.tags.find(
    (tag) => tag[0]?.startsWith("key:") && normalizePubkey(tag[0].slice(4)) === normalizedRecipient,
  );
  if (keyByRecipientTag?.[1]) return keyByRecipientTag[1];

  const match = shareEvent.tags.find(
    (tag) => tag[0] === "access_key" && normalizePubkey(tag[1]) === normalizedRecipient,
  );
  return match?.[2] || null;
}

export function buildFolderAddress(folderEvent) {
  const folderId = getTagValue(folderEvent, "d");
  if (!folderId || !folderEvent?.pubkey) {
    throw new Error("Cannot build folder address from folder event");
  }
  return getFolderAddress(folderEvent.pubkey, folderId);
}

function parseFolderAddress(folderAddress) {
  const parts = (folderAddress || "").split(":");
  if (parts.length !== 3) return null;
  const folderKind = String(parts[0]);
  const validKinds = new Set(getFolderKinds().map((kind) => String(kind)));
  if (!validKinds.has(folderKind)) return null;
  return {
    ownerPubkey: normalizePubkey(parts[1]),
    folderId: parts[2],
  };
}

function getShareDTag(folderId, recipientPubkey) {
  return `${folderId}:${normalizePubkey(recipientPubkey)}`;
}

function parseShareDTag(dTag) {
  const separatorIndex = (dTag || "").lastIndexOf(":");
  if (separatorIndex <= 0) return null;

  const folderId = dTag.slice(0, separatorIndex);
  const recipientPubkey = dTag.slice(separatorIndex + 1);
  if (!folderId || !recipientPubkey) return null;

  return {
    folderId,
    recipientPubkey: normalizePubkey(recipientPubkey),
  };
}

function getFolderIdFromShareEvent(shareEvent) {
  const address = parseFolderAddress(getTagValue(shareEvent, "a"));
  if (address?.folderId) return address.folderId;

  const parsedDTag = parseShareDTag(getTagValue(shareEvent, "d"));
  if (parsedDTag?.folderId) return parsedDTag.folderId;

  return getTagValue(shareEvent, "folder") || getTagValue(shareEvent, "d") || null;
}

function getShareIdentityKey(shareEvent) {
  const folderId = getFolderIdFromShareEvent(shareEvent);
  const recipient = normalizePubkey(getTagValue(shareEvent, "p") || "");

  const parsedAddress = parseFolderAddress(getTagValue(shareEvent, "a"));
  const owner = parsedAddress?.ownerPubkey || normalizePubkey(shareEvent.pubkey);

  if (!folderId || !recipient || !owner) {
    return null;
  }

  return `${owner}:${folderId}:${recipient}`;
}

function dedupeShareEvents(events) {
  const byIdentity = new Map();
  for (const event of events || []) {
    const key = getShareIdentityKey(event);
    if (!key) continue;
    const existing = byIdentity.get(key);
    if (isEventNewer(event, existing)) {
      byIdentity.set(key, event);
    }
  }
  return [...byIdentity.values()].sort(compareEventsNewestFirst);
}

function extractLegacyAccessKeys(shareEvent) {
  const recipients = getAllTagValues(shareEvent, "p").map((value) => normalizePubkey(value));
  const recipientSet = new Set(recipients);
  const keysByRecipient = new Map();

  for (const tag of shareEvent.tags || []) {
    if (!Array.isArray(tag) || tag.length < 2) continue;

    if (tag[0] === "access_key" && tag[1] && tag[2]) {
      keysByRecipient.set(normalizePubkey(tag[1]), tag[2]);
      recipientSet.add(normalizePubkey(tag[1]));
      continue;
    }

    if (tag[0].startsWith("key:") && tag[1]) {
      const recipient = normalizePubkey(tag[0].slice(4));
      keysByRecipient.set(recipient, tag[1]);
      recipientSet.add(recipient);
    }
  }

  // Legacy fallback: single key with single recipient.
  const keyTag = (shareEvent.tags || []).find((tag) => tag[0] === "key" && tag[1]);
  if (keyTag && recipients.length === 1 && !keysByRecipient.get(recipients[0])) {
    keysByRecipient.set(recipients[0], keyTag[1]);
  }

  return [...recipientSet]
    .map((recipient) => ({ recipient, encryptedKey: keysByRecipient.get(recipient) || null }))
    .filter((entry) => entry.recipient && entry.encryptedKey);
}

function isLegacyAclShareEvent(shareEvent) {
  const addressTag = getTagValue(shareEvent, "a");
  if (addressTag) return false;

  const dTag = getTagValue(shareEvent, "d") || "";
  if (parseShareDTag(dTag)) return false;

  const recipientCount = getAllTagValues(shareEvent, "p").length;
  const hasAccessKeyTag = (shareEvent.tags || []).some((tag) => tag[0] === "access_key");
  const hasRecipientKeyTag = (shareEvent.tags || []).some((tag) => tag[0]?.startsWith("key:"));
  const hasPlainKeyTag = (shareEvent.tags || []).some((tag) => tag[0] === "key" && tag[1]);
  return recipientCount > 1 || hasAccessKeyTag || hasRecipientKeyTag || (recipientCount === 1 && hasPlainKeyTag);
}

async function migrateLegacyShareEvent(legacyEvent, ownerPubkey, folderId) {
  const entries = extractLegacyAccessKeys(legacyEvent);
  if (entries.length === 0) return 0;

  let published = 0;
  for (const entry of entries) {
    await publishShareEvent({
      folderId,
      ownerPubkey,
      recipientPubkey: entry.recipient,
      encryptedKey: entry.encryptedKey,
      createdAt: (legacyEvent.created_at || unixNow()) + 1,
    });
    published += 1;
  }

  await publishDeletionEvent(legacyEvent.id, "migrated legacy ACL share event");
  return published;
}

export async function fetchShareEventsForFolder(folderAddress) {
  const parsedAddress = parseFolderAddress(folderAddress);
  if (!parsedAddress) {
    throw new Error("Invalid folder address");
  }

  const { ownerPubkey, folderId } = parsedAddress;
  let events = await fetchEvents({
    kinds: getShareKinds(),
    "#a": [folderAddress],
    authors: [ownerPubkey],
    limit: 500,
  });

  // Relays may miss #a indexing; fallback to author-scan and local filtering.
  if (!events.length) {
    const scanned = await fetchEvents({
      kinds: getShareKinds(),
      authors: [ownerPubkey],
      limit: 500,
    });

    events = scanned.filter((event) => {
      const eventFolderId = getFolderIdFromShareEvent(event);
      const eventAddress = getTagValue(event, "a");
      return eventFolderId === folderId || eventAddress === folderAddress;
    });
  }

  const myPubkey = normalizePubkey(await window.nostr.getPublicKey());
  const legacyEvents = events.filter((event) => isLegacyAclShareEvent(event));
  for (const legacyEvent of legacyEvents) {
    // Only the original author can publish valid replacements/deletions.
    if (normalizePubkey(legacyEvent.pubkey) !== myPubkey) continue;
    await migrateLegacyShareEvent(legacyEvent, ownerPubkey, folderId);
  }

  if (legacyEvents.length > 0) {
    events = await fetchEvents({
      kinds: getShareKinds(),
      "#a": [folderAddress],
      authors: [ownerPubkey],
      limit: 500,
    });

    if (!events.length) {
      const scanned = await fetchEvents({
        kinds: getShareKinds(),
        authors: [ownerPubkey],
        limit: 500,
      });
      events = scanned.filter((event) => {
        const eventAddress = parseFolderAddress(getTagValue(event, "a"));
        return !!eventAddress && eventAddress.ownerPubkey === ownerPubkey && eventAddress.folderId === folderId;
      });
    }
  }

  const canonical = events.filter((event) => {
    const recipient = getTagValue(event, "p");
    const encryptedKey = getTagValue(event, "key");
    const parsedEventAddress = parseFolderAddress(getTagValue(event, "a"));
    return !!parsedEventAddress
      && parsedEventAddress.ownerPubkey === ownerPubkey
      && parsedEventAddress.folderId === folderId
      && recipient
      && encryptedKey;
  });

  return dedupeShareEvents(canonical);
}

export async function fetchShareEventsForUser(pubkey) {
  const normalizedPubkey = normalizePubkey(pubkey);
  const myPubkey = normalizePubkey(await window.nostr.getPublicKey());
  const events = await fetchEvents({
    kinds: getShareKinds(),
    "#p": [normalizedPubkey],
    limit: 500,
  });

  const legacyEvents = events.filter((event) => isLegacyAclShareEvent(event));
  for (const legacyEvent of legacyEvents) {
    if (normalizePubkey(legacyEvent.pubkey) !== myPubkey) continue;
    const folderId = getFolderIdFromShareEvent(legacyEvent);
    if (!folderId) continue;
    await migrateLegacyShareEvent(legacyEvent, normalizePubkey(legacyEvent.pubkey), folderId);
  }

  let latest = events;
  if (legacyEvents.length > 0) {
    latest = await fetchEvents({
      kinds: getShareKinds(),
      "#p": [normalizedPubkey],
      limit: 500,
    });
  }

  const canonical = latest.filter((event) => {
    const eventRecipient = normalizePubkey(getTagValue(event, "p") || "");
    return eventRecipient === normalizedPubkey && !!getTagValue(event, "a") && !!getTagValue(event, "key");
  });

  return dedupeShareEvents(canonical);
}

export async function publishDeletion(eventId, reason = "") {
  return publishDeletionEvent(eventId, reason);
}

export function getFolderAddress(pubkey, folderId) {
  return `${EVENT_KINDS.FOLDER}:${normalizePubkey(pubkey)}:${folderId}`;
}

export function getFolderIdFromRef(folderRef) {
  if (!folderRef) return null;
  const parts = folderRef.split(":");
  const validKinds = new Set(getFolderKinds().map((kind) => String(kind)));
  if (parts.length === 3 && validKinds.has(parts[0])) {
    return parts[2];
  }
  return folderRef;
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

export async function encryptNIP44(plaintext, recipientPubkey) {
  const targetPubkey = normalizePubkey(recipientPubkey);

  if (window.nostr?.nip44?.encrypt) {
    return window.nostr.nip44.encrypt(targetPubkey, plaintext);
  }

  if (window.nostr?.nip44?.encryptAsync) {
    return window.nostr.nip44.encryptAsync(targetPubkey, plaintext);
  }

  throw new Error("NIP-44 encryption unavailable: window.nostr does not expose nip44 support");
}

export async function decryptNIP44(ciphertext, senderPubkey) {
  const sourcePubkey = normalizePubkey(senderPubkey);

  if (window.nostr?.nip44?.decrypt) {
    return window.nostr.nip44.decrypt(sourcePubkey, ciphertext);
  }

  if (window.nostr?.nip44?.decryptAsync) {
    return window.nostr.nip44.decryptAsync(sourcePubkey, ciphertext);
  }

  throw new Error("NIP-44 decryption unavailable: window.nostr does not expose nip44 support");
}
