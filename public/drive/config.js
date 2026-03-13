/**
 * Configuration for encrypted drive client
 * - Hardcoded relay defaults
 * - Blossom server URL (same-origin by default)
 */

export const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://nostr.mom",
  "wss://nostr.oxtr.dev",
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
  // Custom parameterized replaceable kinds for this app (avoid NIP-reserved 30000/30001).
  FOLDER: 33100,
  FILE_METADATA: 1063,  // NIP-94 media event
  SHARE: 33101,
};
