# 🌸 Drostr

Drostr is a Typescript implementation of a [Blossom Server](https://github.com/hzrd149/blossom)

## Supported BUDs

- [x] BUD-01
- [x] BUD-02
- [ ] ~~BUD~03~~ N/A
- [x] BUD-04
- [x] BUD-05
- [x] BUD-06

### Features

- **Encrypted folders** — each folder has its own Folder Access Key
- **Per-file AES-256-GCM encryption** — each file still gets a unique File Data Key
- **Encrypted blob storage** — only encrypted blobs are uploaded to Blossom
- **Folder-level sharing** — recipients decrypt one folder key and can open all files in that folder
- **Folder-level revocation and rotation** — rewrap file keys with a new folder key without reuploading blobs
- **Folder browser UI** — browse owned folders, shared folders, and files inside each folder

### Architecture

The current key hierarchy is:

```text
file_data --AES-256-GCM--> FDK
FDK --AES-256-GCM--> FAK_folder
FAK_folder --NIP-44--> recipients
```

Definitions:

- **FDK** — random 32 byte File Data Key generated per file
- **FAK_folder** — random 32 byte Folder Access Key generated per folder

Recipients decrypt the folder key once and then use it to unwrap each file's FDK.

### Nostr Event Types

- **Kind 30000 (Folder)** — parameterized replaceable folder definition
  Tags: `[["d", "<folder_id>"], ["name", "<folder_name>"]]`
- **Kind 1063 (File Metadata, NIP-94)** — one event per encrypted file
  Tags: `[["x", "<blob_sha256>"], ["url", "<blossom_url>"], ["m", "<mime_type>"], ["size", "<file_size>"], ["folder", "<folder_id>"], ["wrapped_fdk", "<base64_wrapped_key>"], ["enc", "aes-256-gcm"]]`
- **Kind 30001 (Folder Share)** — parameterized replaceable share event per folder
  Tags: `[["d", "<folder_id>"], ["folder", "<folder_id>"]]`, repeated `[["p", "<recipient_pubkey>"]]`, repeated `[["access_key", "<recipient_pubkey>", "<nip44_encrypted_folder_key>"]]`

### Upload Flow (Detailed)

```text
1. Create or select a folder.
2. If the folder is new, generate a random 32-byte `FAK_folder`.
3. Build the folder share event:
  - For each recipient, encrypt `FAK_folder` using NIP-44.
  - Publish Kind 30001 with `p` tags and `access_key` tags for each recipient.
4. For each file:
  - Generate a random 32-byte `FDK`.
  - Encrypt the plaintext file with `FDK` using AES-256-GCM.
  - Wrap the `FDK` with `FAK_folder` using AES-256-GCM, producing `wrapped_fdk`.
  - Upload the encrypted blob to Blossom.
  - Publish Kind 1063 metadata with `folder` and `wrapped_fdk` tags.
```

If no owned folder is selected, the UI automatically creates a folder named after the upload batch.

### Download Flow (Detailed)

```text
1. Fetch the latest file metadata event for the blob hash.
2. Read `folder_id` and `wrapped_fdk` tags from metadata.
3. Fetch the latest folder share event for the folder owner.
4. Decrypt `FAK_folder` using NIP-44 with the current user's key.
5. Unwrap the `FDK` by decrypting `wrapped_fdk` using `FAK_folder`.
6. Download the encrypted blob from Blossom.
7. Decrypt the blob locally using `FDK`.
```

### Rotation And Revocation (Detailed)

Revocation and rotation happen at the folder level and do not reupload blobs.

When rotating or revoking:

```text
1. Fetch all file metadata events for the folder.
2. For each file:
  - Decrypt `wrapped_fdk` using the current `FAK_folder`.
  - Generate a new `FAK_folder` (rotation) or reuse a newly generated one (revocation).
  - Rewrap each `FDK` with the new `FAK_folder`.
  - Publish a new file metadata event with updated `wrapped_fdk`.
3. Publish a new folder share event with NIP-44 encrypted `FAK_folder` for the remaining recipients.
```

> Note: revocation is forward-only. Recipients who previously had the old folder key can still decrypt any data they already downloaded.

### Browser UI

The drive UI is now folder-centric.

1. Navigate to `http://localhost:3000/#upload`
2. Connect a Nostr extension (e.g. nos2x, Alby, any NIP-07 compatible signer)
3. Use the left sidebar to browse:
   - **Folders** — folders you own
   - **Shared With Me** — folders shared by other users
4. Use the main panel to:
   - create folders
   - upload multiple files into a folder
   - inspect folder details
   - share or revoke folder access
   - rotate folder keys
   - browse and download files in the selected folder
5. Use the trash icon on a folder card in the sidebar to delete an owned folder.

### Dependencies

- `window.nostr` — NIP-07 signer interface for event signing and NIP-44 encryption/decryption
- `nostr-tools` — Relay pool and event utilities (loaded via ESM in HTML)
- **WebCrypto API** — Native browser AES-256-GCM encryption (no external crypto library required)

### Security Assumptions

- **Client-side encryption only** — server never sees plaintext or unencrypted keys
- **NIP-44 encryption** — assumes extension supports modern NIP-44 (v2) encryption
- **Trusted relay** — relies on relays for event availability; consider running your own relays for privacy
- **No local key storage** — file keys stored only on Nostr as encrypted shares (recoverable by owner)

### Limitations

- **Folder-level encryption** — folders themselves are not encrypted; file-only encryption supported in v1
- **Browser-only** — no Node.js/CLI support in v1
- **Forward-only revocation** — revoked users may retain access to data they already obtained
- **Zap provider compatibility (WIP)** — zap-gated unlock currently depends on Lightning address/LNURL provider behavior and may fail with some providers

### Work In Progress / Future Development

- Improve zap-gated folder unlock reliability across more Lightning providers
- Add broader LNURL format handling and provider-specific fallbacks
- Improve payment error diagnostics and recovery UX
