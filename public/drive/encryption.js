/**
 * Encryption module for AES-256-GCM data/file encryption and key wrapping.
 * Wire format for encrypted payloads: [version_byte|iv_12_bytes|ciphertext_with_tag]
 */

const ENCRYPTION_VERSION = 0;
const IV_LENGTH = 12;  // bytes
const KEY_LENGTH = 32; // bytes (256 bits)

function bytesToBase64(bytes) {
  const chars = String.fromCharCode(...bytes);
  return btoa(chars);
}

function base64ToBytes(base64) {
  const chars = atob(base64);
  const out = new Uint8Array(chars.length);
  for (let i = 0; i < chars.length; i += 1) {
    out[i] = chars.charCodeAt(i);
  }
  return out;
}

function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error("Expected Uint8Array or ArrayBuffer");
}

async function encryptAesGcm(plaintext, keyBytes) {
  const iv = window.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const cryptoKey = await window.crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);

  const ciphertext = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    plaintext,
  );

  const encrypted = new Uint8Array(1 + IV_LENGTH + ciphertext.byteLength);
  encrypted[0] = ENCRYPTION_VERSION;
  encrypted.set(iv, 1);
  encrypted.set(new Uint8Array(ciphertext), 1 + IV_LENGTH);
  return encrypted;
}

async function decryptAesGcm(blob, keyBytes) {
  const payload = toUint8Array(blob);
  const version = payload[0];
  if (version !== ENCRYPTION_VERSION) {
    throw new Error(`Unsupported encryption version: ${version}`);
  }

  const iv = payload.slice(1, 1 + IV_LENGTH);
  const ciphertext = payload.slice(1 + IV_LENGTH);
  const cryptoKey = await window.crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);

  const plaintext = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    ciphertext,
  );

  return new Uint8Array(plaintext);
}

/**
 * Generate a random 32-byte key (FDK or FAK)
 * @returns {Promise<Uint8Array>} 32-byte key
 */
export async function generateKey() {
  return window.crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
}

/**
 * Encrypt file data with the provided FDK.
 * @param {ArrayBuffer|Uint8Array} plaintext - File data to encrypt
 * @param {Uint8Array} fdk - File Data Key (32 bytes)
 * @returns {Promise<Uint8Array>} Encrypted payload bytes
 */
export async function encryptFile(plaintext, fdk) {
  return encryptAesGcm(toUint8Array(plaintext), fdk);
}

/**
 * Decrypt file data with the provided FDK.
 * @param {Uint8Array} blob - Encrypted blob (with version + iv + ciphertext)
 * @param {Uint8Array} fdk - 32-byte File Data Key
 * @returns {Promise<Uint8Array>} Decrypted plaintext
 */
export async function decryptFile(blob, fdk) {
  return decryptAesGcm(blob, fdk);
}

/**
 * Encrypt FDK with FAK and encode as base64 for metadata tag transport.
 * @param {Uint8Array} fdk - File Data Key
 * @param {Uint8Array} fak - File Access Key
 * @returns {Promise<string>} Base64-wrapped FDK
 */
export async function wrapKey(fdk, fak) {
  const wrapped = await encryptAesGcm(fdk, fak);
  return bytesToBase64(wrapped);
}

/**
 * Decrypt wrapped FDK from metadata.
 * @param {string} wrappedFdkBase64 - Base64 encoded wrapped key payload
 * @param {Uint8Array} fak - File Access Key
 * @returns {Promise<Uint8Array>} File Data Key
 */
export async function unwrapKey(wrappedFdkBase64, fak) {
  const wrapped = base64ToBytes(wrappedFdkBase64);
  return decryptAesGcm(wrapped, fak);
}

/**
 * Generate a new FAK and return a new wrapped FDK.
 * @param {Uint8Array} fdk - File Data Key
 * @returns {Promise<{fak: Uint8Array, wrappedFDK: string}>}
 */
export async function rotateAccessKey(fdk) {
  const fak = await generateKey();
  const wrappedFDK = await wrapKey(fdk, fak);
  return { fak, wrappedFDK };
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

// Backward-compatible alias.
export const generateFileKey = generateKey;
