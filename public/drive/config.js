/**
 * Configuration for encrypted drive client
 * - Hardcoded relay defaults
 * - Blossom server URL (same-origin by default)
 */

export const RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
];

/**
 * Get Blossom server base URL (default: same-origin)
 * @returns {string} Blossom API base URL
 */
export function getBlossomUrl() {
  const proto = window.location.protocol;
  const host = window.location.host;
  return `${proto}//${host}`;
}

export const EVENT_KINDS = {
  FOLDER: 50000,        // Replaceable, per pubkey + folder_id
  FILE_METADATA: 1063,  // NIP-94 media event
  SHARE: 50001,         // Share event with NIP-44 encrypted key
};
