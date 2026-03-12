/**
 * @typedef {Object} EncryptedPayload
 * @property {number} version - Payload version (0 for now)
 * @property {Uint8Array} iv - 12-byte initialization vector
 * @property {Uint8Array} ciphertext - AES-256-GCM ciphertext + authentication tag
 */

/**
 * @typedef {Object} FileMetadata
 * @property {string} blobHash - SHA256 of encrypted blob (hex)
 * @property {string} fileName - Original file name
 * @property {number} fileSize - Original plaintext file size
 * @property {string} mimeType - MIME type of original file
 * @property {string} encryptedSize - Size of encrypted blob
 * @property {string} wrappedFDK - Base64 AES-GCM wrapped FDK (encrypted with current FAK)
 * @property {string} folderId - Optional folder reference
 * @property {string} ownerPubkey - Nostr pubkey of uploader
 * @property {number} uploadedAt - Unix timestamp
 */

/**
 * @typedef {Object} ShareEventPayload
 * @property {string} blobHash - SHA256 of encrypted blob
 * @property {string[]} recipients - Nostr pubkeys allowlisted for access
 * @property {Array<{pubkey: string, encryptedFAK: string}>} accessKeys - NIP-44 encrypted FAK per recipient
 * @property {string} senderPubkey - Nostr pubkey of sender
 * @property {number} sharedAt - Unix timestamp
 */

/**
 * @typedef {Object} BlobDescriptor
 * @property {string} sha256 - SHA256 hash (hex)
 * @property {number} size - Blob size in bytes
 * @property {string} type - MIME type
 * @property {string} url - Full URL to blob
 * @property {number} uploaded - Unix timestamp
 */

/**
 * @typedef {Object} NostrEvent
 * @property {number} kind - Event kind
 * @property {Array<Array<string>>} tags - Event tags
 * @property {string} content - Event content
 * @property {number} created_at - Unix timestamp
 * @property {string} pubkey - Author pubkey (hex)
 * @property {string} sig - BIP340 signature (hex)
 */

export {};
