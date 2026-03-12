/**
 * Folder-centric encrypted drive UI.
 */

import { html, LitElement } from "./lib/lit.min.js";
import { formatBytes } from "./utils.js";
import {
  createFolder,
  downloadFile,
  getFolderRecipients,
  listFiles,
  listFolders,
  listSharedWithMe,
  revokeUser,
  rotateFolderKey,
  shareFolder,
  uploadFiles,
} from "./drive/drive.js";
import { subscribeToFolderSharesForRecipient, fetchUserProfile } from "./drive/nostr.js";

function stageToPercent(stage) {
  switch (stage) {
    case "reading-file":
      return 10;
    case "encrypting":
      return 35;
    case "uploading":
      return 70;
    case "publishing-metadata":
      return 90;
    case "complete":
      return 100;
    default:
      return 0;
  }
}

export class DriveForm extends LitElement {
  static properties = {
    mode: { type: String },
    status: { state: true, type: String },
    error: { state: true, type: String },
    dragging: { state: true, type: Boolean },
    myPubkey: { state: true, type: String },
    ownedFolders: { state: true },
    sharedFolders: { state: true },
    selectedFolder: { state: true },
    folderFiles: { state: true },
    filesLoading: { state: true, type: Boolean },
    sidebarLoading: { state: true, type: Boolean },
    uploadQueue: { state: true },
    uploadProgress: { state: true },
    createFolderOpen: { state: true, type: Boolean },
    createFolderName: { state: true, type: String },
    createFolderRecipients: { state: true },
    createFolderRecipientInput: { state: true, type: String },
    selectedFolderRecipients: { state: true },
    selectedFolderRecipientInput: { state: true, type: String },
    sharedPanelOpen: { state: true, type: Boolean },
    sharedUnreadCount: { state: true, type: Number },
  };

  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
    this.mode = "upload";
    this.status = "";
    this.error = "";
    this.dragging = false;
    this.myPubkey = "";
    this.ownedFolders = [];
    this.sharedFolders = [];
    this.selectedFolder = null;
    this.folderFiles = [];
    this.filesLoading = false;
    this.sidebarLoading = false;
    this.uploadQueue = [];
    this.uploadProgress = {};
    this.createFolderOpen = false;
    this.createFolderName = "";
    this.createFolderRecipients = [];
    this.createFolderRecipientInput = "";
    this.selectedFolderRecipients = [];
    this.selectedFolderRecipientInput = "";
    this.sharedPanelOpen = false;
    this.sharedUnreadCount = 0;
    this._shareSubscriptionClose = null;
    this._isDestroyed = false;
    this._profileCache = {}; // Cache for user profiles
  }

  async connectedCallback() {
    super.connectedCallback();
    this._isDestroyed = false;

    const ready = await this.waitForDependencies(7000);
    if (!ready) {
      this.error = "Nostr dependencies not ready (window.nostr or nostr-tools). Please refresh and try again.";
      return;
    }

    this.myPubkey = await window.nostr.getPublicKey();
    // Normalize to hex — some extensions return npub, but relay event pubkeys are always hex
    if (this.myPubkey?.startsWith("npub")) {
      const decoded = window.NostrTools?.nip19?.decode?.(this.myPubkey);
      if (decoded?.data) this.myPubkey = decoded.data;
    }
    await this.refreshSidebarData();
    this.startShareSubscription();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._isDestroyed = true;
    if (this._shareSubscriptionClose) {
      this._shareSubscriptionClose();
      this._shareSubscriptionClose = null;
    }
  }

  updated(changedProperties) {
    if (changedProperties.has("mode")) {
      if (this.mode === "shared") {
        if (this.sharedFolders.length > 0) {
          const preferred = this.sharedFolders[0];
          if (
            !this.selectedFolder
            || this.selectedFolder.source !== "shared"
            || this.selectedFolder.folderId !== preferred.folderId
            || this.selectedFolder.ownerPubkey !== preferred.ownerPubkey
          ) {
            void this.selectFolder(preferred);
          }
        } else {
          this.selectedFolder = null;
          this.folderFiles = [];
        }
      } else {
        const preferred = this.ownedFolders[0];
        if (preferred && (!this.selectedFolder || this.selectedFolder.source !== preferred.source)) {
          void this.selectFolder(preferred);
        }
      }
    }

    if (
      changedProperties.has("sharedUnreadCount") ||
      changedProperties.has("sharedFolders") ||
      changedProperties.has("sharedPanelOpen")
    ) {
      this.emitNotificationState();
    }
  }

  async waitForDependencies(timeoutMs = 7000) {
    const started = Date.now();
    while ((!(window.nostr && window.NostrTools)) && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return !!(window.nostr && window.NostrTools);
  }

  emitNotificationState() {
    this.dispatchEvent(
      new CustomEvent("drive-notifications", {
        detail: {
          unreadCount: this.sharedUnreadCount,
          totalCount: this.sharedFolders.length,
          panelOpen: this.sharedPanelOpen,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  toggleSharedPanel() {
    this.sharedPanelOpen = !this.sharedPanelOpen;
    if (this.sharedPanelOpen) {
      this.sharedUnreadCount = 0;
    }
  }

  startShareSubscription() {
    if (this._shareSubscriptionClose) {
      this._shareSubscriptionClose();
      this._shareSubscriptionClose = null;
    }

    this._shareSubscriptionClose = subscribeToFolderSharesForRecipient(this.myPubkey, {
      onEvent: async (event) => {
        if (event.pubkey === this.myPubkey) return;
        await this.refreshSharedFoldersOnly();
        if (!this.sharedPanelOpen) {
          this.sharedUnreadCount += 1;
        }
      },
      onError: (error) => {
        console.warn("Folder share subscription error:", error);
      },
    }, { sinceSecondsAgo: 900 });
  }

  async refreshSharedFoldersOnly() {
    const sharedFolders = await listSharedWithMe();
    this.sharedFolders = sharedFolders;

    if (this.selectedFolder && this.selectedFolder.source === "shared") {
      const selected = sharedFolders.find(
        (folder) => folder.folderId === this.selectedFolder.folderId && folder.ownerPubkey === this.selectedFolder.ownerPubkey,
      );
      if (selected) {
        await this.selectFolder({ ...selected, source: "shared" });
      }
    }
  }

  async refreshSidebarData() {
    this.sidebarLoading = true;

    try {
      const [ownedFolders, sharedFolders] = await Promise.all([
        listFolders(),
        listSharedWithMe(),
      ]);

      this.ownedFolders = ownedFolders.map((folder) => ({ ...folder, source: "owned" }));
      this.sharedFolders = sharedFolders.map((folder) => ({ ...folder, source: "shared" }));

      const allFolders = [...this.ownedFolders, ...this.sharedFolders];
      if (!this.selectedFolder && allFolders.length > 0) {
        const preferred = this.mode === "shared" ? this.sharedFolders[0] || this.ownedFolders[0] : this.ownedFolders[0] || this.sharedFolders[0];
        if (preferred) {
          await this.selectFolder(preferred);
        }
      } else if (this.selectedFolder) {
        const updatedSelection = allFolders.find(
          (folder) => folder.folderId === this.selectedFolder.folderId && folder.ownerPubkey === this.selectedFolder.ownerPubkey,
        );
        if (updatedSelection) {
          await this.selectFolder(updatedSelection);
        } else if (allFolders.length > 0) {
          await this.selectFolder(allFolders[0]);
        } else {
          this.selectedFolder = null;
          this.folderFiles = [];
        }
      }
    } catch (error) {
      this.error = error.message;
    } finally {
      this.sidebarLoading = false;
    }
  }

  async selectFolder(folder) {
    if (!folder) return;

    this.selectedFolder = folder;
    this.filesLoading = true;

    try {
      const files = await listFiles(folder.folderId, folder.ownerPubkey);
      this.folderFiles = files;

      if (folder.ownerPubkey === this.myPubkey) {
        const recipients = await getFolderRecipients(folder.folderId, folder.ownerPubkey);
        const filteredRecipients = recipients
          .filter((recipient) => recipient !== this.myPubkey)
          .map((recipient) => this.toNpub(recipient));
        this.selectedFolderRecipients = [...new Set(filteredRecipients)];
      } else {
        this.selectedFolderRecipients = [];
      }
    } catch (error) {
      this.error = error.message;
    } finally {
      this.filesLoading = false;
    }
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

    throw new Error("Recipient must be npub1... or NIP-05 (name@domain)");
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

  async addCreateFolderRecipient() {
    try {
      const recipient = await this.resolveRecipientToCanonical(this.createFolderRecipientInput);
      if (!this.createFolderRecipients.includes(recipient)) {
        this.createFolderRecipients = [...this.createFolderRecipients, recipient];
      }
      this.createFolderRecipientInput = "";
    } catch (error) {
      this.error = error.message;
    }
  }

  removeCreateFolderRecipient(recipient) {
    this.createFolderRecipients = this.createFolderRecipients.filter((item) => item !== recipient);
  }

  async addSelectedFolderRecipient() {
    try {
      const recipient = await this.resolveRecipientToCanonical(this.selectedFolderRecipientInput);
      if (!this.selectedFolderRecipients.includes(recipient)) {
        this.selectedFolderRecipients = [...this.selectedFolderRecipients, recipient];
      }
      this.selectedFolderRecipientInput = "";
    } catch (error) {
      this.error = error.message;
    }
  }

  removeSelectedFolderRecipient(recipient) {
    this.selectedFolderRecipients = this.selectedFolderRecipients.filter((item) => item !== recipient);
  }

  onCreateFolderRecipientKeydown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      void this.addCreateFolderRecipient();
    }
  }

  onSelectedFolderRecipientKeydown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      void this.addSelectedFolderRecipient();
    }
  }

  renderRecipientChips(recipients, onRemove) {
    if (!recipients || recipients.length === 0) {
      return html`<p class="text-xs text-green-700">No recipients added yet.</p>`;
    }

    return html`<div class="mt-2 flex flex-wrap gap-2">
      ${recipients.map(
        (recipient) => html`<div class="flex items-center gap-2 rounded-full border border-green-800 bg-green-950/30 px-3 py-1">
            <span class="text-xs text-green-300">${this.shortPubkey(recipient)}</span>
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

  openCreateFolderForm() {
    this.createFolderOpen = !this.createFolderOpen;
  }

  async createFolderHandler(e) {
    e.preventDefault();
    try {
      this.error = "";
      this.status = "Creating folder...";
      const folder = await createFolder(this.createFolderName || "Untitled Folder", this.createFolderRecipients);
      this.createFolderName = "";
      this.createFolderRecipients = [];
      this.createFolderRecipientInput = "";
      this.createFolderOpen = false;
      await this.refreshSidebarData();
      await this.selectFolder({
        folderId: folder.folderId,
        folderName: folder.folderName,
        ownerPubkey: folder.ownerPubkey,
        createdAt: Date.now() / 1000,
        fileCount: 0,
        source: "owned",
      });
      this.status = "Folder created.";
    } catch (error) {
      this.error = error.message;
      this.status = "";
    }
  }

  triggerFilePicker() {
    this.querySelector("#folder-upload-input")?.click();
  }

  onFileSelect(e) {
    const files = Array.from(e.target.files || []);
    this.uploadQueue = [...this.uploadQueue, ...files];
    e.target.value = "";
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
    this.uploadQueue = [...this.uploadQueue, ...Array.from(e.dataTransfer.files || [])];
  }

  removeQueuedFile(index) {
    this.uploadQueue = this.uploadQueue.filter((_, itemIndex) => itemIndex !== index);
  }

  canUploadToSelectedFolder() {
    return this.selectedFolder && this.selectedFolder.ownerPubkey === this.myPubkey;
  }

  async uploadHandler() {
    if (this.uploadQueue.length === 0) {
      this.error = "No files selected";
      return;
    }

    if (this.selectedFolder && this.selectedFolder.ownerPubkey !== this.myPubkey) {
      this.error = "You can only upload into folders you own";
      return;
    }

    this.error = "";
    this.status = "Uploading files...";
    this.uploadProgress = {};

    try {
      const result = await uploadFiles(
        this.selectedFolder?.folderId || null,
        this.uploadQueue,
        {},
        ({ index, fileName, stage, blobHash }) => {
          const key = `${index}:${fileName}`;
          this.uploadProgress = {
            ...this.uploadProgress,
            [key]: {
              stage,
              percent: stageToPercent(stage),
              blobHash: blobHash || null,
              fileName,
            },
          };
        },
      );

      await this.refreshSidebarData();
      const targetFolder = this.ownedFolders.find((folder) => folder.folderId === result.folderId)
        || this.sharedFolders.find((folder) => folder.folderId === result.folderId);
      if (targetFolder) {
        await this.selectFolder(targetFolder);
      }

      this.uploadQueue = [];
      this.status = `Uploaded ${result.files.length} file${result.files.length === 1 ? "" : "s"}.`;
    } catch (error) {
      this.error = error.message;
      this.status = "";
    }
  }

  async waitForFolderRecipients(folderId, ownerPubkey, expectedRecipients, attempts = 6, delayMs = 400) {
    const expected = [...expectedRecipients].sort();

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const recipients = await getFolderRecipients(folderId, ownerPubkey);
      const normalized = recipients
        .filter((recipient) => recipient !== this.myPubkey)
        .map((recipient) => this.toNpub(recipient))
        .sort();

      if (normalized.length === expected.length && normalized.every((recipient, index) => recipient === expected[index])) {
        return true;
      }

      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return false;
  }

  async saveFolderAccess() {
    if (!this.selectedFolder) return;

    try {
      this.error = "";
      this.status = "Updating folder access...";
      const currentRecipients = await getFolderRecipients(this.selectedFolder.folderId, this.selectedFolder.ownerPubkey);
      const currentAsNpub = currentRecipients
        .filter((recipient) => recipient !== this.myPubkey)
        .map((recipient) => this.toNpub(recipient));
      const currentRecipientSet = new Set(currentAsNpub);
      const targetRecipientSet = new Set(this.selectedFolderRecipients);

      for (const recipient of this.selectedFolderRecipients) {
        if (!currentRecipientSet.has(recipient)) {
          await shareFolder(this.selectedFolder.folderId, recipient, this.selectedFolder.ownerPubkey);
        }
      }

      for (const recipient of currentAsNpub) {
        if (!targetRecipientSet.has(recipient)) {
          await revokeUser(this.selectedFolder.folderId, recipient, this.selectedFolder.ownerPubkey);
        }
      }

      await this.waitForFolderRecipients(
        this.selectedFolder.folderId,
        this.selectedFolder.ownerPubkey,
        this.selectedFolderRecipients,
      );
      await this.selectFolder(this.selectedFolder);
      await this.refreshSidebarData();
      this.status = "Folder access updated.";
    } catch (error) {
      this.error = error.message;
      this.status = "";
    }
  }

  async rotateSelectedFolderKey() {
    if (!this.selectedFolder) return;

    try {
      this.error = "";
      this.status = "Rotating folder key...";
      await rotateFolderKey(this.selectedFolder.folderId, this.selectedFolder.ownerPubkey);
      await this.selectFolder(this.selectedFolder);
      this.status = "Folder key rotated.";
    } catch (error) {
      this.error = error.message;
      this.status = "";
    }
  }

  async downloadItem(fileItem) {
    try {
      this.error = "";
      this.status = `Downloading ${fileItem.fileName}...`;
      const result = await downloadFile(fileItem.blobHash);
      const url = URL.createObjectURL(result.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      this.status = `Downloaded ${fileItem.fileName}.`;
    } catch (error) {
      this.error = error.message;
      this.status = "";
    }
  }

  async downloadAllFiles() {
    if (this.folderFiles.length === 0) return;
    this.error = "";
    this.status = `Downloading ${this.folderFiles.length} files...`;
    let downloaded = 0;
    for (const fileItem of this.folderFiles) {
      try {
        const result = await downloadFile(fileItem.blobHash);
        const url = URL.createObjectURL(result.blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = result.fileName;
        anchor.click();
        URL.revokeObjectURL(url);
        downloaded += 1;
        this.status = `Downloading files… ${downloaded}/${this.folderFiles.length}`;
      } catch (error) {
        this.error = `Failed to download ${fileItem.fileName}: ${error.message}`;
      }
    }
    this.status = `Downloaded ${downloaded} file${downloaded === 1 ? "" : "s"}.`;
  }

  formatDate(unixTs) {
    if (!unixTs) return "";
    return new Date(unixTs * 1000).toLocaleString();
  }

  hexToNpub(hex) {
    if (!hex) return "";
    
    // If already npub, return as-is
    if (hex?.startsWith("npub")) {
      return hex;
    }
    
    // Convert hex to npub
    if (/^[0-9a-f]{64}$/i.test(hex)) {
      const encoded = window.NostrTools?.nip19?.npubEncode?.(hex.toLowerCase());
      return encoded || hex;
    }
    
    return hex;
  }

  async getProfileName(pubkey) {
    if (!pubkey) return "unknown";
    
    // Normalize to hex
    let hexPubkey = pubkey;
    if (pubkey?.startsWith("npub")) {
      const decoded = window.NostrTools?.nip19?.decode?.(pubkey);
      hexPubkey = decoded?.data || pubkey;
    }
    
    // Check cache first
    if (this._profileCache[hexPubkey]) {
      const profile = this._profileCache[hexPubkey];
      if (profile.name) return profile.name;
    }
    
    // Fetch on demand
    try {
      const profile = await fetchUserProfile(hexPubkey);
      if (profile) {
        this._profileCache[hexPubkey] = profile;
        if (profile.name) return profile.name;
        if (profile.display_name) return profile.display_name;
      }
    } catch (error) {
      console.warn("Failed to fetch profile:", error);
    }
    
    return null;
  }

  shortPubkey(pubkey) {
    if (!pubkey) return "unknown";

    const npub = this.hexToNpub(pubkey);
    const shortNpub = `${npub.slice(0, 12)}...${npub.slice(-4)}`;

    // Normalize to hex for cache lookup
    let hexPubkey = pubkey;
    if (pubkey?.startsWith("npub")) {
      const decoded = window.NostrTools?.nip19?.decode?.(pubkey);
      hexPubkey = decoded?.data || pubkey;
    }

    // Check if we have a cached profile name
    const cached = this._profileCache[hexPubkey];
    if (cached?.name) {
      return `${cached.name} (${shortNpub})`;
    }

    // Try to fetch profile (non-blocking, updates UI when ready)
    this.getProfileName(pubkey).then((name) => {
      if (name) {
        this.requestUpdate();
      }
    }).catch(() => {
      // Ignore errors
    });

    // Fall back to npub1 shortened format
    return shortNpub;
  }

  renderSharedPanel() {
    if (!this.sharedPanelOpen) return null;

    return html`
      <div class="mb-4 overflow-hidden rounded-xl border border-green-900 bg-black shadow-xl">
        <div class="flex items-center justify-between border-b border-green-900 px-4 py-3">
          <h2 class="text-sm font-semibold uppercase tracking-[0.18em] text-green-400">Shared folders</h2>
          <button
            @click="${() => this.toggleSharedPanel()}"
            class="rounded-md px-2 py-1 text-xs font-semibold text-green-500 hover:bg-green-950"
          >
            Close
          </button>
        </div>
        <div class="max-h-80 overflow-auto">
          ${this.sharedFolders.length === 0
            ? html`<div class="px-4 py-6 text-sm text-green-700">No shared folders yet.</div>`
            : this.sharedFolders.map(
                (folder) => html`<button
                  @click="${() => this.selectFolder({ ...folder, source: "shared" })}"
                  class="w-full border-b border-green-950 px-4 py-3 text-left hover:bg-green-950"
                >
                  <div class="truncate text-sm font-medium text-green-300">${folder.folderName}</div>
                  <div class="mt-1 text-xs text-green-700">
                    from ${this.shortPubkey(folder.ownerPubkey)} · ${folder.fileCount} files
                  </div>
                </button>`,
              )}
        </div>
      </div>
    `;
  }

  renderSidebarSection(title, folders) {
    const isSharedSection = title === "Shared With Me";
    const isFoldersSection = title === "Folders";
    if (this.mode === "upload" && isSharedSection) return null;
    if (this.mode === "shared" && isFoldersSection) return null;

    if (this.sidebarLoading) {
      return html`<p class="px-1 py-2 text-sm text-green-700">Loading…</p>`;
    }

    if (folders.length === 0) {
      return html`<p class="px-1 py-2 text-sm text-green-700">No folders yet.</p>`;
    }

    return html`
      <div class="space-y-0.5">
        ${folders.map(
          (folder) => html`<button
            type="button"
            @click="${() => this.selectFolder(folder)}"
            class="w-full rounded-lg px-3 py-2.5 text-left transition ${this.selectedFolder
              && this.selectedFolder.folderId === folder.folderId
              && this.selectedFolder.ownerPubkey === folder.ownerPubkey
              ? "bg-green-950/60 ring-1 ring-green-600"
              : "hover:bg-green-950/40"}"
          >
            <div class="truncate text-sm font-medium text-green-300">${folder.folderName}</div>
            <div class="mt-0.5 text-xs text-green-700">${folder.fileCount} file${folder.fileCount === 1 ? "" : "s"}</div>
          </button>`,
        )}
      </div>
    `;
  }

  renderCreateFolderPanel() {
    if (!this.createFolderOpen) return null;

    return html`
      <div class="border-b border-green-900 bg-green-950/20 p-3">
        <form @submit="${(e) => this.createFolderHandler(e)}">
          <label class="mb-2 block text-xs font-semibold uppercase tracking-wide text-green-600">
            Folder name
            <input
              type="text"
              class="mt-1 block w-full rounded-md border border-green-900 bg-black p-2 text-sm text-green-300"
              placeholder="Holiday Upload"
              .value="${this.createFolderName}"
              @input="${(e) => (this.createFolderName = e.target.value)}"
            />
          </label>

          <label class="text-xs font-semibold uppercase tracking-wide text-green-600">
            Share with (optional)
          </label>
          <div class="mt-1 flex gap-1.5">
            <input
              type="text"
              class="block w-full rounded-md border border-green-900 bg-black p-2 font-mono text-xs text-green-400"
              placeholder="npub1… or name@domain"
              .value="${this.createFolderRecipientInput}"
              @input="${(e) => (this.createFolderRecipientInput = e.target.value)}"
              @keydown="${this.onCreateFolderRecipientKeydown}"
            />
            <button
              type="button"
              @click="${() => this.addCreateFolderRecipient()}"
              class="rounded-md border border-green-700 px-3 py-1.5 text-sm font-semibold text-green-300 hover:bg-green-950"
            >+</button>
          </div>
          ${this.renderRecipientChips(this.createFolderRecipients, (recipient) => this.removeCreateFolderRecipient(recipient))}

          <div class="mt-3 flex gap-2">
            <button
              type="submit"
              class="flex-1 rounded-md bg-green-500 px-3 py-1.5 text-sm font-semibold text-black hover:bg-green-400"
            >
              Create
            </button>
            <button
              type="button"
              @click="${() => this.openCreateFolderForm()}"
              class="rounded-md border border-green-700 px-3 py-1.5 text-sm text-green-300 hover:bg-green-950"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    `;
  }

  renderUploadQueue() {
    return html`
      <div class="rounded-xl border border-green-900 bg-black p-4">
        <div class="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 class="text-sm font-semibold uppercase tracking-[0.18em] text-green-400">Upload Files</h3>
            <p class="text-xs text-green-700">
              ${this.selectedFolder && this.selectedFolder.ownerPubkey === this.myPubkey
                ? `Uploading into ${this.selectedFolder.folderName}`
                : "No owned folder selected. A new encrypted folder will be created automatically."}
            </p>
          </div>
          <div class="flex gap-2">
            <button
              type="button"
              @click="${() => this.triggerFilePicker()}"
              class="rounded-md border border-green-700 px-3 py-2 text-sm text-green-300 hover:bg-green-950"
            >
              Choose Files
            </button>
            <button
              type="button"
              @click="${() => this.uploadHandler()}"
              class="rounded-md bg-green-500 px-3 py-2 text-sm font-semibold text-black hover:bg-green-400"
            >
              Upload Files
            </button>
          </div>
        </div>

        <label
          class="block rounded-lg border-2 border-dashed p-6 text-center ${this.dragging ? "border-green-500 bg-green-950" : "border-green-900 bg-black"}"
          @dragover="${this.handleDragOver}"
          @dragenter="${this.handleDragEnter}"
          @dragleave="${this.handleDragLeave}"
          @drop="${this.handleDrop}"
        >
          <p class="text-sm text-green-600">Drag and drop multiple files here</p>
          <p class="mt-1 text-xs text-green-700">Files are encrypted locally, wrapped with the folder key, then uploaded to Blossom.</p>
          <input id="folder-upload-input" type="file" class="hidden" multiple @change="${this.onFileSelect}" />
        </label>

        ${this.uploadQueue.length === 0
          ? html`<p class="mt-3 text-xs text-green-700">No files queued.</p>`
          : html`<div class="mt-3 space-y-3">
              ${this.uploadQueue.map((file, index) => {
                const progress = this.uploadProgress[`${index}:${file.name}`];
                return html`<div class="rounded-lg border border-green-900 p-3">
                  <div class="flex items-center justify-between gap-3">
                    <div>
                      <div class="text-sm text-green-300">${file.name}</div>
                      <div class="text-xs text-green-700">${formatBytes(file.size)}</div>
                    </div>
                    <button
                      type="button"
                      @click="${() => this.removeQueuedFile(index)}"
                      class="rounded-md border border-green-700 px-2 py-1 text-xs text-green-300 hover:bg-green-950"
                    >
                      Remove
                    </button>
                  </div>
                  <div class="mt-2 h-2 overflow-hidden rounded-full bg-green-950">
                    <div class="h-full bg-green-500 transition-all" style="width: ${progress?.percent || 0}%"></div>
                  </div>
                  <div class="mt-1 text-xs text-green-700">${progress?.stage || "queued"}</div>
                </div>`;
              })}
            </div>`}
      </div>
    `;
  }

  renderFolderAccessPanel() {
    if (!this.selectedFolder || this.selectedFolder.ownerPubkey !== this.myPubkey) {
      return null;
    }

    return html`
      <div class="rounded-xl border border-green-900 bg-black p-4">
        <div class="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 class="text-sm font-semibold uppercase tracking-[0.18em] text-green-400">Folder Access</h3>
            <p class="text-xs text-green-700">Share, revoke, or rotate the shared folder key.</p>
          </div>
          <button
            type="button"
            @click="${() => this.rotateSelectedFolderKey()}"
            class="rounded-md border border-green-700 px-3 py-2 text-sm text-green-300 hover:bg-green-950"
          >
            Rotate Folder Key
          </button>
        </div>

        <div class="flex gap-2">
          <input
            type="text"
            class="block w-full rounded-md border border-green-900 bg-black p-3 font-mono text-xs text-green-400"
            placeholder="npub1abc... or name@domain.com"
            .value="${this.selectedFolderRecipientInput}"
            @input="${(e) => (this.selectedFolderRecipientInput = e.target.value)}"
            @keydown="${this.onSelectedFolderRecipientKeydown}"
          />
          <button
            type="button"
            @click="${() => this.addSelectedFolderRecipient()}"
            class="rounded-md border border-green-700 px-4 py-2 text-lg font-semibold text-green-300 hover:bg-green-950"
          >
            +
          </button>
        </div>

        ${this.renderRecipientChips(this.selectedFolderRecipients, (recipient) => this.removeSelectedFolderRecipient(recipient))}

        <button
          type="button"
          @click="${() => this.saveFolderAccess()}"
          class="mt-4 rounded-md bg-green-500 px-4 py-2 text-sm font-semibold text-black hover:bg-green-400"
        >
          Save Folder Access
        </button>
      </div>
    `;
  }

  renderFolderDetailsPanel() {
    if (!this.selectedFolder) {
      return null;
    }

    const isOwned = this.selectedFolder.ownerPubkey === this.myPubkey;
    const recipientCount = isOwned ? this.selectedFolderRecipients.length : null;
    const timestamp = this.selectedFolder.sharedAt || this.selectedFolder.createdAt || null;

    return html`
      <div class="rounded-xl border border-green-900 bg-black p-4">
        <h3 class="mb-3 text-sm font-semibold uppercase tracking-[0.18em] text-green-400">Folder Details</h3>
        <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div class="rounded-lg border border-green-950 p-3">
            <div class="text-[11px] uppercase tracking-wide text-green-600">Name</div>
            <div class="mt-1 text-sm text-green-300">${this.selectedFolder.folderName}</div>
          </div>
          <div class="rounded-lg border border-green-950 p-3">
            <div class="text-[11px] uppercase tracking-wide text-green-600">Folder ID</div>
            <div class="mt-1 font-mono text-xs text-green-300">${this.selectedFolder.folderId}</div>
          </div>
          <div class="rounded-lg border border-green-950 p-3">
            <div class="text-[11px] uppercase tracking-wide text-green-600">Owner</div>
            <div class="mt-1 font-mono text-xs text-green-300">${this.shortPubkey(this.selectedFolder.ownerPubkey)}</div>
          </div>
          <div class="rounded-lg border border-green-950 p-3">
            <div class="text-[11px] uppercase tracking-wide text-green-600">Files</div>
            <div class="mt-1 text-sm text-green-300">${this.folderFiles.length}</div>
          </div>
          <div class="rounded-lg border border-green-950 p-3">
            <div class="text-[11px] uppercase tracking-wide text-green-600">Access</div>
            <div class="mt-1 text-sm text-green-300">${isOwned ? "Owned by you" : "Shared with you"}</div>
          </div>
          <div class="rounded-lg border border-green-950 p-3">
            <div class="text-[11px] uppercase tracking-wide text-green-600">Recipients</div>
            <div class="mt-1 text-sm text-green-300">${recipientCount == null ? "Hidden" : recipientCount}</div>
          </div>
          <div class="rounded-lg border border-green-950 p-3 sm:col-span-2">
            <div class="text-[11px] uppercase tracking-wide text-green-600">Timestamp</div>
            <div class="mt-1 text-sm text-green-300">${timestamp ? this.formatDate(timestamp) : "Unknown"}</div>
          </div>
        </div>
      </div>
    `;
  }

  renderFilesTable() {
    if (!this.selectedFolder) {
      return html`<div class="rounded-xl border border-green-900 bg-black p-8 text-center text-sm text-green-700">
        ${this.mode === "shared"
          ? "No shared folder selected."
          : "Select a folder from the sidebar to browse files."}
      </div>`;
    }

    if (this.filesLoading) {
      return html`<div class="rounded-xl border border-green-900 bg-black p-6 text-sm text-green-600">Loading files…</div>`;
    }

    return html`
      <div class="rounded-xl border border-green-900 bg-black p-4">
        <div class="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 class="text-lg font-semibold text-green-300">${this.selectedFolder.folderName}</h2>
            <p class="text-xs text-green-700">
              ${this.folderFiles.length} file${this.folderFiles.length === 1 ? "" : "s"} · owner ${this.shortPubkey(this.selectedFolder.ownerPubkey)}
            </p>
          </div>
          ${this.folderFiles.length > 0
            ? html`<button
                type="button"
                @click="${() => this.downloadAllFiles()}"
                class="shrink-0 rounded-md border border-green-700 px-3 py-2 text-sm text-green-300 hover:bg-green-950"
              >
                ⬇ Download All
              </button>`
            : null}
        </div>

        ${this.folderFiles.length === 0
          ? html`<p class="text-sm text-green-700">No files in this folder yet.</p>`
          : html`<div class="overflow-x-auto">
              <table class="min-w-full text-left text-sm">
                <thead>
                  <tr class="border-b border-green-900 text-green-600">
                    <th class="py-2 pr-4">Filename</th>
                    <th class="py-2 pr-4">Size</th>
                    <th class="py-2 pr-4">Date</th>
                    <th class="py-2 pr-4">Uploader</th>
                    <th class="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  ${this.folderFiles.map(
                    (fileItem) => html`<tr class="border-b border-green-950 align-middle">
                      <td class="py-2.5 pr-4 text-green-300">${fileItem.fileName}</td>
                      <td class="py-2.5 pr-4 text-green-700">${formatBytes(fileItem.size || 0)}</td>
                      <td class="py-2.5 pr-4 text-green-700">${this.formatDate(fileItem.uploadedAt)}</td>
                      <td class="py-2.5 pr-4 text-green-700">${this.shortPubkey(fileItem.uploader)}</td>
                      <td class="py-2.5 text-right">
                        <button
                          type="button"
                          @click="${() => this.downloadItem(fileItem)}"
                          class="rounded-md bg-green-500 px-3 py-1.5 text-sm font-semibold text-black hover:bg-green-400"
                        >
                          Download
                        </button>
                      </td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>`}
      </div>
    `;
  }

  render() {
    const statusBar = this.status
      ? html`<div class="fixed bottom-4 right-4 rounded border border-green-700 bg-black p-4 text-green-400">${this.status}</div>`
      : null;

    const errorBar = this.error
      ? html`<div class="fixed bottom-4 right-4 rounded border border-green-700 bg-black p-4 text-green-400">
          <span>${this.error}</span>
          <button @click="${() => (this.error = "")}" class="ml-2 cursor-pointer font-bold">✕</button>
        </div>`
      : null;

    const sidebar = this.mode === "upload"
      ? html`
          <div class="rounded-xl border border-green-900 bg-black overflow-hidden">
            <div class="flex items-center justify-between border-b border-green-900 px-3 py-2.5">
              <span class="text-xs font-semibold uppercase tracking-[0.18em] text-green-500">My Folders</span>
              <button
                type="button"
                @click="${() => this.openCreateFolderForm()}"
                class="rounded-md px-2.5 py-1 text-xs font-semibold transition ${this.createFolderOpen
                  ? "text-green-500 hover:bg-green-950"
                  : "bg-green-500 text-black hover:bg-green-400"}"
              >
                ${this.createFolderOpen ? "✕ Cancel" : "+ New Folder"}
              </button>
            </div>
            ${this.renderCreateFolderPanel()}
            <div class="p-2">
              ${this.renderSidebarSection("Folders", this.ownedFolders)}
            </div>
          </div>`
      : html`
          <div class="rounded-xl border border-green-900 bg-black overflow-hidden">
            <div class="border-b border-green-900 px-3 py-2.5">
              <span class="text-xs font-semibold uppercase tracking-[0.18em] text-green-500">Shared With Me</span>
            </div>
            <div class="p-2">
              ${this.renderSidebarSection("Shared With Me", this.sharedFolders)}
            </div>
          </div>`;

    const mainBody = this.mode === "upload"
      ? html`
          ${this.renderUploadQueue()}
          ${this.renderFolderAccessPanel()}
          ${this.renderFilesTable()}`
      : html`
          ${this.renderFolderDetailsPanel()}
          ${this.renderFilesTable()}`;

    return html`
      <div class="relative w-full">
        ${this.renderSharedPanel()}
        <div class="flex gap-4 items-start">
          <aside class="w-64 shrink-0">${sidebar}</aside>
          <section class="flex-1 min-w-0 space-y-4">${mainBody}</section>
        </div>
        ${statusBar}
        ${errorBar}
      </div>
    `;
  }
}

customElements.define("encrypted-drive", DriveForm);
