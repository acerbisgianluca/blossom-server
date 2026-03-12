/**
 * Blossom blob upload/download module
 * Handles encrypted blob storage via Blossom server
 */

import { getBlossomUrl } from "./config.js";
import { unixNow, newExpirationValue, getFileSha256 } from "../utils.js";

/**
 * Upload encrypted blob to Blossom server
 * @param {Uint8Array} encryptedBlob - Encrypted file data
 * @param {string} mimeType - MIME type (default: application/octet-stream)
 * @returns {Promise<{sha256: string, size: number, url: string, type: string}>}
 */
export async function uploadBlob(encryptedBlob, mimeType = "application/octet-stream") {
  // Compute SHA256 of encrypted blob
  const sha256 = await getFileSha256(new Blob([encryptedBlob], { type: mimeType }));

  const blossomUrl = getBlossomUrl();
  const endpoint = `${blossomUrl}/upload`;

  // Create auth event for upload
  const auth = await window.nostr.signEvent({
    kind: 24242,
    content: "Authorize Upload",
    created_at: unixNow(),
    tags: [
      ["t", "upload"],
      ["x", sha256],
      ["expiration", newExpirationValue()],
    ],
  });

  const authorization = "Nostr " + btoa(JSON.stringify(auth));

  // Check upload capability
  const checkRes = await fetch(endpoint, {
    method: "HEAD",
    headers: {
      "authorization": authorization,
      "X-Content-Type": mimeType,
      "X-Content-Length": encryptedBlob.byteLength.toString(),
      "X-Sha-256": sha256,
    },
  });

  if (!checkRes.ok) {
    throw new Error(checkRes.headers.get("x-reason") || "Upload check failed");
  }

  // Upload blob
  const uploadRes = await fetch(endpoint, {
    method: "PUT",
    body: encryptedBlob,
    headers: {
      "authorization": authorization,
      "Content-Type": mimeType,
      "X-Sha-256": sha256,
    },
  });

  if (!uploadRes.ok) {
    throw new Error(`Upload failed: ${await uploadRes.text()}`);
  }

  const body = await uploadRes.json();
  return {
    sha256: body.sha256,
    size: body.size,
    url: body.url,
    type: body.type,
  };
}

/**
 * Download encrypted blob from Blossom server
 * @param {string} hash - SHA256 hash of blob (hex)
 * @returns {Promise<Uint8Array>} Encrypted blob data
 */
export async function downloadBlob(hash) {
  const blossomUrl = getBlossomUrl();
  const url = `${blossomUrl}/${hash}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}
