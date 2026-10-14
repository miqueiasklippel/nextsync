# NextSync

Sync your Obsidian vault with a folder on your **Nextcloud** server over WebDAV.
Works on desktop (Linux, Windows, macOS) and mobile (Android, iOS).

> The plugin interface is currently in Brazilian Portuguese. Documentação em português: [README.pt-BR.md](README.pt-BR.md).

## Features

- Two-way sync between the vault and a Nextcloud folder of your choice.
- Change detection by local modification time and size plus the Nextcloud ETag, so only changed files are transferred.
- Renames and moves are applied as a single WebDAV `MOVE` on the other side, without uploading or downloading the file again. This works for files and whole folders, whether you rename them in Obsidian, in Nextcloud or on another device.
- Empty folders are created and deleted on both sides.
- Optional sync of hidden files and of the Obsidian configuration folder (settings, hotkeys, themes, CSS snippets and, optionally, community plugins).
- Parallel transfers (1 to 8 at a time, 4 by default) and parallel listing of the server.
- Conflict handling without data loss: when a note changes on both sides, the server version is kept as `note (conflito YYYY-MM-DD HHMMSS).md` next to the local one.
- Optional confirmation before deletions reach Nextcloud, both when you delete a note or folder and when a sync is about to delete files or folders on the server.
- Safeguards against accidental mass deletion: a configurable deletion limit and a stop when either side suddenly appears empty.
- The app password is stored in Obsidian's secret storage, not in the plugin's configuration file.
- Manual sync (ribbon icon or command), automatic sync every *N* minutes, and sync on startup.

## Requirements

- Obsidian 1.13.1 or later.
- A Nextcloud account and an **app password** (*Personal settings → Security → Devices & sessions*).

## Installation

From Obsidian: *Settings → Community plugins → Browse*, search for **NextSync**, then install and enable it.

Manual installation: download `main.js`, `manifest.json` and `styles.css` from the latest release and copy them to `<vault>/<configuration folder>/plugins/nextsync/` (the configuration folder is `.obsidian` by default).

## Setup

1. Open *Settings → NextSync*.
2. Fill in:
   - **Server address**: only the root of your Nextcloud, using HTTPS (for example, `https://cloud.example.com`).
   - **Username**: your Nextcloud login.
   - **App password**: pick or create a secret in Obsidian's secret storage.
   - **Remote folder**: the Nextcloud folder that will mirror the vault. It is created if it does not exist.
3. Select **Testar conexão** (Test connection).

## How sync works

| Situation | Action |
|---|---|
| Changed only in the vault | Uploaded to Nextcloud |
| Changed only on Nextcloud | Downloaded to the vault |
| Changed on both sides | Conflict copy of the server version, local version kept and uploaded |
| New file or folder on one side | Created on the other side |
| Renamed or moved on one side | Renamed or moved on the other side, without a new transfer |
| Deleted in the vault | Deleted on Nextcloud (after confirmation, if enabled) |
| Deleted on Nextcloud | Local file moved to the trash chosen in Obsidian's *Files and links → Deleted files* setting |
| Deleted on one side and changed on the other | The changed version is restored |

On the first sync, files that exist on both sides are compared byte by byte. If they differ, a conflict copy is created and nothing is overwritten.

### Renames and moves

NextSync recognizes renames in three ways:

1. **In Obsidian**: renames and moves are recorded as they happen and applied on the server with `MOVE`. Renaming a folder moves it in a single request, with everything inside.
2. **In Nextcloud or on another device**: Nextcloud keeps a permanent file ID (`oc:fileid`) that does not change on rename, so the plugin renames the local file or folder instead of downloading it again.
3. **With Obsidian closed** (for example, in a file manager): a new local file whose content matches a missing file exactly (same size and SHA-256 hash) is treated as a rename.

If both sides rename the same file differently, both names are kept, and nothing is lost.

### Empty folders

Folders are tracked like files. A folder created on one side is created on the other; a folder deleted on one side is deleted on the other, but **only when it is empty**. A folder that received new files on the other side is kept.

### Hidden files and configuration

Both options are off by default (*Settings → NextSync → O que sincronizar*):

- **Hidden files and folders**: files and folders whose names start with a dot, anywhere in the vault.
- **Obsidian settings**: the configuration folder, including preferences, hotkeys, appearance, themes and CSS snippets. Changes received from another device take effect after restarting Obsidian.
- **Community plugins** (requires the previous option): the installed plugins, their settings and the list of enabled plugins.

These items are **never** synced, whatever the settings: the `.git` and `.trash` folders, `.DS_Store`, `Thumbs.db`, the window layout (`workspace.json` and `workspace-mobile.json`) and NextSync's own folder, which holds the sync state of each device.

When a configuration file changes on both sides, the most recently modified version wins, without a conflict copy. On a device that enables configuration sync for the first time, the version already on the server is adopted.

### Parallel transfers

The number of simultaneous transfers is set in *Settings → NextSync → Transferências simultâneas*, from 1 to 8 (4 by default). Use 1 on unstable connections or busy servers.

## Disclosures

- **Network use**: the plugin connects only to the Nextcloud server you configure. It uses the Nextcloud WebDAV endpoint (`/remote.php/dav/files/…`) to list, upload, download, move and delete files and folders in the chosen folder, and the OCS API (`/ocs/v2.php/cloud/user`) to verify credentials and find your user ID. No other remote services are contacted.
- **Account**: a Nextcloud account on a server of your choice is required.
- **Payment**: free. No payment is required.
- **Telemetry**: none.
- **Vault access**: to compare the vault with the server, the plugin lists the files in the vault and reads, creates, modifies, renames and moves to the trash only the files inside the synced scope. Hidden files and the configuration folder are read only when you enable the corresponding options; ignored folders are never read or uploaded.
- **Files outside the vault**: the plugin does not access files outside the vault.

## Security

- HTTPS is required. Plain HTTP is accepted only for `localhost`.
- Sync of the account's root folder is not allowed; a remote folder is mandatory.
- Remote file names containing `..`, backslashes or control characters are ignored.
- Server-side deletions use `If-Match` with the last known ETag. A file changed on Nextcloud since the last sync is never deleted; it is restored to the vault instead.
- Folders are deleted only when empty, on both sides.
- Moves never overwrite an existing item (`Overwrite: F`).
- Local deletions follow Obsidian's deleted-files preference (vault `.trash` folder or system trash); server deletions go to the Nextcloud trash bin.
- An app password stored in plain text by an earlier version is moved automatically to Obsidian's secret storage.
- Changing the server, user or remote folder resets the sync history automatically.

## Known limitations

- A folder that contains items outside the sync scope (for example, hidden files with that option off) is not deleted on the other side, because it is not empty there.
- Renames made outside Obsidian are recognized only for files whose content did not change in the same operation; otherwise they are handled as a deletion followed by a creation.

## Building from source

```bash
npm ci
npm run lint
npm test
npm run build
```

Requires Node.js 18 or later.

## License

[MIT](LICENSE)
