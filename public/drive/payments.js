import { RELAYS } from "./config.js";
import {
  fetchFolder,
  getFolderAddress,
  getTagValue,
  initRelayPool,
} from "./nostr.js";
import { grantAccess } from "./folders.js";
import { unixNow } from "../utils.js";

function normalizePubkey(pubkey) {
  const value = (pubkey || "").trim();
  if (!value) return "";

  if (value.startsWith("npub")) {
    const decoded = window.NostrTools?.nip19?.decode?.(value);
    if (!decoded || decoded.type !== "npub" || !decoded.data) {
      throw new Error("Invalid npub pubkey");
    }
    return String(decoded.data).toLowerCase();
  }

  return value.toLowerCase();
}

function parseFolderAddress(address) {
  const parts = (address || "").split(":");
  if (parts.length !== 3 || parts[0] !== "30000") return null;
  return {
    ownerPubkey: normalizePubkey(parts[1]),
    folderId: parts[2],
  };
}

function ensureAmountMsats(value) {
  const parsed = Number.parseInt(String(value || "0"), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Folder price is missing or invalid");
  }
  return parsed;
}

function lud16ToUrl(lud16) {
  const [name, domain] = String(lud16 || "").split("@");
  if (!name || !domain) {
    throw new Error("Invalid zap address (lud16)");
  }
  return `https://${domain}/.well-known/lnurlp/${name}`;
}

function normalizeZapTarget(zapTarget) {
  const value = String(zapTarget || "").trim();
  if (!value) {
    throw new Error("Folder is paid but missing zap endpoint");
  }

  const withoutLightningPrefix = value.startsWith("lightning:")
    ? value.slice("lightning:".length)
    : value;

  // We currently accept LUD-16 or HTTP(S) LNURLp endpoints.
  // Raw bech32 LNURL needs decoding before HTTP fetch.
  if (/^lnurl1/i.test(withoutLightningPrefix)) {
    throw new Error(
      "Unsupported zap target format: LNURL bech32. Use a lightning address (name@domain) or https://.../.well-known/lnurlp/<name>",
    );
  }

  if (withoutLightningPrefix.includes("@")) {
    return lud16ToUrl(withoutLightningPrefix);
  }

  if (/^https?:\/\//i.test(withoutLightningPrefix)) {
    return withoutLightningPrefix;
  }

  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(withoutLightningPrefix)) {
    return `https://${withoutLightningPrefix}`;
  }

  throw new Error(
    "Invalid zap target. Use: name@domain or https://domain/.well-known/lnurlp/name",
  );
}

async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    const detail = error?.message ? ` (${error.message})` : "";
    throw new Error(`Failed to fetch zap endpoint ${url}${detail}`);
  }

  if (!response.ok) {
    throw new Error(`Zap endpoint request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

async function resolveZapEndpoint(folderEvent) {
  const zapTarget = getTagValue(folderEvent, "zap");
  const endpoint = normalizeZapTarget(zapTarget);
  const metadata = await fetchJson(endpoint);

  if (!metadata?.callback) {
    throw new Error("Zap endpoint does not expose callback");
  }

  return {
    callback: metadata.callback,
    lnurl: metadata.lnurl || endpoint,
  };
}

async function buildZapRequest(folderEvent, amountMsats) {
  const ownerPubkey = normalizePubkey(folderEvent.pubkey);
  const folderId = getTagValue(folderEvent, "d");
  const folderAddress = getFolderAddress(ownerPubkey, folderId);
  const pubkey = normalizePubkey(await window.nostr.getPublicKey());

  const unsigned = {
    kind: 9734,
    content: "",
    created_at: unixNow(),
    tags: [
      ["p", ownerPubkey],
      ["a", folderAddress],
      ["amount", String(amountMsats)],
      ["relays", ...RELAYS],
    ],
  };

  const signed = await window.nostr.signEvent(unsigned);
  return { event: signed, payerPubkey: pubkey };
}

async function requestInvoice(callback, lnurl, zapRequest, amountMsats) {
  const params = new URLSearchParams({
    amount: String(amountMsats),
    nostr: JSON.stringify(zapRequest),
    lnurl: lnurl || "",
  });
  const response = await fetch(`${callback}?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Zap callback failed (${response.status})`);
  }

  const data = await response.json();
  if (!data?.pr) {
    throw new Error("Zap callback did not return an invoice");
  }

  return data.pr;
}

async function payInvoice(invoice) {
  if (window.webln?.enable && window.webln?.sendPayment) {
    await window.webln.enable();
    return window.webln.sendPayment(invoice);
  }

  if (window.nostr?.zap) {
    return window.nostr.zap(invoice);
  }

  throw new Error("No Lightning wallet available (webln or nostr.zap)");
}

export async function unlockFolderWithZap(folderId, ownerPubkey) {
  const normalizedOwner = normalizePubkey(ownerPubkey);
  const folderEvent = await fetchFolder(normalizedOwner, folderId);
  if (!folderEvent) {
    throw new Error("Folder not found");
  }

  const priceMsats = ensureAmountMsats(getTagValue(folderEvent, "price"));
  const { callback, lnurl } = await resolveZapEndpoint(folderEvent);
  const { event: zapRequest } = await buildZapRequest(folderEvent, priceMsats);
  const invoice = await requestInvoice(callback, lnurl, zapRequest, priceMsats);
  await payInvoice(invoice);

  return {
    paid: true,
    pendingShare: true,
    folderId,
    ownerPubkey: normalizedOwner,
  };
}

function parseReceiptDescription(receiptEvent) {
  const descriptionTag = (receiptEvent.tags || []).find((tag) => tag[0] === "description" && tag[1]);
  if (!descriptionTag?.[1]) return null;

  try {
    const parsed = JSON.parse(descriptionTag[1]);
    return parsed && parsed.kind === 9734 ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function getReceiptAmountMsats(receiptEvent) {
  const amountTag = (receiptEvent.tags || []).find((tag) => tag[0] === "amount" && tag[1]);
  return ensureAmountMsats(amountTag?.[1] || "0");
}

async function verifyReceiptAndExtractGrant(receiptEvent, ownerPubkey) {
  const folderAddress = getTagValue(receiptEvent, "a");
  const parsedAddress = parseFolderAddress(folderAddress);
  if (!parsedAddress || parsedAddress.ownerPubkey !== normalizePubkey(ownerPubkey)) {
    return null;
  }

  const zapRequest = parseReceiptDescription(receiptEvent);
  if (!zapRequest) return null;

  const requestFolderAddress = (zapRequest.tags || []).find((tag) => tag[0] === "a")?.[1] || "";
  const requestOwner = (zapRequest.tags || []).find((tag) => tag[0] === "p")?.[1] || "";
  const requestAmount = (zapRequest.tags || []).find((tag) => tag[0] === "amount")?.[1] || "0";

  if (requestFolderAddress !== folderAddress) return null;
  if (normalizePubkey(requestOwner) !== normalizePubkey(ownerPubkey)) return null;

  const receiptAmountMsats = getReceiptAmountMsats(receiptEvent);
  const requestAmountMsats = ensureAmountMsats(requestAmount);
  if (receiptAmountMsats < requestAmountMsats) return null;

  const folderEvent = await fetchFolder(parsedAddress.ownerPubkey, parsedAddress.folderId);
  if (!folderEvent) return null;

  const priceMsats = ensureAmountMsats(getTagValue(folderEvent, "price"));
  if (receiptAmountMsats < priceMsats) return null;

  const payerPubkey = normalizePubkey(zapRequest.pubkey);
  if (!payerPubkey) return null;

  return {
    folderId: parsedAddress.folderId,
    payerPubkey,
    ownerPubkey: parsedAddress.ownerPubkey,
  };
}

export function startZapReceiptListener(ownerPubkey, handlers = {}) {
  const normalizedOwner = normalizePubkey(ownerPubkey);
  const relayPool = initRelayPool();
  const seenReceipts = new Set();
  const { onGranted, onError } = handlers;

  const sub = relayPool.subscribeMany(
    RELAYS,
    [
      {
        kinds: [9735],
        "#p": [normalizedOwner],
        since: unixNow() - 120,
      },
    ],
    {
      onevent: async (receiptEvent) => {
        if (seenReceipts.has(receiptEvent.id)) return;
        seenReceipts.add(receiptEvent.id);

        try {
          const verified = await verifyReceiptAndExtractGrant(receiptEvent, normalizedOwner);
          if (!verified) return;

          await grantAccess(
            verified.folderId,
            verified.payerPubkey,
            normalizedOwner,
            { paymentEventId: receiptEvent.id },
          );

          onGranted?.({
            folderId: verified.folderId,
            payerPubkey: verified.payerPubkey,
            paymentEventId: receiptEvent.id,
          });
        } catch (error) {
          onError?.(error);
        }
      },
      onclose: (reasons) => {
        if (reasons?.length) {
          onError?.(new Error(`Zap receipt listener closed: ${reasons.join(", ")}`));
        }
      },
    },
  );

  return () => sub.close();
}
