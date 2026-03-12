/**
 * Nostr event module for folder/file/share events
 * Uses nostr-tools for relay communication
 */

import { RELAYS, EVENT_KINDS } from "./config.js";
import { unixNow } from "../utils.js";

// Global relay pool (initialized lazily)
let pool = null;

/**
 * Initialize relay pool with nostr-tools
 */
export function initRelayPool() {
  if (pool) return pool;

  const { SimplePool } = window.NostrTools;
  if (!SimplePool) {
    throw new Error("nostr-tools not loaded. Please refresh the page.");
  }
  pool = new SimplePool();
  return pool;
}

/**
 * Publish an event to all configured relays
 * @param {Object} event - Nostr event struct
 * @returns {Promise<{id: string, acceptedRelays: string[]}>} Event id and relays that accepted
 */
export async function publishEvent(unsigned) {
  // Sign event
  const event = await window.nostr.signEvent(unsigned);

  // Publish to all relays
  const relayPool = initRelayPool();
  const relayUrls = RELAYS;

  const publishPromises = relayPool.publish(relayUrls, event);
  const settled = await Promise.allSettled(publishPromises);

  const acceptedRelays = settled
    .map((result, index) => (result.status === "fulfilled" ? relayUrls[index] : null))
    .filter((url) => url !== null);

  if (acceptedRelays.length === 0) {
    throw new Error("Failed to publish event to any relay");
  }

  return { id: event.id, acceptedRelays };
}

/**
 * Fetch events from relays
 * @param {Object} filter - Nostr filter (kinds, authors, #x, etc.)
 * @param {number} timeoutMs - Timeout for fetch
 * @returns {Promise<Array>} Array of events
 */
export async function fetchEvents(filter, timeoutMs = 5000) {
  const pool = initRelayPool();

  const events = await pool.querySync(RELAYS, filter, { timeout: timeoutMs });
  return events || [];
}

/**
 * Create and publish a folder event (kind 50000)
 * @param {string} folderId - Unique folder ID
 * @param {string} folderName - Human-readable folder name
 * @returns {Promise<string>} Event ID
 */
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

/**
 * Create and publish a file metadata event (kind 1063, NIP-94)
 * @param {Object} metadata - File metadata
 * @returns {Promise<string>} Event ID
 */
export async function publishFileMetadata(metadata) {
  const {
    blobHash,
    blobUrl,
    mimeType,
    fileSize,
    folderId,
    fileName,
    wrappedFDK,
  } = metadata;

  const pubkey = await window.nostr.getPublicKey();
  const tags = [
    ["x", blobHash],
    ["url", blobUrl],
    ["m", mimeType],
    ["size", fileSize.toString()],
    ["enc", "aes-256-gcm"],
    ["wrapped_key", wrappedFDK],
  ];

  if (fileName) {
    tags.push(["name", fileName]);
  }

  // Add folder reference if present
  if (folderId) {
    tags.push(["folder", folderId]);
    tags.push(["a", `${EVENT_KINDS.FOLDER}:${pubkey}:${folderId}`]);
  }

  const result = await publishEvent({
    kind: EVENT_KINDS.FILE_METADATA,
    content: "",
    created_at: unixNow(),
    tags,
  });

  return result.id;
}

/**
 * Create and publish a single share event for a file allowlist.
 * Uses one event per file with many recipient tags and per-recipient encrypted FAK tags.
 * @param {Object} shareData - Share information
 * @returns {Promise<string>} Event ID
 */
export async function publishShareEvent(shareData) {
  const {
    blobHash,
    recipients,
  } = shareData;

  const uniqueRecipients = [...new Set((recipients || []).map((r) => normalizePubkey(r.pubkey)))];
  const accessByPubkey = new Map(
    (recipients || []).map((r) => [normalizePubkey(r.pubkey), r.encryptedFAK]),
  );

  if (!blobHash) {
    throw new Error("Missing blob hash for share event");
  }

  if (uniqueRecipients.length === 0) {
    throw new Error("Cannot publish share event without recipients");
  }

  const tags = [["d", blobHash], ["file", blobHash]];
  for (const recipient of uniqueRecipients) {
    tags.push(["p", recipient]);
    const encryptedFAK = accessByPubkey.get(recipient);
    if (!encryptedFAK) {
      throw new Error(`Missing encrypted FAK for recipient ${recipient}`);
    }
    tags.push(["access_key", recipient, encryptedFAK]);
  }

  const result = await publishEvent({
    kind: EVENT_KINDS.SHARE,
    content: "",
    created_at: unixNow(),
    tags,
  });

  return result.id;
}

/**
 * Fetch all file metadata events for a user in a folder
 * @param {string} pubkey - Author pubkey
 * @param {string} folderId - Optional folder ID
 * @returns {Promise<Array>} File metadata events
 */
export async function fetchFilesForUser(pubkey, folderId = null) {
  const filter = {
    kinds: [EVENT_KINDS.FILE_METADATA],
    authors: [pubkey],
  };

  // Filter by folder address if specified
  if (folderId) {
    filter["#a"] = [`${EVENT_KINDS.FOLDER}:${pubkey}:${folderId}`];
  }

  return fetchEvents(filter);
}

/**
 * Fetch all share events for the current user
 * @param {string} pubkey - Recipient pubkey
 * @param {string} blobHash - Optional blob hash to filter
 * @returns {Promise<Array>} Share events
 */
export async function fetchSharesForUser(pubkey, blobHash = null) {
  const normalizedPubkey = normalizePubkey(pubkey);

  const filter = {
    kinds: [EVENT_KINDS.SHARE],
    "#p": [normalizedPubkey],
    limit: 200,
  };

  if (blobHash) {
    filter["#d"] = [blobHash];
  }

  // NOTE: many relays don't index non-standard multi-letter tags such as #file.
  // Query by recipient and filter by the custom "file" tag client-side.
  const events = await fetchEvents(filter);

  if (!blobHash) return events;
  return events.filter((event) => event.tags.some((tag) => tag[0] === "file" && tag[1] === blobHash));
}

/**
 * Fetch latest share event for a file.
 * @param {string} blobHash - Blob hash
 * @param {string|null} authorPubkey - Optional author pubkey filter
 * @returns {Promise<Object|null>} Latest share event or null
 */
export async function fetchLatestShareEvent(blobHash, authorPubkey = null) {
  const normalizedAuthor = authorPubkey ? normalizePubkey(authorPubkey) : null;
  const filter = {
    kinds: [EVENT_KINDS.SHARE],
    "#d": [blobHash],
    limit: 20,
  };

  if (normalizedAuthor) {
    filter.authors = [normalizedAuthor];
  }

  let events = await fetchEvents(filter);

  // Fallback for relays that do not index #d as expected.
  if (!events.length && normalizedAuthor) {
    events = await fetchEvents({
      kinds: [EVENT_KINDS.SHARE],
      authors: [normalizedAuthor],
      limit: 200,
    });
  }

  if (!events.length) {
    events = await fetchEvents({
      kinds: [EVENT_KINDS.SHARE],
      limit: 200,
    });
  }

  events = events.filter((event) => {
    if (normalizedAuthor && event.pubkey !== normalizedAuthor) return false;
    const dTag = event.tags.find((t) => t[0] === "d")?.[1];
    const fileTag = event.tags.find((t) => t[0] === "file")?.[1];
    return dTag === blobHash || fileTag === blobHash;
  });

  if (!events.length) return null;
  events.sort((a, b) => b.created_at - a.created_at);
  return events[0];
}

/**
 * Fetch folder event
 * @param {string} pubkey - Folder owner pubkey
 * @param {string} folderId - Folder ID
 * @returns {Promise<Object|null>} Folder event or null
 */
export async function fetchFolder(pubkey, folderId) {
  const events = await fetchEvents({
    kinds: [EVENT_KINDS.FOLDER],
    authors: [pubkey],
    "#d": [folderId],
  });

  return events[0] || null;
}

/**
 * Fetch file metadata by encrypted blob hash (kind 1063, tag x)
 * @param {string} blobHash - SHA256 hash of encrypted blob
 * @returns {Promise<Object|null>} Metadata event or null
 */
export async function fetchFileMetadataByHash(blobHash) {
  const events = await fetchEvents({
    kinds: [EVENT_KINDS.FILE_METADATA],
    "#x": [blobHash],
    limit: 20,
  });

  if (!events.length) return null;

  // Prefer newest metadata event for this hash.
  events.sort((a, b) => b.created_at - a.created_at);
  return events[0];
}

/**
 * Fetch latest metadata for a blob hash.
 * @param {string} blobHash - SHA256 hash of encrypted blob
 * @returns {Promise<Object|null>} Metadata event or null
 */
export async function fetchLatestMetadata(blobHash) {
  return fetchFileMetadataByHash(blobHash);
}

export function getTagValue(event, tagName) {
  return event.tags.find((t) => t[0] === tagName)?.[1] || null;
}

export function getAllTagValues(event, tagName) {
  return event.tags.filter((t) => t[0] === tagName).map((t) => t[1]).filter(Boolean);
}

export function getAccessKeyForRecipient(shareEvent, recipientPubkey) {
  const normalized = normalizePubkey(recipientPubkey);
  const match = shareEvent.tags.find((t) => t[0] === "access_key" && normalizePubkey(t[1]) === normalized);
  return match?.[2] || null;
}

function toSharedFileItem(shareEvent, metadataEvent) {
  const blobHash = getTagValue(shareEvent, "file");
  const mimeType = metadataEvent ? getTagValue(metadataEvent, "m") : null;
  const fileName = metadataEvent ? getTagValue(metadataEvent, "name") : null;
  const sizeValue = metadataEvent ? getTagValue(metadataEvent, "size") : null;

  return {
    shareEventId: shareEvent.id,
    blobHash,
    senderPubkey: shareEvent.pubkey,
    sharedAt: shareEvent.created_at,
    allowlistedPubkeys: getAllTagValues(shareEvent, "p"),
    fileName: fileName || `shared-${(blobHash || "file").slice(0, 12)}`,
    mimeType: mimeType || "application/octet-stream",
    size: sizeValue ? Number.parseInt(sizeValue, 10) : null,
  };
}

/**
 * Fetch files shared with a recipient pubkey (historical list)
 * @param {string} recipientPubkey - Recipient pubkey (hex or npub)
 * @param {number} limit - Maximum number of recent shared files
 * @returns {Promise<Array>} Shared file items enriched with metadata
 */
export async function fetchSharedFilesForRecipient(recipientPubkey, limit = 50) {
  const shares = await fetchSharesForUser(recipientPubkey);

  if (!shares.length) return [];

  shares.sort((a, b) => b.created_at - a.created_at);
  const recentShares = shares.slice(0, limit);

  const dedupedByBlob = new Map();
  for (const event of recentShares) {
    const hash = getTagValue(event, "file");
    if (!hash || dedupedByBlob.has(hash)) continue;
    dedupedByBlob.set(hash, event);
  }

  const items = await Promise.all(
    [...dedupedByBlob.values()].map(async (shareEvent) => {
      const blobHash = getTagValue(shareEvent, "file");
      const metadataEvent = blobHash ? await fetchFileMetadataByHash(blobHash) : null;
      return toSharedFileItem(shareEvent, metadataEvent);
    }),
  );

  return items.filter((item) => !!item.blobHash);
}

/**
 * Subscribe to new share events for a recipient pubkey in real time
 * @param {string} recipientPubkey - Recipient pubkey (hex or npub)
 * @param {{onEvent?: Function, onError?: Function}} handlers - Event callbacks
 * @returns {Function} Unsubscribe function
 */
export function subscribeToSharesForRecipient(recipientPubkey, handlers = {}, options = {}) {
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
        // Backfill a small recent window to avoid race conditions around subscription startup.
        since: unixNow() - sinceSecondsAgo,
      },
    ],
    {
      onevent: (shareEvent) => {
        if (shareEvent.kind !== EVENT_KINDS.SHARE) return;
        if (seenEventIds.has(shareEvent.id)) return;
        seenEventIds.add(shareEvent.id);

        const blobHash = getTagValue(shareEvent, "file");
        if (!blobHash) return;

        // Enrich share with metadata in background and emit complete item.
        void (async () => {
          try {
            const metadataEvent = await fetchFileMetadataByHash(blobHash);
            const item = toSharedFileItem(shareEvent, metadataEvent);
            onEvent?.(item);
          } catch (error) {
            onError?.(error);
          }
        })();
      },
      onclose: (reasons) => {
        if (reasons?.length) {
          onError?.(new Error(`Share subscription closed: ${reasons.join(", ")}`));
        }
      },
    },
  );

  return () => sub.close();
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

/**
 * Encrypt data using NIP-44 via window.nostr
 * @param {string} plaintext - Text to encrypt
 * @param {string} recipientPubkey - Recipient pubkey
 * @returns {Promise<string>} NIP-44 encrypted string
 */
export async function encryptNIP44(plaintext, recipientPubkey) {
  const targetPubkey = normalizePubkey(recipientPubkey);

  // Preferred: NIP-07 extension encryption (widely supported API shape)
  if (window.nostr?.nip44?.encrypt) {
    return window.nostr.nip44.encrypt(targetPubkey, plaintext);
  }

  // Compatibility: some providers expose async-suffixed methods
  if (window.nostr?.nip44?.encryptAsync) {
    return window.nostr.nip44.encryptAsync(targetPubkey, plaintext);
  }

  // Fallback: nostr-tools NIP-44 with locally provided private key
  const nip44 = window.NostrTools?.nip44;
  if (nip44?.v2?.utils?.getConversationKey && nip44?.v2?.encrypt) {
    const privateKey = getLocalPrivateKeyBytes();
    if (!privateKey) {
      throw new Error(
        "NIP-44 unavailable in extension. Set localStorage driveNsec or drivePrivkeyHex for nostr-tools fallback."
      );
    }

    const conversationKey = nip44.v2.utils.getConversationKey(privateKey, targetPubkey);
    return nip44.v2.encrypt(plaintext, conversationKey);
  }

  throw new Error("NIP-44 encryption unavailable: extension and nostr-tools fallback are both unavailable");
}

/**
 * Decrypt data using NIP-44 via window.nostr
 * @param {string} ciphertext - NIP-44 encrypted string
 * @param {string} senderPubkey - Sender pubkey
 * @returns {Promise<string>} Plaintext
 */
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
        "NIP-44 unavailable in extension. Set localStorage driveNsec or drivePrivkeyHex for nostr-tools fallback."
      );
    }

    const conversationKey = nip44.v2.utils.getConversationKey(privateKey, sourcePubkey);
    return nip44.v2.decrypt(ciphertext, conversationKey);
  }

  throw new Error("NIP-44 decryption unavailable: extension and nostr-tools fallback are both unavailable");
}
