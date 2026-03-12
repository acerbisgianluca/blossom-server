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
  }

  updated(changedProperties) {
    if (changedProperties.has("mode")) {
      this.syncViewFromMode();
      if (this.view === "download") {
        this.prefillDownloadHashFromUrl();
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
    this.view = this.mode === "download" ? "download" : "upload";
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
          totalCount: this.sharedWithMe.length,
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

      // Historical shares
      const items = await fetchSharedFilesForRecipient(myPubkey, 50);
      this.sharedWithMe = items;

      // Real-time updates
      this._shareSubscriptionClose = subscribeToSharesForRecipient(myPubkey, {
        onEvent: (item) => {
          const alreadySeen = this.sharedWithMe.some((existing) => existing.shareEventId === item.shareEventId);
          if (alreadySeen) return;

          this.sharedWithMe = [item, ...this.sharedWithMe].slice(0, 100);
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
          ${this.sharedWithMe.length === 0
            ? html`<div class="px-4 py-6 text-sm text-green-700">No shared files yet.</div>`
            : this.sharedWithMe.map(
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

      const recipients = document.querySelector("[name='upload-recipients']")?.value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s) || [];

      const result = await driveUpload(this.selectedFile, null, recipients, (stage) => {
        const stageLabels = {
          "reading-file": "Reading file...",
          "encrypting": "Encrypting...",
          "uploading": "Uploading to Blossom...",
          "publishing-metadata": "Publishing metadata event...",
          "publishing-owner-share": "Publishing owner share event...",
          "publishing-recipient-shares": "Publishing recipient shares...",
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

          <label class="text-sm font-bold text-green-500">
            Share with pubkeys (optional, comma-separated)
            <textarea
              name="upload-recipients"
              class="mt-1 block h-20 w-full rounded-md border border-green-900 bg-black p-3 font-mono text-xs text-green-400"
              placeholder="npub1abc...,npub1def..."
            ></textarea>
          </label>

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

  render() {
    const content = this.view === "download" ? this.renderDownload() : this.renderUpload();

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
