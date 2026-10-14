import { App, TFile, TFolder } from "obsidian";
import { walkTree } from "./concurrency";
import { SyncScope } from "./scope";

export interface LocalEntry {
  path: string;
  mtime: number;
  size: number;
}

export interface LocalSnapshot {
  files: Map<string, LocalEntry>;
  folders: Set<string>;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

function clean(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

export class LocalFs {
  readonly folders = new Set<string>();
  private readonly folderCreation = new Map<string, Promise<void>>();

  constructor(
    private readonly app: App,
    private readonly scope: SyncScope,
    private readonly concurrency: number,
  ) {}

  private get adapter() {
    return this.app.vault.adapter;
  }

  async scan(): Promise<LocalSnapshot> {
    const files = new Map<string, LocalEntry>();
    this.folders.clear();

    for (const file of this.app.vault.getFiles()) {
      if (this.scope.includes(file.path)) {
        files.set(file.path, { path: file.path, mtime: file.stat.mtime, size: file.stat.size });
      }
    }
    const indexedFolders = this.app.vault.getAllFolders(false);
    for (const folder of indexedFolders) {
      if (this.scope.includes(folder.path)) this.folders.add(folder.path);
    }

    const roots: string[] = [];
    if (this.scope.descends(this.scope.configDir) && (await this.adapter.exists(this.scope.configDir))) {
      roots.push(this.scope.configDir);
    }
    if (this.scope.syncHidden) {
      roots.push("", ...indexedFolders.map((folder) => folder.path).filter((path) => this.scope.descends(path)));
    }

    await walkTree(roots, this.concurrency, async (dir) => {
      const listing = await this.adapter.list(dir === "" ? "/" : dir);
      const unindexedOnly = dir === "" || this.scope.isIndexed(dir);
      const children: string[] = [];

      for (const rawFolder of listing.folders) {
        const folder = clean(rawFolder);
        if (!folder || folder === this.scope.configDir) continue;
        if (unindexedOnly && this.scope.isIndexed(folder)) continue;
        if (!this.scope.descends(folder)) continue;
        if (this.scope.includes(folder)) this.folders.add(folder);
        children.push(folder);
      }

      const pending: Promise<void>[] = [];
      for (const rawFile of listing.files) {
        const path = clean(rawFile);
        if (unindexedOnly && this.scope.isIndexed(path)) continue;
        if (!this.scope.includes(path)) continue;
        pending.push(
          this.adapter.stat(path).then((stat) => {
            if (stat && stat.type === "file") files.set(path, { path, mtime: stat.mtime, size: stat.size });
          }),
        );
      }
      await Promise.all(pending);
      return children;
    });

    return { files, folders: new Set(this.folders) };
  }

  private indexedFile(path: string): TFile | null {
    return this.scope.isIndexed(path) ? this.app.vault.getFileByPath(path) : null;
  }

  async fileExists(path: string): Promise<boolean> {
    if (this.scope.isIndexed(path)) return this.app.vault.getFileByPath(path) !== null;
    const stat = await this.adapter.stat(path);
    return stat?.type === "file";
  }

  async folderExists(path: string): Promise<boolean> {
    if (this.scope.isIndexed(path)) return this.app.vault.getFolderByPath(path) !== null;
    const stat = await this.adapter.stat(path);
    return stat?.type === "folder";
  }

  exists(path: string): Promise<boolean> {
    return this.adapter.exists(path);
  }

  async stat(path: string): Promise<LocalEntry | null> {
    const stat = await this.adapter.stat(path);
    return stat && stat.type === "file" ? { path, mtime: stat.mtime, size: stat.size } : null;
  }

  read(path: string): Promise<ArrayBuffer> {
    const file = this.indexedFile(path);
    if (file) return this.app.vault.readBinary(file);
    if (this.scope.isIndexed(path)) return Promise.reject(new Error("O arquivo não existe mais no cofre."));
    return this.adapter.readBinary(path);
  }

  async write(path: string, data: ArrayBuffer, mtime: number): Promise<LocalEntry> {
    const options = mtime > 0 ? { mtime } : undefined;
    await this.ensureFolder(parentOf(path));

    if (this.scope.isIndexed(path)) {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, data, options);
      else if (existing) throw new Error(`Já existe uma pasta com o nome “${path}”.`);
      else await this.app.vault.createBinary(path, data, options);
    } else {
      await this.adapter.writeBinary(path, data, options);
    }

    const stat = await this.stat(path);
    return stat ?? { path, mtime: mtime || Date.now(), size: data.byteLength };
  }

  async trash(path: string): Promise<void> {
    const file = this.indexedFile(path);
    if (file) {
      await this.app.fileManager.trashFile(file);
      return;
    }
    if (this.scope.isIndexed(path)) return;
    if (await this.adapter.exists(path)) await this.adapter.trashLocal(path);
  }

  async rename(from: string, to: string): Promise<void> {
    if (await this.exists(to)) throw new Error(`Já existe um item com o nome “${to}”.`);
    await this.ensureFolder(parentOf(to));
    const source = this.scope.isIndexed(from) ? this.app.vault.getAbstractFileByPath(from) : null;
    if (source && this.scope.isIndexed(to)) await this.app.vault.rename(source, to);
    else await this.adapter.rename(from, to);

    for (const folder of [...this.folders]) {
      if (folder === from || folder.startsWith(from + "/")) {
        this.folders.delete(folder);
        this.folders.add(to + folder.slice(from.length));
      }
    }
  }

  ensureFolder(path: string): Promise<void> {
    if (!path) return Promise.resolve();
    const pending = this.folderCreation.get(path);
    if (pending) return pending;
    const creation = this.createFolder(path).finally(() => this.folderCreation.delete(path));
    this.folderCreation.set(path, creation);
    return creation;
  }

  private async createFolder(path: string): Promise<void> {
    await this.ensureFolder(parentOf(path));
    if (this.scope.isIndexed(path)) {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing && !(existing instanceof TFolder)) {
        throw new Error(`Já existe um arquivo com o nome da pasta “${path}”.`);
      }
      if (!existing) {
        try {
          await this.app.vault.createFolder(path);
        } catch (error) {
          if (!(this.app.vault.getAbstractFileByPath(path) instanceof TFolder)) throw error;
        }
      }
    } else {
      const stat = await this.adapter.stat(path);
      if (stat?.type === "file") throw new Error(`Já existe um arquivo com o nome da pasta “${path}”.`);
      if (!stat) await this.adapter.mkdir(path);
    }
    if (this.scope.includes(path)) this.folders.add(path);
  }

  async removeEmptyFolder(path: string): Promise<boolean> {
    if (!path || path === this.scope.configDir) return false;
    if (this.scope.isIndexed(path)) {
      const folder = this.app.vault.getFolderByPath(path);
      if (!folder) {
        this.folders.delete(path);
        return true;
      }
      if (folder.children.length > 0) return false;
      const listing = await this.adapter.list(path);
      if (listing.files.length > 0 || listing.folders.length > 0) return false;
      await this.app.fileManager.trashFile(folder);
    } else {
      const stat = await this.adapter.stat(path);
      if (!stat) {
        this.folders.delete(path);
        return true;
      }
      if (stat.type !== "folder") return false;
      const listing = await this.adapter.list(path);
      if (listing.files.length > 0 || listing.folders.length > 0) return false;
      await this.adapter.rmdir(path, false);
    }
    this.folders.delete(path);
    return true;
  }
}
