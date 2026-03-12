# 🌸 Blossom-server

blossom-server is a Typescript implementation of a [Blossom Server](https://github.com/hzrd149/blossom)

## Supported BUDs

- [x] BUD-01
- [x] BUD-02
- [ ] ~~BUD~03~~ N/A
- [x] BUD-04
- [x] BUD-05
- [x] BUD-06

## Encrypted Drive (Browser Client)

A client-side encrypted folder sharing system built on Nostr and Blossom.

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

### Upload Flow

```text
create or select folder
generate FAK_folder if folder is new

for each file:
  generate FDK
  encrypt file with FDK
  wrap FDK with FAK_folder
  upload encrypted blob to Blossom
  publish file metadata event with folder_id + wrapped_fdk
```

If no owned folder is selected, the UI automatically creates a folder named after the upload batch.

### Download Flow

```text
fetch file metadata
read folder_id and wrapped_fdk
fetch folder share event for current user
decrypt FAK_folder with NIP-44
unwrap FDK
download encrypted blob from Blossom
decrypt file locally
```

### Rotation And Revocation

Revocation and rotation now happen at the folder level.

When revoking a user or rotating a folder key:

1. Fetch all files in the folder
2. Decrypt each file's wrapped FDK using the current folder key
3. Generate a new folder key
4. Rewrap every FDK with the new folder key
5. Publish fresh file metadata events with updated `wrapped_fdk`
6. Publish a new folder share event for the remaining recipients

Encrypted blobs are never reuploaded during rotation or revocation.

### Browser UI

The drive UI is now folder-centric.

1. Navigate to `http://localhost:3000/#drive`
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
- **No key rotation** — once encrypted, file keys cannot be rotated without re-uploading
