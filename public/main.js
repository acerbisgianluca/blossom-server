import { html, LitElement } from "./lib/lit.min.js";
import "./drive-form.js";

export class BlossomApp extends LitElement {
  static properties = {
    notificationCount: { state: true, type: Number },
    sharedPanelOpen: { state: true, type: Boolean },
  };

  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
    this.notificationCount = 0;
    this.sharedPanelOpen = false;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("hashchange", () => {
      this.requestUpdate();
    });

    this.addEventListener("drive-notifications", (event) => {
      const { unreadCount = 0, panelOpen = false } = event.detail || {};
      this.notificationCount = unreadCount;
      this.sharedPanelOpen = panelOpen;
    });
  }

  openNotifications() {
    const drive = this.querySelector("encrypted-drive");
    if (drive && typeof drive.toggleSharedPanel === "function") {
      drive.toggleSharedPanel();
    }
  }

  getSelectedMode() {
    if (location.hash === "#shared") return "shared";
    return "upload";
  }

  render() {
    const mode = this.getSelectedMode();

    return html`
      <div class="relative min-h-screen text-green-400">
        <div class="absolute inset-0 app-atmosphere" aria-hidden="true"></div>

        <nav class="relative z-20 border-b border-green-900 bg-black/90 backdrop-blur-md">
          <div class="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
            <div>
              <p class="text-xs uppercase tracking-[0.26em] text-green-600">Blossom</p>
              <h1 class="text-lg font-semibold text-green-300 sm:text-xl">Encrypted Drive</h1>
            </div>

            <div class="ml-auto flex items-center gap-2 rounded-xl border border-green-900 bg-black p-1">
              <a
                href="#upload"
                class="rounded-lg px-3 py-2 text-sm font-medium transition ${mode === "upload"
                  ? "bg-green-500 text-black"
                  : "text-green-400 hover:bg-green-950"}"
              >
                Upload
              </a>
              <a
                href="#shared"
                class="rounded-lg px-3 py-2 text-sm font-medium transition ${mode === "shared"
                  ? "bg-green-500 text-black"
                  : "text-green-400 hover:bg-green-950"}"
              >
                Shared With Me
              </a>
            </div>

            <button
              @click="${this.openNotifications}"
              class="relative rounded-full border border-green-800 bg-black p-2 text-lg text-green-400 hover:bg-green-950"
              title="Shared files"
            >
              🔔
              ${this.notificationCount > 0
                ? html`<span
                    class="absolute -right-1 -top-1 min-w-[1.25rem] rounded-full bg-red-600 px-1 text-xs font-semibold text-white"
                  >
                    ${this.notificationCount}
                  </span>`
                : null}
            </button>
          </div>
        </nav>

        <main class="relative z-10 mx-auto w-full max-w-6xl px-4 pb-10 pt-6 sm:px-6 sm:pt-8">
          <encrypted-drive .mode="${mode}"></encrypted-drive>
        </main>
      </div>
    `;
  }
}

customElements.define("blossom-app", BlossomApp);
