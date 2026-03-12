/**
 * Encrypted Drive UI Component (LitElement)
 */

import { html, LitElement } from "./lib/lit.min.js";
import {
  formatBytes,
} from "./utils.js";
import {
  uploadFile as driveUpload,
  downloadFile as driveDownload,
  listMyUploads,
  getFileAccessState,
  updateFileRecipients,
  rotateAccessKey as driveRotateAccessKey,
} from "./drive/drive.js";
import { fetchSharedFilesForRecipient, subscribeToSharesForRecipient } from "./drive/nostr.js";

export class DriveForm extends LitElement {
  static properties = {
    mode: { type: String },
    view: { state: true }, // "upload" | "download"
    status: { state: true, type: String },
    error: { state: true, type: String },
    dragging: { state: true, type: Boolean },
    selectedFile: { state: true },
    downloadHash: { state: true, type: String },
    sharedWithMe: { state: true },
    sharedPanelOpen: { state: true, type: Boolean },
    sharedUnreadCount: { state: true, type: Number },
    lastUploadUrl: { state: true, type: String },
    copiedUploadUrl: { state: true, type: Boolean },
    uploads: { state: true },
    uploadsLoading: { state: true, type: Boolean },
    uploadRecipientDrafts: { state: true },
    uploadRecipients: { state: true },
    uploadRecipientInput: { state: true, type: String },
    uploadRecipientInputs: { state: true },
    sharedExternal: { state: true },
    myPubkey: { state: true, type: String },
  };

  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
    this.mode = "upload";
    this.view = "upload";
    this.sharedWithMe = [];
    this.sharedPanelOpen = false;
    this.sharedUnreadCount = 0;
    this.lastUploadUrl = "";
    this.copiedUploadUrl = false;
    this.uploads = [];
    this.uploadsLoading = false;
    this.uploadRecipientDrafts = {};
    this.uploadRecipients = [];
    this.uploadRecipientInput = "";
    this.uploadRecipientInputs = {};
    this.sharedExternal = [];
    this.myPubkey = "";
    this._shareSubscriptionClose = null;
    this._isDestroyed = false;
  }

  async connectedCallback() {
    super.connectedCallback();
    this._isDestroyed = false;
    this.syncViewFromMode();
    this.prefillDownloadHashFromUrl();

    // Dependencies can be injected with delay, so retry briefly before failing.
    const ready = await this.waitForDependencies(7000);
    if (!ready) {
      this.error = "Nostr dependencies not ready (window.nostr or nostr-tools). Please refresh and try again.";
      return;
    }

    await this.initSharedNotifications();
    if (this.view === "uploads") {
      await this.loadUploads();
    }
  }

  updated(changedProperties) {
    if (changedProperties.has("mode")) {
      this.syncViewFromMode();
      if (this.view === "download") {
        this.prefillDownloadHashFromUrl();
      }
      if (this.view === "uploads") {
        void this.loadUploads();
      }
      if (this.view === "shared") {
        void this.loadSharedExternal();
      }
    }

    if (
      changedProperties.has("sharedUnreadCount") ||
      changedProperties.has("sharedWithMe") ||
      changedProperties.has("sharedPanelOpen")
    ) {
      this.emitNotificationState();
    }
  }

  syncViewFromMode() {
    if (this.mode === "download") {
      this.view = "download";
      return;
    }
    if (this.mode === "uploads") {
      this.view = "uploads";
      return;
    }
    if (this.mode === "shared") {
      this.view = "shared";
      return;
    }
    this.view = "upload";
  }

  isOwnedByMe(item) {
    if (!this.myPubkey || !item?.senderPubkey) return false;
    return item.senderPubkey === this.myPubkey;
  }

  async loadSharedExternal() {
    if (!(window.nostr && window.NostrTools)) return;
    const myPubkey = this.myPubkey || await window.nostr.getPublicKey();
    this.myPubkey = myPubkey;
    this.sharedExternal = this.sharedWithMe.filter((item) => item.senderPubkey !== myPubkey);

    if (this.sharedWithMe.length === 0) {
      const items = await fetchSharedFilesForRecipient(myPubkey, 100);
      this.sharedWithMe = items;
      this.sharedExternal = items.filter((item) => item.senderPubkey !== myPubkey);
    }
  }

  async loadUploads() {
    if (!(window.nostr && window.NostrTools)) return;
    this.uploadsLoading = true;

    try {
      const uploads = await listMyUploads();
      const settled = await Promise.allSettled(
        uploads.map(async (item) => {
          const access = await getFileAccessState(item.sha256);
          const recipientsExcludingOwner = access.recipients
            .filter((p) => p !== access.ownerPubkey)
            .map((p) => {
              try {
                return this.toNpub(p);
              } catch {
                return "";
              }
            })
            .filter(Boolean);

          const uniqueRecipients = [...new Set(recipientsExcludingOwner)];

          return {
            ...item,
            ownerPubkey: access.ownerPubkey,
            recipients: uniqueRecipients,
            keyListError: false,
          };
        }),
      );

      const details = settled.map((result, index) => {
        if (result.status === "fulfilled") {
          return result.value;
        }

        return {
          ...uploads[index],
          ownerPubkey: "",
          recipients: [],
          keyListError: true,
        };
      });

      this.uploads = details.sort((a, b) => (b.uploaded || 0) - (a.uploaded || 0));
      const nextDrafts = {};
      const nextInputs = {};
      for (const upload of this.uploads) {
        nextDrafts[upload.sha256] = [...(upload.recipients || [])];
        nextInputs[upload.sha256] = "";
      }
      this.uploadRecipientDrafts = nextDrafts;
      this.uploadRecipientInputs = nextInputs;
    } catch (error) {
      this.error = error.message;
    } finally {
      this.uploadsLoading = false;
    }
  }

  formatUploadDate(unixTs) {
    if (!unixTs) return "";
    return new Date(unixTs * 1000).toLocaleString();
  }

  normalizeRecipient(value) {
    return (value || "").trim();
  }

  toNpub(pubkey) {
    if (!pubkey) return "";

    if (pubkey.startsWith("npub")) {
      const decoded = window.NostrTools?.nip19?.decode?.(pubkey);
      if (!decoded || decoded.type !== "npub" || !decoded.data) {
        throw new Error("Invalid npub recipient key");
      }
      return window.NostrTools?.nip19?.npubEncode?.(decoded.data) || pubkey;
    }

    if (/^[0-9a-f]{64}$/i.test(pubkey)) {
      const encoded = window.NostrTools?.nip19?.npubEncode?.(pubkey.toLowerCase());
      if (!encoded) {
        throw new Error("Unable to convert pubkey to npub");
      }
      return encoded;
    }

    throw new Error("Recipient must be an npub or NIP-05 identifier");
  }

  async resolveRecipientToCanonical(input) {
    const value = this.normalizeRecipient(input);
    if (!value) {
      throw new Error("Recipient is empty");
    }

    if (value.startsWith("npub")) {
      return this.toNpub(value);
    }

    if (value.includes("@")) {
      const profile = await window.NostrTools?.nip05?.queryProfile?.(value);
      const resolvedHex = profile?.pubkey;
      if (!resolvedHex || !/^[0-9a-f]{64}$/i.test(resolvedHex)) {
        throw new Error(`Unable to resolve NIP-05 address: ${value}`);
      }
      return this.toNpub(resolvedHex);
    }

    throw new Error("Recipient must be npub1... or NIP-05 (name@domain)");
  }

  async addUploadRecipient() {
    const rawRecipient = this.normalizeRecipient(this.uploadRecipientInput);
    if (!rawRecipient) return;

    let recipient;
    try {
      recipient = await this.resolveRecipientToCanonical(rawRecipient);
    } catch (error) {
      this.error = error.message;
      return;
    }

    if (!recipient) return;
    if (this.uploadRecipients.includes(recipient)) {
      this.uploadRecipientInput = "";
      return;
    }

    this.uploadRecipients = [...this.uploadRecipients, recipient];
    this.uploadRecipientInput = "";
  }

  onUploadRecipientInputKeydown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      void this.addUploadRecipient();
    }
  }

  removeUploadRecipient(recipient) {
    this.uploadRecipients = this.uploadRecipients.filter((p) => p !== recipient);
  }

  setListRecipientInput(blobHash, value) {
    this.uploadRecipientInputs = {
      ...this.uploadRecipientInputs,
      [blobHash]: value,
    };
  }

  async addListRecipient(blobHash) {
    const rawRecipient = this.normalizeRecipient(this.uploadRecipientInputs[blobHash]);
    if (!rawRecipient) return;

    let recipient;
    try {
      recipient = await this.resolveRecipientToCanonical(rawRecipient);
    } catch (error) {
      this.error = error.message;
      return;
    }

    if (!recipient) return;

    const current = this.uploadRecipientDrafts[blobHash] || [];
    if (current.includes(recipient)) {
      this.setListRecipientInput(blobHash, "");
      return;
    }

    this.uploadRecipientDrafts = {
      ...this.uploadRecipientDrafts,
      [blobHash]: [...current, recipient],
    };
    this.setListRecipientInput(blobHash, "");
  }

  onListRecipientInputKeydown(e, blobHash) {
    if (e.key === "Enter") {
      e.preventDefault();
      void this.addListRecipient(blobHash);
    }
  }

  removeListRecipient(blobHash, recipient) {
    const current = this.uploadRecipientDrafts[blobHash] || [];
    this.uploadRecipientDrafts = {
      ...this.uploadRecipientDrafts,
      [blobHash]: current.filter((p) => p !== recipient),
    };
  }

  renderRecipientChips(recipients, onRemove) {
    if (!recipients || recipients.length === 0) {
      return html`<p class="text-xs text-green-700">No recipients added yet.</p>`;
    }

    return html`<div class="mt-2 flex flex-wrap gap-2">
      ${recipients.map(
        (recipient) => html`<div class="flex items-center gap-2 rounded-full border border-green-800 bg-green-950/30 px-3 py-1">
            <span class="font-mono text-xs text-green-300">${recipient}</span>
            <button
              type="button"
              @click="${() => onRemove(recipient)}"
              class="rounded-full border border-green-700 px-1 text-xs text-green-400 hover:bg-black"
              title="Remove recipient"
            >
              🗑
            </button>
          </div>`,
      )}
    </div>`;
  }

  async saveRecipients(blobHash) {
    try {
      this.error = null;
      this.status = "Updating recipients and rotating access key...";
      const recipients = this.uploadRecipientDrafts[blobHash] || [];

      await updateFileRecipients(blobHash, recipients, { rotate: true }, (stage) => {
        const stageLabels = {
          "resolving-current-access": "Resolving current file access...",
          "publishing-rotated-metadata": "Publishing rotated metadata...",
          "publishing-share": "Publishing allowlist share event...",
          "complete": "Recipients updated.",
        };
        this.status = stageLabels[stage] || stage;
      });

      await this.loadUploads();
      setTimeout(() => {
        this.status = null;
      }, 1200);
    } catch (error) {
      this.status = null;
      this.error = error.message;
    }
  }

  async regenerateKey(blobHash) {
    try {
      this.error = null;
      this.status = "Rotating access key...";
      await driveRotateAccessKey(blobHash, (stage) => {
        const stageLabels = {
          "resolving-current-access": "Resolving current file access...",
          "publishing-rotated-metadata": "Publishing rotated metadata...",
          "publishing-share": "Publishing allowlist share event...",
          "complete": "Access key rotated.",
        };
        this.status = stageLabels[stage] || stage;
      });
      await this.loadUploads();
      setTimeout(() => {
        this.status = null;
      }, 1200);
    } catch (error) {
      this.status = null;
      this.error = error.message;
    }
  }

  prefillDownloadHashFromUrl() {
    const hashFromQuery = new URLSearchParams(window.location.search).get("hash")?.trim();
    if (!hashFromQuery) return;

    // Preserve any hash the user already typed.
    if (!this.downloadHash) {
      this.downloadHash = hashFromQuery;
    }
  }

  emitNotificationState() {
    this.dispatchEvent(
      new CustomEvent("drive-notifications", {
        detail: {
          unreadCount: this.sharedUnreadCount,
          totalCount: this.sharedExternal.length,
          panelOpen: this.sharedPanelOpen,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._isDestroyed = true;
    if (this._shareSubscriptionClose) {
      this._shareSubscriptionClose();
      this._shareSubscriptionClose = null;
    }
  }

  async waitForDependencies(timeoutMs = 7000) {
    const started = Date.now();
    while ((!(window.nostr && window.NostrTools)) && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return !!(window.nostr && window.NostrTools);
  }

  shortPubkey(pubkey) {
    if (!pubkey) return "unknown";
    return `${pubkey.slice(0, 8)}...${pubkey.slice(-6)}`;
  }

  formatSharedDate(unixTs) {
    if (!unixTs) return "";
    return new Date(unixTs * 1000).toLocaleString();
  }

  async initSharedNotifications() {
    try {
      if (this._shareSubscriptionClose) {
        this._shareSubscriptionClose();
        this._shareSubscriptionClose = null;
      }

      const myPubkey = await window.nostr.getPublicKey();
      this.myPubkey = myPubkey;

      // Historical shares
      const items = await fetchSharedFilesForRecipient(myPubkey, 50);
      this.sharedWithMe = items;
      this.sharedExternal = items.filter((item) => item.senderPubkey !== myPubkey);

      // Real-time updates
      this._shareSubscriptionClose = subscribeToSharesForRecipient(myPubkey, {
        onEvent: (item) => {
          if (item.senderPubkey === myPubkey) return;

          const alreadySeen = this.sharedWithMe.some((existing) => existing.shareEventId === item.shareEventId);
          if (alreadySeen) return;

          this.sharedWithMe = [item, ...this.sharedWithMe].slice(0, 100);
          this.sharedExternal = [item, ...this.sharedExternal].slice(0, 100);
          if (!this.sharedPanelOpen) {
            this.sharedUnreadCount += 1;
          }
        },
        onError: (error) => {
          console.warn("Share subscription error:", error);

          // Best-effort auto-restart when relay closes the subscription.
          if (!this._isDestroyed && String(error?.message || "").includes("closed")) {
            setTimeout(() => {
              if (!this._isDestroyed) {
                void this.initSharedNotifications();
              }
            }, 1500);
          }
        },
      }, {
        sinceSecondsAgo: 900,
      });
    } catch (error) {
      console.warn("Unable to initialize shared file notifications:", error);
    }
  }

  toggleSharedPanel() {
    this.sharedPanelOpen = !this.sharedPanelOpen;
    if (this.sharedPanelOpen) {
      this.sharedUnreadCount = 0;
    }
  }

  async openSharedItem(item) {
    try {
      this.downloadHash = item.blobHash;
      await this.downloadHandler(new Event("submit"));
    } catch (error) {
      this.error = error.message;
    }
  }

  renderSharedPanel() {
    if (!this.sharedPanelOpen) return null;

    const visibleItems = this.sharedExternal;

    return html`
      <div class="mb-4 w-full overflow-hidden rounded-xl border border-green-900 bg-black shadow-xl">
        <div class="flex items-center justify-between border-b border-green-900 px-4 py-3">
          <h2 class="text-sm font-semibold uppercase tracking-[0.18em] text-green-400">Shared with me</h2>
          <button
            @click="${this.toggleSharedPanel}"
            class="rounded-md px-2 py-1 text-xs font-semibold text-green-500 hover:bg-green-950"
          >
            Close
          </button>
        </div>
        <div class="max-h-80 overflow-auto">
          ${visibleItems.length === 0
            ? html`<div class="px-4 py-6 text-sm text-green-700">No shared files yet.</div>`
            : visibleItems.map(
                (item) => html`<button
                  @click="${() => this.openSharedItem(item)}"
                  class="w-full border-b border-green-950 px-4 py-3 text-left hover:bg-green-950"
                >
                  <div class="truncate text-sm font-medium text-green-300">${item.fileName}</div>
                  <div class="truncate font-mono text-xs text-green-600">${item.blobHash}</div>
                  <div class="mt-1 text-xs text-green-700">
                    from ${this.shortPubkey(item.senderPubkey)} · ${this.formatSharedDate(item.sharedAt)}
                  </div>
                </button>`,
              )}
        </div>
      </div>
    `;
  }

  // Upload File
  onFileSelect(e) {
    this.selectedFile = e.target.files[0];
  }

  handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }

  handleDragEnter(e) {
    e.preventDefault();
    e.stopPropagation();
    this.dragging = true;
  }

  handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!e.currentTarget.contains(e.relatedTarget)) {
      this.dragging = false;
    }
  }

  handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    this.dragging = false;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      this.selectedFile = e.dataTransfer.files[0];
    }
  }

  async uploadHandler(e) {
    e.preventDefault();
    if (!this.selectedFile) {
      this.error = "No file selected";
      return;
    }

    try {
      this.status = "Uploading...";
      this.error = null;
      this.lastUploadUrl = "";
      this.copiedUploadUrl = false;

      const recipientsToShare = [...this.uploadRecipients];

      const result = await driveUpload(this.selectedFile, null, recipientsToShare, (stage) => {
        const stageLabels = {
          "reading-file": "Reading file...",
          "encrypting": "Encrypting...",
          "uploading": "Uploading to Blossom...",
          "publishing-metadata": "Publishing metadata event...",
          "publishing-share-event": "Publishing allowlist share event...",
          "complete": "Upload complete!",
        };
        this.status = stageLabels[stage] || stage;
      });

      if (result?.blobHash) {
        const viewUrl = new URL(window.location.href);
        viewUrl.searchParams.set("hash", result.blobHash);
        viewUrl.hash = "#view";
        this.lastUploadUrl = viewUrl.toString();
      } else {
        this.lastUploadUrl = result?.blobUrl || "";
      }

      setTimeout(() => {
        this.selectedFile = null;
        this.uploadRecipients = [];
        this.uploadRecipientInput = "";
        this.status = null;
      }, 2000);
    } catch (err) {
      this.error = err.message;
      this.status = null;
    }
  }

  async copyUploadUrl() {
    if (!this.lastUploadUrl) return;

    try {
      await navigator.clipboard.writeText(this.lastUploadUrl);
      this.copiedUploadUrl = true;
      setTimeout(() => {
        this.copiedUploadUrl = false;
      }, 1500);
    } catch (error) {
      this.error = "Unable to copy URL. Please copy it manually.";
    }
  }

  // Download File
  async downloadHandler(e) {
    e.preventDefault();
    const blobHash = this.downloadHash?.trim();
    if (!blobHash) return;

    try {
      this.status = "Downloading and decrypting...";
      this.error = null;

      const result = await driveDownload(blobHash, (stage) => {
        const stageLabels = {
          "fetching-metadata-event": "Fetching metadata event...",
          "fetching-share-event": "Fetching share event...",
          "decrypting-key": "Decrypting file key...",
          "downloading-blob": "Downloading encrypted blob...",
          "decrypting-blob": "Decrypting file...",
          "complete": "Download complete!",
        };
        this.status = stageLabels[stage] || stage;
      });

      // Trigger browser download
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.fileName;
      a.click();
      URL.revokeObjectURL(url);

      this.status = "Download complete!";
      setTimeout(() => {
        this.status = null;
        this.downloadHash = "";
      }, 1500);
    } catch (err) {
      this.error = err.message;
      this.status = null;
    }
  }


  renderUpload() {
    const preview = !this.selectedFile
      ? html`<div class="h-full w-full text-center flex flex-col items-center justify-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="w-10 h-10 text-green-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
            />
          </svg>
          <p class="pointer-none text-green-700 mt-2">
            <span class="text-sm">Drag and drop</span> file here <br />
            or <span class="text-green-500">select from computer</span>
          </p>
        </div>`
      : html`<p class="text-green-300 font-bold text-center">${this.selectedFile.name}</p>
          <p class="text-green-600 text-sm text-center">${formatBytes(this.selectedFile.size)}</p>`;

    return html`
      <div class="w-full rounded-2xl border border-green-900 bg-black px-6 pb-6 pt-7 shadow-xl sm:px-8">
        <h1 class="mb-2 text-2xl font-bold text-green-300">Upload Encrypted File</h1>
        <p class="mb-6 text-sm text-green-700">Files are encrypted locally before they are uploaded.</p>

        <form class="space-y-4" @submit="${this.uploadHandler}">
          <div>
            <label class="mb-2 block text-sm font-bold text-green-500">File</label>
            <div class="flex items-center justify-center w-full">
              <label
                class="group flex h-48 w-full cursor-pointer flex-col rounded-lg border-2 border-dashed p-10 text-center ${this
                  .dragging
                  ? "border-green-500 bg-green-950"
                  : "border-green-900 bg-black"}"
                @dragover="${this.handleDragOver}"
                @dragenter="${this.handleDragEnter}"
                @dragleave="${this.handleDragLeave}"
                @drop="${this.handleDrop}"
              >
                ${preview}
                <input type="file" class="hidden" @change="${this.onFileSelect}" />
              </label>
            </div>
          </div>

          <div>
            <label class="text-sm font-bold text-green-500">Share with pubkeys (optional)</label>
            <div class="mt-1 flex gap-2">
              <input
                type="text"
                class="block w-full rounded-md border border-green-900 bg-black p-3 font-mono text-xs text-green-400"
                placeholder="npub1abc... or name@domain.com"
                .value="${this.uploadRecipientInput || ""}"
                @input="${(e) => (this.uploadRecipientInput = e.target.value)}"
                @keydown="${this.onUploadRecipientInputKeydown}"
              />
              <button
                type="button"
                @click="${() => this.addUploadRecipient()}"
                class="rounded-md border border-green-700 px-4 py-2 text-lg font-semibold text-green-300 hover:bg-green-950"
                title="Add recipient"
              >
                +
              </button>
            </div>
            ${this.renderRecipientChips(this.uploadRecipients, (recipient) => this.removeUploadRecipient(recipient))}
          </div>

          <button
            type="submit"
            class="w-full rounded-lg bg-green-500 py-3 font-semibold text-black transition hover:bg-green-400"
          >
            Upload & Encrypt
          </button>
        </form>

        ${this.lastUploadUrl
          ? html`<div class="mt-4 rounded-lg border border-green-800 bg-black p-3">
              <p class="text-xs font-semibold uppercase tracking-wider text-green-600">Uploaded file URL</p>
              <div class="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                <a
                  href="${this.lastUploadUrl}"
                  target="_blank"
                  rel="noreferrer"
                  class="truncate font-mono text-sm text-green-300 underline"
                >
                  ${this.lastUploadUrl}
                </a>
                <button
                  type="button"
                  @click="${this.copyUploadUrl}"
                  class="rounded-md border border-green-700 px-3 py-1 text-sm text-green-300 hover:bg-green-950"
                >
                  ${this.copiedUploadUrl ? "Copied" : "Copy URL"}
                </button>
              </div>
            </div>`
          : null}
      </div>
    `;
  }

  renderDownload() {
    return html`
      <div class="w-full rounded-2xl border border-green-900 bg-black px-6 pb-6 pt-7 shadow-xl sm:px-8">
        <h1 class="mb-2 text-2xl font-bold text-green-300">View File by Hash</h1>
        <p class="mb-6 text-sm text-green-700">Fetch encrypted bytes from Blossom and decrypt locally.</p>

        <form class="space-y-4" @submit="${this.downloadHandler}">
          <label class="text-sm font-bold text-green-500">
            Encrypted Blob Hash (SHA256)
            <input
              type="text"
              name="download-hash"
              class="mt-1 block w-full rounded-md border border-green-900 bg-black p-3 font-mono text-xs text-green-400"
              placeholder="a1b2c3d4e5f6..."
              .value="${this.downloadHash || ""}"
              @change="${(e) => (this.downloadHash = e.target.value)}"
              required
            />
          </label>

          <button
            type="submit"
            class="w-full rounded-lg bg-green-500 py-3 font-semibold text-black transition hover:bg-green-400"
          >
            Download Decrypted File
          </button>
        </form>

        <p class="mt-4 text-xs text-green-700">
          This flow fetches metadata + share events from Nostr, downloads encrypted bytes from Blossom by hash,
          decrypts locally, then saves plaintext to your computer.
        </p>
      </div>
    `;
  }

  renderUploads() {
    return html`
      <div class="w-full rounded-2xl border border-green-900 bg-black px-6 pb-6 pt-7 shadow-xl sm:px-8">
        <div class="mb-6 flex items-center justify-between gap-3">
          <div>
            <h1 class="mb-2 text-2xl font-bold text-green-300">My Uploads</h1>
            <p class="text-sm text-green-700">Manage recipient allowlist and rotate access keys without reuploading blobs.</p>
          </div>
          <button
            type="button"
            @click="${() => this.loadUploads()}"
            class="rounded-md border border-green-700 px-3 py-2 text-sm text-green-300 hover:bg-green-950"
          >
            Refresh
          </button>
        </div>

        ${this.uploadsLoading
          ? html`<p class="text-sm text-green-600">Loading uploads...</p>`
          : this.uploads.length === 0
            ? html`<p class="text-sm text-green-700">No uploads found for this account.</p>`
            : html`${this.uploads.map(
                (item) => html`
                  <div class="mb-4 rounded-lg border border-green-900 bg-black p-4">
                    <div class="mb-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <div class="font-mono text-xs text-green-500">${item.sha256}</div>
                      <div class="text-xs text-green-700">${formatBytes(item.size || 0)} · ${this.formatUploadDate(item.uploaded)}</div>
                    </div>

                    ${item.keyListError
                      ? html`<p class="mb-2 text-xs text-amber-500">Unable to fetch recipients from relays. You can still set and save a new allowlist.</p>`
                      : null}

                    <label class="mb-2 block text-xs font-semibold uppercase tracking-wide text-green-600">
                      Allowed recipients (owner is always retained)
                    </label>
                    <div class="mb-2 flex gap-2">
                      <input
                        type="text"
                        class="block w-full rounded-md border border-green-900 bg-black p-3 font-mono text-xs text-green-400"
                        placeholder="npub1abc... or name@domain.com"
                        .value="${this.uploadRecipientInputs[item.sha256] || ""}"
                        @input="${(e) => this.setListRecipientInput(item.sha256, e.target.value)}"
                        @keydown="${(e) => this.onListRecipientInputKeydown(e, item.sha256)}"
                      />
                      <button
                        type="button"
                        @click="${() => this.addListRecipient(item.sha256)}"
                        class="rounded-md border border-green-700 px-4 py-2 text-lg font-semibold text-green-300 hover:bg-green-950"
                        title="Add recipient"
                      >
                        +
                      </button>
                    </div>

                    ${this.renderRecipientChips(
                      this.uploadRecipientDrafts[item.sha256] || [],
                      (recipient) => this.removeListRecipient(item.sha256, recipient),
                    )}

                    <div class="flex flex-wrap gap-2">
                      <button
                        type="button"
                        @click="${() => this.saveRecipients(item.sha256)}"
                        class="rounded-md bg-green-500 px-3 py-2 text-sm font-semibold text-black hover:bg-green-400"
                      >
                        Save Recipients + Regenerate Key
                      </button>
                      <button
                        type="button"
                        @click="${() => this.regenerateKey(item.sha256)}"
                        class="rounded-md border border-green-700 px-3 py-2 text-sm text-green-300 hover:bg-green-950"
                      >
                        Regenerate Key Only
                      </button>
                    </div>
                  </div>
                `,
              )}`}
      </div>
    `;
  }

  renderSharedView() {
    return html`
      <div class="w-full rounded-2xl border border-green-900 bg-black px-6 pb-6 pt-7 shadow-xl sm:px-8">
        <div class="mb-6 flex items-center justify-between gap-3">
          <div>
            <h1 class="mb-2 text-2xl font-bold text-green-300">Shared With Me</h1>
            <p class="text-sm text-green-700">Files shared by other users. Your own uploads are excluded.</p>
          </div>
          <button
            type="button"
            @click="${() => this.loadSharedExternal()}"
            class="rounded-md border border-green-700 px-3 py-2 text-sm text-green-300 hover:bg-green-950"
          >
            Refresh
          </button>
        </div>

        ${this.sharedExternal.length === 0
          ? html`<p class="text-sm text-green-700">No files shared with you yet.</p>`
          : html`${this.sharedExternal.map(
              (item) => html`
                <div class="mb-3 rounded-lg border border-green-900 bg-black p-4">
                  <div class="truncate text-sm font-medium text-green-300">${item.fileName}</div>
                  <div class="mt-1 truncate font-mono text-xs text-green-600">${item.blobHash}</div>
                  <div class="mt-1 text-xs text-green-700">
                    from ${this.shortPubkey(item.senderPubkey)} · ${this.formatSharedDate(item.sharedAt)}
                  </div>
                  <div class="mt-3">
                    <button
                      type="button"
                      @click="${() => this.openSharedItem(item)}"
                      class="rounded-md bg-green-500 px-3 py-2 text-sm font-semibold text-black hover:bg-green-400"
                    >
                      Open File
                    </button>
                  </div>
                </div>
              `,
            )}`}
      </div>
    `;
  }

  render() {
    let content = this.renderUpload();
    if (this.view === "download") {
      content = this.renderDownload();
    } else if (this.view === "uploads") {
      content = this.renderUploads();
    } else if (this.view === "shared") {
      content = this.renderSharedView();
    }

    const statusBar = this.status
      ? html`<div class="fixed bottom-4 right-4 rounded border border-green-700 bg-black p-4 text-green-400">
          ${this.status}
        </div>`
      : null;

    const errorBar = this.error
        ? html`<div class="fixed bottom-4 right-4 rounded border border-green-700 bg-black p-4 text-green-400">
          <span>${this.error}</span>
          <button
            @click="${() => (this.error = null)}"
            class="ml-2 font-bold cursor-pointer"
          >
            ✕
          </button>
        </div>`
      : null;

    return html`
      <div class="relative w-full">
        ${window.nostr ? this.renderSharedPanel() : null}
        <div class="relative z-10 w-full sm:max-w-2xl">
          ${content}
        </div>
        ${statusBar}
        ${errorBar}
      </div>
    `;
  }
}

customElements.define("encrypted-drive", DriveForm);
