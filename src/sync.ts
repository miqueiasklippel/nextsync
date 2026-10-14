import { App } from "obsidian";
import { runPool, Serial } from "./concurrency";
import { sameBytes, sha256Hex } from "./hash";
import { LocalEntry, LocalFs, LocalSnapshot } from "./local-fs";
import { SyncScope } from "./scope";
import { NextSyncSettings } from "./settings";
import { NextcloudClient, RemoteEntry, RemoteListing, sameEtag } from "./webdav";

export interface FileState {
  localMtime: number;
  localSize: number;
  etag: string;
  hash?: string;
  fileId?: string;
}

export interface FolderState {
  fileId?: string;
}

export interface SyncState {
  files: Record<string, FileState>;
  folders: Record<string, FolderState>;
}

export type MoveJournal = Record<string, string>;

export const STATE_VERSION = 2;

export interface SyncReport {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  restored: number;
  moved: number;
  foldersCreated: number;
  foldersDeleted: number;
  conflicts: string[];
  errors: string[];
}

export interface SyncHooks {
  onProgress(done: number, total: number): void;
  persist(): Promise<void>;
  beforeLocalTrash(path: string): void;
  beforeLocalRename(from: string, to: string): void;
  confirmRemoteDeletions(paths: string[]): Promise<boolean>;
}

type FileActionKind = "upload" | "download" | "deleteLocal" | "deleteRemote" | "conflict" | "compare" | "forget";
type FolderActionKind = "createRemote" | "createLocal" | "deleteRemote" | "deleteLocal" | "forget";

interface FileAction {
  kind: FileActionKind;
  path: string;
}

interface FolderAction {
  kind: FolderActionKind;
  path: string;
}

type Resolution = "conflict" | "resolved";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

function depthOf(path: string): number {
  return path.split("/").length;
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function emptyState(): SyncState {
  return { files: {}, folders: {} };
}

export function migrateState(raw: unknown, version: unknown): SyncState {
  if (!isRecord(raw)) return emptyState();
  if (version === STATE_VERSION) {
    return {
      files: isRecord(raw.files) ? (raw.files as Record<string, FileState>) : {},
      folders: isRecord(raw.folders) ? (raw.folders as Record<string, FolderState>) : {},
    };
  }
  return { files: raw as Record<string, FileState>, folders: {} };
}

export function conflictPath(path: string, date: Date, sequence = 1): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const suffix = sequence > 1 ? ` ${sequence}` : "";
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${dir}${base} (conflito ${stamp}${suffix})${ext}`;
}

export function rekeyPrefix<T>(record: Record<string, T>, from: string, to: string): void {
  for (const key of Object.keys(record)) {
    if (isUnder(key, from)) {
      record[to + key.slice(from.length)] = record[key];
      delete record[key];
    }
  }
}

export class SyncEngine {
  private readonly local: LocalFs;
  private readonly persistQueue = new Serial();
  private readonly appliedMoves: [string, string][] = [];
  private remoteDirs = new Set<string>();
  private remote: RemoteListing = { files: new Map(), dirs: new Map(), rootExists: true, skipped: [] };
  private snapshot: LocalSnapshot = { files: new Map(), folders: new Set() };
  private skippedReported = false;
  private readonly report: SyncReport = {
    uploaded: 0,
    downloaded: 0,
    deletedLocal: 0,
    deletedRemote: 0,
    restored: 0,
    moved: 0,
    foldersCreated: 0,
    foldersDeleted: 0,
    conflicts: [],
    errors: [],
  };

  constructor(
    app: App,
    private readonly client: NextcloudClient,
    private readonly settings: NextSyncSettings,
    private readonly scope: SyncScope,
    private readonly state: SyncState,
    private readonly journal: MoveJournal,
    private readonly hooks: SyncHooks,
  ) {
    this.local = new LocalFs(app, scope, settings.concurrency);
  }

  private get concurrency(): number {
    return this.settings.concurrency;
  }

  async run(): Promise<SyncReport> {
    await this.refresh();
    if (!this.remote.rootExists) await this.client.ensureRoot();
    this.adoptRemoteIds();
    this.assertNotWiped();

    const journalSnapshot = Object.entries(this.journal);
    await this.applyJournalFolderMoves(journalSnapshot);
    if (await this.applyJournalFileMoves(journalSnapshot)) await this.refresh();
    for (const [to, from] of journalSnapshot) {
      if (this.journal[to] === from) delete this.journal[to];
    }
    if (await this.applyRemoteMoves()) await this.refresh();
    if (await this.applyDetectedLocalMoves()) await this.refresh();

    const fileActions = this.planFiles();
    const folderActions = this.planFolders();
    this.assertDeletionLimit(fileActions);
    await this.confirmRemoteDeletions(fileActions, folderActions);

    for (const action of fileActions) {
      if (action.kind === "forget") delete this.state.files[action.path];
    }
    for (const action of folderActions) {
      if (action.kind === "forget") delete this.state.folders[action.path];
    }

    await this.createFolders(folderActions);
    await this.executeFiles(fileActions.filter((action) => action.kind !== "forget"));
    await this.deleteFolders(folderActions);
    this.updateFolderState();
    await this.persistQueue.idle();
    return this.report;
  }

  private async refresh(): Promise<void> {
    const [snapshot, listing] = await Promise.all([
      this.local.scan(),
      this.client.listAll((dir) => this.scope.descends(dir), this.concurrency),
    ]);
    this.snapshot = snapshot;
    this.remoteDirs = new Set(listing.dirs.keys());

    const files = new Map<string, RemoteEntry>();
    for (const [path, entry] of listing.files) {
      if (this.scope.includes(path)) files.set(path, entry);
    }
    const dirs = new Map<string, RemoteEntry>();
    for (const [path, entry] of listing.dirs) {
      if (this.scope.includes(path)) dirs.set(path, entry);
    }
    this.remote = { files, dirs, rootExists: listing.rootExists, skipped: listing.skipped };

    if (!this.skippedReported) {
      this.skippedReported = true;
      for (const skipped of listing.skipped) {
        this.report.errors.push(`${skipped}: nome inválido no servidor, ignorado por segurança.`);
      }
    }
  }

  private adoptRemoteIds(): void {
    for (const [path, known] of Object.entries(this.state.files)) {
      const entry = this.remote.files.get(path);
      if (entry?.fileId && !known.fileId) known.fileId = entry.fileId;
    }
    for (const [path, known] of Object.entries(this.state.folders)) {
      const entry = this.remote.dirs.get(path);
      if (entry?.fileId && !known.fileId) known.fileId = entry.fileId;
    }
  }

  private assertNotWiped(): void {
    if (Object.keys(this.state.files).length === 0) return;
    const localCount = this.snapshot.files.size;
    const remoteCount = this.remote.files.size;
    const hint =
      "Por segurança, nada foi alterado. Se isso for intencional, use “Redefinir estado de sincronização” e sincronize novamente.";
    if (remoteCount === 0 && localCount > 0) {
      throw new Error(`A pasta remota está vazia, embora já tenha havido sincronizações. ${hint}`);
    }
    if (localCount === 0 && remoteCount > 0) {
      throw new Error(`O cofre está vazio, embora já tenha havido sincronizações. ${hint}`);
    }
  }

  private translate(path: string): string {
    let current = path;
    for (const [from, to] of this.appliedMoves) {
      if (isUnder(current, from)) current = to + current.slice(from.length);
    }
    return current;
  }

  private async applyJournalFolderMoves(entries: [string, string][]): Promise<void> {
    const folderEntries = entries
      .filter(([to, from]) => this.snapshot.folders.has(to) && (this.remote.dirs.has(from) || from in this.state.folders))
      .sort((a, b) => depthOf(a[1]) - depthOf(b[1]));

    for (const [to, from] of folderEntries) {
      const origin = this.translate(from);
      if (origin === to || !this.scope.includes(origin) || !this.scope.includes(to)) continue;
      if (!this.remote.dirs.has(origin) || this.remote.dirs.has(to) || this.remote.files.has(to)) continue;
      if (!(await this.local.folderExists(to)) || (await this.local.exists(origin))) continue;

      try {
        if ((await this.client.move(origin, to, this.remoteDirs)) !== "moved") continue;
      } catch (error) {
        this.report.errors.push(`${origin} → ${to}: ${errorMessage(error)}`);
        continue;
      }
      rekeyPrefix(this.state.files, origin, to);
      rekeyPrefix(this.state.folders, origin, to);
      this.appliedMoves.push([origin, to]);
      this.report.moved++;
      await this.refresh();
    }
  }

  private async applyJournalFileMoves(entries: [string, string][]): Promise<boolean> {
    let moved = false;
    for (const [to, from] of entries) {
      if (!this.snapshot.files.has(to)) continue;
      const origin = this.translate(from);
      if (origin === to || !this.scope.includes(origin) || !this.scope.includes(to)) continue;

      const known = this.state.files[origin];
      const entry = this.remote.files.get(origin);
      if (!known || !entry || this.remote.files.has(to) || this.remote.dirs.has(to)) continue;
      if (this.snapshot.files.has(origin)) continue;

      try {
        if ((await this.client.move(origin, to, this.remoteDirs)) !== "moved") continue;
        const after = await this.client.stat(to);
        const remoteUnchanged = sameEtag(entry.etag, known.etag);
        this.state.files[to] = {
          ...known,
          etag: remoteUnchanged && after ? after.etag : known.etag,
          fileId: after?.fileId || known.fileId,
        };
        delete this.state.files[origin];
        this.remote.files.delete(origin);
        this.remote.files.set(to, after ?? { ...entry, path: to });
        this.report.moved++;
        moved = true;
      } catch (error) {
        this.report.errors.push(`${origin} → ${to}: ${errorMessage(error)}`);
      }
    }
    return moved;
  }

  private async applyRemoteMoves(): Promise<boolean> {
    const dirById = new Map<string, string>();
    for (const [path, entry] of this.remote.dirs) if (entry.fileId) dirById.set(entry.fileId, path);
    const fileById = new Map<string, string>();
    for (const [path, entry] of this.remote.files) if (entry.fileId) fileById.set(entry.fileId, path);

    let moved = false;
    const folderPaths = Object.keys(this.state.folders).sort((a, b) => depthOf(a) - depthOf(b));
    for (const path of folderPaths) {
      const known = this.state.folders[path];
      if (!known?.fileId || this.remote.dirs.has(path)) continue;
      const target = dirById.get(known.fileId);
      if (!target || target === path || target in this.state.folders || !this.scope.includes(target)) continue;
      if (!(await this.local.folderExists(path)) || (await this.local.exists(target))) continue;
      try {
        this.hooks.beforeLocalRename(path, target);
        await this.local.rename(path, target);
        rekeyPrefix(this.state.files, path, target);
        rekeyPrefix(this.state.folders, path, target);
        this.report.moved++;
        moved = true;
      } catch (error) {
        this.report.errors.push(`${path} → ${target}: ${errorMessage(error)}`);
      }
    }

    for (const path of Object.keys(this.state.files)) {
      const known = this.state.files[path];
      if (!known?.fileId || this.remote.files.has(path)) continue;
      const target = fileById.get(known.fileId);
      if (!target || target === path || target in this.state.files || !this.scope.includes(target)) continue;
      if (!(await this.local.fileExists(path)) || (await this.local.exists(target))) continue;
      try {
        this.hooks.beforeLocalRename(path, target);
        await this.local.rename(path, target);
        this.state.files[target] = known;
        delete this.state.files[path];
        this.report.moved++;
        moved = true;
      } catch (error) {
        this.report.errors.push(`${path} → ${target}: ${errorMessage(error)}`);
      }
    }
    return moved;
  }

  private async applyDetectedLocalMoves(): Promise<boolean> {
    const candidates = new Map<string, [string, FileState][]>();
    for (const [path, known] of Object.entries(this.state.files)) {
      if (!known.hash || this.snapshot.files.has(path)) continue;
      const entry = this.remote.files.get(path);
      if (!entry || !sameEtag(entry.etag, known.etag)) continue;
      const group = candidates.get(known.hash) ?? [];
      group.push([path, known]);
      candidates.set(known.hash, group);
    }
    if (candidates.size === 0) return false;

    const sizes = new Set<number>();
    for (const group of candidates.values()) for (const [, known] of group) sizes.add(known.localSize);
    const fresh = [...this.snapshot.files.values()].filter(
      (entry) => !(entry.path in this.state.files) && !this.remote.files.has(entry.path) && sizes.has(entry.size),
    );
    if (fresh.length === 0) return false;

    const freshByHash = new Map<string, LocalEntry[]>();
    await runPool(fresh, this.concurrency, async (entry) => {
      try {
        const hash = await sha256Hex(await this.local.read(entry.path));
        if (!hash) return;
        const group = freshByHash.get(hash) ?? [];
        group.push(entry);
        freshByHash.set(hash, group);
      } catch {
        return;
      }
    });

    let moved = false;
    for (const [hash, group] of candidates) {
      const matches = freshByHash.get(hash);
      if (group.length !== 1 || matches?.length !== 1) continue;
      const [origin, known] = group[0];
      const target = matches[0];
      if (this.remote.dirs.has(target.path)) continue;
      try {
        if ((await this.client.move(origin, target.path, this.remoteDirs)) !== "moved") continue;
        const after = await this.client.stat(target.path);
        this.state.files[target.path] = {
          localMtime: target.mtime,
          localSize: target.size,
          etag: after?.etag ?? known.etag,
          hash,
          fileId: after?.fileId || known.fileId,
        };
        delete this.state.files[origin];
        this.report.moved++;
        moved = true;
      } catch (error) {
        this.report.errors.push(`${origin} → ${target.path}: ${errorMessage(error)}`);
      }
    }
    return moved;
  }

  private planFiles(): FileAction[] {
    const paths = new Set<string>([
      ...this.snapshot.files.keys(),
      ...this.remote.files.keys(),
      ...Object.keys(this.state.files),
    ]);
    const propagate = this.settings.propagateDeletions;
    const actions: FileAction[] = [];

    for (const path of paths) {
      const known = this.state.files[path];
      if (!this.scope.includes(path)) {
        if (known) actions.push({ kind: "forget", path });
        continue;
      }
      const localEntry = this.snapshot.files.get(path);
      const remoteEntry = this.remote.files.get(path);
      const localChanged =
        !!localEntry && !!known && (localEntry.mtime !== known.localMtime || localEntry.size !== known.localSize);
      const remoteChanged = !!remoteEntry && !!known && !sameEtag(remoteEntry.etag, known.etag);

      if (localEntry && remoteEntry) {
        if (!known) actions.push({ kind: "compare", path });
        else if (localChanged && remoteChanged) actions.push({ kind: "conflict", path });
        else if (localChanged) actions.push({ kind: "upload", path });
        else if (remoteChanged) actions.push({ kind: "download", path });
      } else if (localEntry) {
        if (!known || localChanged) actions.push({ kind: "upload", path });
        else actions.push({ kind: propagate ? "deleteLocal" : "upload", path });
      } else if (remoteEntry) {
        if (!known || remoteChanged) actions.push({ kind: "download", path });
        else actions.push({ kind: propagate ? "deleteRemote" : "download", path });
      } else if (known) {
        actions.push({ kind: "forget", path });
      }
    }
    return actions;
  }

  private planFolders(): FolderAction[] {
    const localDirs = this.snapshot.folders;
    const remoteDirs = this.remote.dirs;
    const paths = new Set<string>([...localDirs, ...remoteDirs.keys(), ...Object.keys(this.state.folders)]);
    const propagate = this.settings.propagateDeletions;
    const actions: FolderAction[] = [];

    for (const path of paths) {
      const known = path in this.state.folders;
      if (!this.scope.includes(path)) {
        if (known) actions.push({ kind: "forget", path });
        continue;
      }
      const inLocal = localDirs.has(path);
      const inRemote = remoteDirs.has(path);
      if (inLocal && !inRemote) {
        actions.push({ kind: known && propagate ? "deleteLocal" : "createRemote", path });
      } else if (!inLocal && inRemote) {
        actions.push({ kind: known && propagate ? "deleteRemote" : "createLocal", path });
      } else if (!inLocal && !inRemote && known) {
        actions.push({ kind: "forget", path });
      }
    }
    return actions;
  }

  private assertDeletionLimit(actions: FileAction[]): void {
    const limit = this.settings.maxDeletions;
    if (limit <= 0) return;
    const deletions = actions.filter((a) => a.kind === "deleteLocal" || a.kind === "deleteRemote").length;
    if (deletions > limit) {
      throw new Error(
        `Esta sincronização apagaria ${deletions} arquivos, acima do limite configurado (${limit}). ` +
          "Nada foi alterado. Confira o ocorrido e, se estiver tudo certo, aumente o limite temporariamente.",
      );
    }
  }

  private async confirmRemoteDeletions(files: FileAction[], folders: FolderAction[]): Promise<void> {
    if (!this.settings.confirmRemoteDeletion) return;
    const pendingFiles = files.filter((a) => a.kind === "deleteRemote");
    const pendingFolders = folders.filter((a) => a.kind === "deleteRemote");
    if (pendingFiles.length === 0 && pendingFolders.length === 0) return;

    const items = [
      ...pendingFiles.map((a) => a.path),
      ...pendingFolders.map((a) => `${a.path}/`),
    ].sort();
    if (await this.hooks.confirmRemoteDeletions(items)) return;
    for (const action of pendingFiles) action.kind = "download";
    for (const action of pendingFolders) action.kind = "createLocal";
  }

  private async createFolders(actions: FolderAction[]): Promise<void> {
    const creations = actions
      .filter((a) => a.kind === "createRemote" || a.kind === "createLocal")
      .sort((a, b) => depthOf(a.path) - depthOf(b.path));
    await runPool(creations, this.concurrency, async (action) => {
      try {
        if (action.kind === "createRemote") {
          if (!this.remoteDirs.has(action.path)) {
            await this.client.ensureDir(action.path, this.remoteDirs);
            this.report.foldersCreated++;
          }
        } else if (!this.local.folders.has(action.path)) {
          await this.local.ensureFolder(action.path);
          this.report.foldersCreated++;
        }
      } catch (error) {
        this.report.errors.push(`${action.path}/: ${errorMessage(error)}`);
      }
    });
  }

  private async deleteFolders(actions: FolderAction[]): Promise<void> {
    const deletions = actions
      .filter((a) => a.kind === "deleteRemote" || a.kind === "deleteLocal")
      .sort((a, b) => depthOf(b.path) - depthOf(a.path));
    for (const action of deletions) {
      try {
        if (action.kind === "deleteRemote") {
          if (await this.client.deleteEmptyDir(action.path)) {
            this.remoteDirs.delete(action.path);
            this.report.foldersDeleted++;
          }
        } else {
          this.hooks.beforeLocalTrash(action.path);
          if (await this.local.removeEmptyFolder(action.path)) this.report.foldersDeleted++;
        }
      } catch (error) {
        this.report.errors.push(`${action.path}/: ${errorMessage(error)}`);
      }
    }
  }

  private updateFolderState(): void {
    const previous = { ...this.state.folders };
    for (const key of Object.keys(this.state.folders)) delete this.state.folders[key];
    for (const path of this.local.folders) {
      if (!this.scope.includes(path) || !this.remoteDirs.has(path)) continue;
      this.state.folders[path] = {
        fileId: this.remote.dirs.get(path)?.fileId || this.client.createdFolderId(path) || previous[path]?.fileId,
      };
    }
  }

  private async executeFiles(work: FileAction[]): Promise<void> {
    let done = 0;
    this.hooks.onProgress(done, work.length);
    await runPool(work, this.concurrency, async (action) => {
      try {
        await this.execute(action);
      } catch (error) {
        this.report.errors.push(`${action.path}: ${errorMessage(error)}`);
        console.error("[NextSync]", action.kind, action.path, error);
      }
      done++;
      this.hooks.onProgress(done, work.length);
      if (done % 25 === 0) void this.persistQueue.run(() => this.hooks.persist());
    });
  }

  private requireRemote(path: string): RemoteEntry {
    const entry = this.remote.files.get(path);
    if (!entry) throw new Error("O arquivo não foi encontrado na listagem do servidor.");
    return entry;
  }

  private async execute(action: FileAction): Promise<void> {
    const { path } = action;
    switch (action.kind) {
      case "upload":
        await this.upload(path);
        this.report.uploaded++;
        return;

      case "download": {
        const result = await this.download(path, this.requireRemote(path));
        if (result === "conflict") this.report.conflicts.push(path);
        else this.report.downloaded++;
        return;
      }

      case "compare":
        if ((await this.compare(path, this.requireRemote(path))) === "conflict") this.report.conflicts.push(path);
        return;

      case "conflict": {
        const entry = this.requireRemote(path);
        const { data } = await this.client.get(path);
        if ((await this.resolveConflict(path, data, entry, false)) === "conflict") this.report.conflicts.push(path);
        return;
      }

      case "deleteLocal":
        this.hooks.beforeLocalTrash(path);
        await this.local.trash(path);
        delete this.state.files[path];
        this.report.deletedLocal++;
        return;

      case "deleteRemote": {
        const result = await this.client.delete(path, this.state.files[path]?.etag);
        delete this.state.files[path];
        if (result === "changed") {
          await this.download(path, this.requireRemote(path));
          this.report.restored++;
        } else {
          this.report.deletedRemote++;
        }
        return;
      }

      case "forget":
        delete this.state.files[path];
        return;
    }
  }

  private async upload(path: string): Promise<void> {
    const before = await this.local.stat(path);
    if (!before) throw new Error("O arquivo não existe mais no cofre.");
    const data = await this.local.read(path);
    const parent = parentOf(path);
    if (parent) await this.client.ensureDir(parent, this.remoteDirs);
    const { etag, fileId } = await this.client.put(path, data, before.mtime);
    this.state.files[path] = {
      localMtime: before.mtime,
      localSize: before.size,
      etag,
      hash: await sha256Hex(data),
      fileId: fileId || undefined,
    };
  }

  private async storeDownload(path: string, data: ArrayBuffer, entry: RemoteEntry, etag: string): Promise<void> {
    const written = await this.local.write(path, data, entry.mtime);
    this.state.files[path] = {
      localMtime: written.mtime,
      localSize: written.size,
      etag: etag || entry.etag,
      hash: await sha256Hex(data),
      fileId: entry.fileId || this.state.files[path]?.fileId,
    };
  }

  private async download(path: string, entry: RemoteEntry): Promise<"downloaded" | Resolution> {
    const { data, etag } = await this.client.get(path);
    const current = await this.local.stat(path);
    const known = this.state.files[path];
    if (current && (!known || current.mtime !== known.localMtime || current.size !== known.localSize)) {
      return this.resolveConflict(path, data, entry, false);
    }
    await this.storeDownload(path, data, entry, etag);
    return "downloaded";
  }

  private async compare(path: string, entry: RemoteEntry): Promise<"same" | Resolution> {
    const { data, etag } = await this.client.get(path);
    const before = await this.local.stat(path);
    if (!before) throw new Error("O arquivo não existe mais no cofre.");
    if (before.size === entry.size && sameBytes(data, await this.local.read(path))) {
      this.state.files[path] = {
        localMtime: before.mtime,
        localSize: before.size,
        etag: etag || entry.etag,
        hash: await sha256Hex(data),
        fileId: entry.fileId || undefined,
      };
      return "same";
    }
    return this.resolveConflict(path, data, entry, true);
  }

  private async resolveConflict(
    path: string,
    remoteData: ArrayBuffer,
    entry: RemoteEntry,
    firstSync: boolean,
  ): Promise<Resolution> {
    if (this.scope.isConfigPath(path)) {
      const current = await this.local.stat(path);
      const localWins = !firstSync && !!current && current.mtime >= entry.mtime;
      if (localWins) await this.upload(path);
      else await this.storeDownload(path, remoteData, entry, entry.etag);
      return "resolved";
    }

    const copyPath = await this.uniqueConflictPath(path);
    await this.local.write(copyPath, remoteData, entry.mtime);
    await this.upload(copyPath);
    await this.upload(path);
    return "conflict";
  }

  private async uniqueConflictPath(path: string): Promise<string> {
    const now = new Date();
    let sequence = 1;
    let candidate = conflictPath(path, now, sequence);
    while ((await this.local.exists(candidate)) || this.remote.files.has(candidate)) {
      sequence++;
      candidate = conflictPath(path, now, sequence);
    }
    return candidate;
  }
}
