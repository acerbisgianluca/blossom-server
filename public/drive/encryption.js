/**
 * Encryption module for AES-256-GCM file encryption/decryption
 * Wire format: [version_byte|iv_12_bytes|ciphertext_with_tag]
 */

const ENCRYPTION_VERSION = 0;
const TAG_LENGTH = 16; // bytes
const IV_LENGTH = 12;  // bytes
const KEY_LENGTH = 32; // bytes (256 bits)

/**
 * Generate a random AES-256 key
 * @returns {Promise<Uint8Array>} 32-byte key
 */
export async function generateFileKey() {
  const key = await window.crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
  return key;
}

/**
 * Encrypt a file buffer using AES-256-GCM
 * @param {ArrayBuffer|Uint8Array} plaintext - File data to encrypt
 * @returns {Promise<{key: Uint8Array, encrypted: Uint8Array}>}
 */
export async function encryptFile(plaintext) {
  const key = await generateFileKey();
  const iv = window.crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  // Import key for WebCrypto
  const cryptoKey = await window.crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  // Encrypt
  const ciphertext = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    plaintext
  );

  // Package: version + iv + ciphertext (includes tag)
  const encrypted = new Uint8Array(1 + IV_LENGTH + ciphertext.byteLength);
  encrypted[0] = ENCRYPTION_VERSION;
  encrypted.set(iv, 1);
  encrypted.set(new Uint8Array(ciphertext), 1 + IV_LENGTH);

  return {
    key,
    encrypted,
  };
}

/**
 * Decrypt a file using AES-256-GCM
 * @param {Uint8Array} blob - Encrypted blob (with version + iv + ciphertext)
 * @param {Uint8Array} key - 32-byte AES-256 key
 * @returns {Promise<Uint8Array>} Decrypted plaintext
 */
export async function decryptFile(blob, key) {
  // Extract version, iv, ciphertext
  const version = blob[0];
  if (version !== ENCRYPTION_VERSION) {
    throw new Error(`Unsupported encryption version: ${version}`);
  }

  const iv = blob.slice(1, 1 + IV_LENGTH);
  const ciphertext = blob.slice(1 + IV_LENGTH);

  // Import key for WebCrypto
  const cryptoKey = await window.crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  // Decrypt
  const plaintext = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    ciphertext
  );

  return new Uint8Array(plaintext);
}

/**
 * Convert key to hex string for storage/display
 * @param {Uint8Array} keyBytes - Key bytes
 * @returns {string} Hex string
 */
export function keyToHex(keyBytes) {
  return Array.from(keyBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Convert hex string back to key bytes
 * @param {string} hexStr - Hex string
 * @returns {Uint8Array} Key bytes
 */
export function hexToKey(hexStr) {
  const bytes = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < hexStr.length; i += 2) {
    bytes[i / 2] = parseInt(hexStr.substr(i, 2), 16);
  }
  return bytes;
}
