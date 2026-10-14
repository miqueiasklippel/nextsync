import { Notice, Plugin, TAbstractFile, TFolder } from "obsidian";
import { clampConcurrency } from "./concurrency";
import { DeletionModal } from "./deletion-modal";
import { SyncScope } from "./scope";
import { DEFAULT_SETTINGS, NextSyncSettings, NextSyncSettingTab } from "./settings";
import {
  MoveJournal,
  STATE_VERSION,
  SyncEngine,
  SyncReport,
  SyncState,
  emptyState,
  migrateState,
} from "./sync";
import { NextcloudClient, validateRemoteFolder, validateServerUrl } from "./webdav";

interface StoredData {
  settings: Partial<NextSyncSettings> & { appPassword?: string };
  syncState: unknown;
  stateVersion: number;
  pendingMoves: MoveJournal;
  stateKey: string;
  lastSync: number;
}

const DELETE_DEBOUNCE_MS = 600;
const PERSIST_DEBOUNCE_MS = 800;
const LEGACY_SECRET_ID = "nextsync-app-password";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default class NextSyncPlugin extends Plugin {
  settings: NextSyncSettings = { ...DEFAULT_SETTINGS };
  private syncState: SyncState = emptyState();
  private journal: MoveJournal = {};
  private stateKey = "";
  private lastSync = 0;
  private syncing = false;
  private queue: Promise<unknown> = Promise.resolve();
  private statusEl: HTMLElement | null = null;
  private autoSyncId: number | null = null;
  private deleteTimer: number | null = null;
  private persistTimer: number | null = null;
  private readonly pendingDeletes = new Set<string>();
  private readonly ownDeletions = new Set<string>();
  private readonly ownRenames = new Set<string>();

  async onload(): Promise<void> {
    await this.loadAll();

    this.addSettingTab(new NextSyncSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "NextSync: sincronizar agora", () => void this.sync());
    this.statusEl = this.addStatusBarItem();
    this.updateIdleStatus();

    this.addCommand({ id: "sync-now", name: "Sincronizar agora", callback: () => void this.sync() });
    this.addCommand({
      id: "reset-state",
      name: "Redefinir estado de sincronização",
      callback: async () => {
        await this.resetState();
        new Notice("NextSync: estado de sincronização redefinido.");
      },
    });

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultDelete(file)));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onVaultRename(file, oldPath)));
      if (this.settings.syncOnStartup) void this.sync(true);
    });
    this.restartAutoSync();
  }

  onunload(): void {
    if (this.autoSyncId !== null) window.clearInterval(this.autoSyncId);
    if (this.deleteTimer !== null) window.clearTimeout(this.deleteTimer);
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      void this.persist();
    }
  }

  async saveSettings(): Promise<void> {
    await this.persist();
  }

  async resetState(): Promise<void> {
    await this.exclusive(async () => {
      this.syncState = emptyState();
      this.journal = {};
      this.stateKey = "";
      await this.persist();
    });
  }

  restartAutoSync(): void {
    if (this.autoSyncId !== null) {
      window.clearInterval(this.autoSyncId);
      this.autoSyncId = null;
    }
    const minutes = this.settings.autoSyncMinutes;
    if (minutes > 0) {
      this.autoSyncId = window.setInterval(() => void this.sync(true), minutes * 60_000);
      this.registerInterval(this.autoSyncId);
    }
  }

  async testConnection(): Promise<{ id: string; displayName: string }> {
    const s = this.settings;
    const password = this.resolvePassword();
    if (!s.serverUrl || !s.loginName || !password) {
      throw new Error("Preencha o endereço, o usuário e a senha de aplicativo.");
    }
    const user = await NextcloudClient.discoverUser(s.serverUrl, s.loginName, password);
    s.userId = user.id;
    await this.persist();
    return user;
  }

  async sync(silent = false): Promise<void> {
    if (this.syncing) {
      if (!silent) new Notice("NextSync: já há uma sincronização em andamento.");
      return;
    }
    this.syncing = true;
    this.setStatus("sincronizando…");
    try {
      await this.exclusive(() => this.runSync(silent));
    } catch (error) {
      console.error("[NextSync]", error);
      new Notice(`NextSync: ${errorMessage(error)}`, 12_000);
    } finally {
      this.syncing = false;
      this.ownRenames.clear();
      await this.persist();
      this.updateIdleStatus();
    }
  }

  private scope(): SyncScope {
    const s = this.settings;
    return new SyncScope({
      configDir: this.app.vault.configDir,
      pluginId: this.manifest.id,
      ignorePaths: s.ignorePaths,
      syncHidden: s.syncHidden,
      syncConfig: s.syncConfig,
      syncPlugins: s.syncConfig && s.syncPlugins,
    });
  }

  private async runSync(silent: boolean): Promise<void> {
    const client = await this.createClient();
    this.alignStateWithTarget();

    const engine = new SyncEngine(this.app, client, this.settings, this.scope(), this.syncState, this.journal, {
      onProgress: (done, total) => this.setStatus(total > 0 ? `sincronizando ${done}/${total}` : "sincronizando…"),
      persist: () => this.persist(),
      beforeLocalTrash: (path) => {
        this.ownDeletions.add(path);
      },
      beforeLocalRename: (from) => {
        this.ownRenames.add(from);
      },
      confirmRemoteDeletions: async (paths) => {
        const choice = await new DeletionModal(this.app, {
          title: "Confirmar exclusões no Nextcloud",
          message: `${paths.length} item(ns) não existem mais no cofre. Deseja excluí-los também da pasta “${this.settings.remoteFolder}” no Nextcloud?`,
          keepHint: "Se mantiver, os itens serão baixados novamente para o cofre.",
          items: paths,
        }).ask();
        return choice === "delete";
      },
    });

    const report = await engine.run();
    this.lastSync = Date.now();
    this.notifyReport(report, silent);
  }

  private isOwnRename(oldPath: string): boolean {
    for (const from of this.ownRenames) {
      if (isUnder(oldPath, from)) return true;
    }
    return false;
  }

  private onVaultRename(file: TAbstractFile, oldPath: string): void {
    if (this.isOwnRename(oldPath)) return;
    const newPath = file.path;
    const recorded = this.journal[oldPath];
    if (recorded === undefined && newPath in this.journal) return;

    const origin = recorded ?? oldPath;
    delete this.journal[oldPath];
    if (file instanceof TFolder) {
      for (const [to, from] of Object.entries(this.journal)) {
        if (isUnder(to, oldPath)) {
          delete this.journal[to];
          this.journal[newPath + to.slice(oldPath.length)] = from;
        }
      }
    }
    if (origin !== newPath) this.journal[newPath] = origin;
    this.schedulePersist();
  }

  private onVaultDelete(file: TAbstractFile): void {
    if (this.ownDeletions.delete(file.path)) return;

    const origins = [file.path];
    for (const [to, from] of Object.entries(this.journal)) {
      if (isUnder(to, file.path)) {
        delete this.journal[to];
        origins.push(from);
      }
    }
    this.schedulePersist();

    const s = this.settings;
    if (!s.propagateDeletions || !s.confirmRemoteDeletion) return;
    const scope = this.scope();
    const relevant = origins.filter((path) => scope.includes(path));
    if (relevant.length === 0) return;

    for (const path of relevant) this.pendingDeletes.add(path);
    if (this.deleteTimer !== null) window.clearTimeout(this.deleteTimer);
    this.deleteTimer = window.setTimeout(() => {
      this.deleteTimer = null;
      const paths = [...this.pendingDeletes];
      this.pendingDeletes.clear();
      void this.exclusive(() => this.handleUserDeletion(paths)).catch((error) => {
        console.error("[NextSync]", error);
        new Notice(`NextSync: ${errorMessage(error)}`, 10_000);
      });
    }, DELETE_DEBOUNCE_MS);
  }

  private async handleUserDeletion(deletedPaths: string[]): Promise<void> {
    if (this.stateKey !== this.currentTargetKey()) return;
    const adapter = this.app.vault.adapter;
    const isAffected = (path: string) => deletedPaths.some((deleted) => isUnder(path, deleted));

    const files: string[] = [];
    for (const path of Object.keys(this.syncState.files).filter(isAffected)) {
      if (!(await adapter.exists(path))) files.push(path);
    }
    const folders: string[] = [];
    for (const path of Object.keys(this.syncState.folders).filter(isAffected)) {
      if (!(await adapter.exists(path))) folders.push(path);
    }
    if (files.length === 0 && folders.length === 0) return;

    const items = [...files, ...folders.map((path) => `${path}/`)].sort();
    const choice = await new DeletionModal(this.app, {
      title: "Excluir também no Nextcloud?",
      message: `Você excluiu ${items.length} item(ns) sincronizado(s). Eles também serão excluídos da pasta “${this.settings.remoteFolder}” no Nextcloud, onde ficarão na lixeira do servidor.`,
      keepHint: "Se mantiver, os itens continuarão no Nextcloud e voltarão para o cofre na próxima sincronização.",
      items,
    }).ask();

    if (choice === "keep") {
      for (const path of files) delete this.syncState.files[path];
      for (const path of folders) delete this.syncState.folders[path];
      await this.persist();
      new Notice("NextSync: os itens foram mantidos no Nextcloud e voltarão na próxima sincronização.");
      return;
    }

    await this.deleteRemoteNow(files, folders);
  }

  private async deleteRemoteNow(files: string[], folders: string[]): Promise<void> {
    let client: NextcloudClient;
    try {
      client = await this.createClient();
    } catch (error) {
      new Notice(`NextSync: ${errorMessage(error)} A exclusão será feita na próxima sincronização.`, 10_000);
      return;
    }

    let deleted = 0;
    let kept = 0;
    let failed = 0;
    for (const path of files) {
      try {
        const result = await client.delete(path, this.syncState.files[path]?.etag);
        if (result === "changed") kept++;
        else deleted++;
        delete this.syncState.files[path];
      } catch (error) {
        failed++;
        console.error("[NextSync]", path, error);
      }
    }

    const byDepth = [...folders].sort((a, b) => b.split("/").length - a.split("/").length);
    for (const path of byDepth) {
      try {
        if (await client.deleteEmptyDir(path)) deleted++;
        else kept++;
        delete this.syncState.folders[path];
      } catch (error) {
        failed++;
        console.error("[NextSync]", path, error);
      }
    }
    await this.persist();

    const parts = [`${deleted} item(ns) excluído(s) no Nextcloud`];
    if (kept) parts.push(`${kept} mantido(s) por terem sido alterados ou não estarem vazios no servidor`);
    if (failed) parts.push(`${failed} pendente(s) para a próxima sincronização`);
    new Notice(`NextSync: ${parts.join("; ")}.`, kept || failed ? 10_000 : 5_000);
  }

  private async createClient(): Promise<NextcloudClient> {
    const s = this.settings;
    const password = this.resolvePassword();
    if (!s.serverUrl || !s.loginName || !password) {
      throw new Error("Configure o endereço, o usuário e a senha de aplicativo nas configurações do plugin.");
    }
    if (!s.userId) {
      s.userId = (await NextcloudClient.discoverUser(s.serverUrl, s.loginName, password)).id;
      await this.persist();
    }
    return new NextcloudClient({
      serverUrl: s.serverUrl,
      loginName: s.loginName,
      password,
      userId: s.userId,
      remoteFolder: s.remoteFolder,
    });
  }

  private resolvePassword(): string {
    const id = this.settings.passwordSecretId;
    return id ? (this.app.secretStorage.getSecret(id) ?? "") : "";
  }

  private migrateLegacyPassword(legacyPassword: string | undefined): boolean {
    if (!legacyPassword) return false;
    if (!this.settings.passwordSecretId) {
      try {
        this.app.secretStorage.setSecret(LEGACY_SECRET_ID, legacyPassword);
        this.settings.passwordSecretId = LEGACY_SECRET_ID;
      } catch (error) {
        console.error("[NextSync] Não foi possível migrar a senha para o armazenamento de segredos.", error);
        new Notice("NextSync: selecione novamente a senha de aplicativo nas configurações do plugin.", 10_000);
      }
    }
    return true;
  }

  private currentTargetKey(): string {
    const s = this.settings;
    try {
      return `${validateServerUrl(s.serverUrl)}|${s.userId}|${validateRemoteFolder(s.remoteFolder)}`;
    } catch {
      return "";
    }
  }

  private alignStateWithTarget(): void {
    const key = this.currentTargetKey();
    if (key !== this.stateKey) {
      this.syncState = emptyState();
      this.journal = {};
      this.stateKey = key;
    }
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async loadAll(): Promise<void> {
    const raw: unknown = await this.loadData();
    const data: Partial<StoredData> = isRecord(raw) ? raw : {};
    const { appPassword, ...stored } = data.settings ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...stored };
    this.settings.concurrency = clampConcurrency(this.settings.concurrency);
    this.syncState = migrateState(data.syncState, data.stateVersion);
    this.journal = isRecord(data.pendingMoves) ? data.pendingMoves : {};
    this.stateKey = data.stateKey ?? "";
    this.lastSync = data.lastSync ?? 0;
    const migrated = data.stateVersion !== STATE_VERSION && data.syncState !== undefined;
    if (this.migrateLegacyPassword(appPassword) || migrated) await this.persist();
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    const data: StoredData = {
      settings: this.settings,
      syncState: this.syncState,
      stateVersion: STATE_VERSION,
      pendingMoves: this.journal,
      stateKey: this.stateKey,
      lastSync: this.lastSync,
    };
    await this.saveData(data);
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(`NextSync: ${text}`);
  }

  private updateIdleStatus(): void {
    if (!this.lastSync) {
      this.setStatus("nunca sincronizado");
      return;
    }
    const date = new Date(this.lastSync);
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    this.setStatus(`sincronizado às ${time}`);
  }

  private notifyReport(report: SyncReport, silent: boolean): void {
    const parts: string[] = [];
    if (report.uploaded) parts.push(`${report.uploaded} enviado(s)`);
    if (report.downloaded) parts.push(`${report.downloaded} baixado(s)`);
    if (report.moved) parts.push(`${report.moved} renomeado(s) ou movido(s)`);
    if (report.deletedLocal) parts.push(`${report.deletedLocal} excluído(s) no cofre`);
    if (report.deletedRemote) parts.push(`${report.deletedRemote} excluído(s) no Nextcloud`);
    if (report.foldersCreated) parts.push(`${report.foldersCreated} pasta(s) criada(s)`);
    if (report.foldersDeleted) parts.push(`${report.foldersDeleted} pasta(s) excluída(s)`);
    if (report.restored) parts.push(`${report.restored} restaurado(s) por alteração no servidor`);

    if (parts.length > 0 || !silent) {
      new Notice(`NextSync: ${parts.length > 0 ? parts.join(", ") : "tudo em dia"}.`);
    }
    if (report.conflicts.length > 0) {
      new Notice(
        `NextSync: ${report.conflicts.length} conflito(s). A versão do servidor foi guardada como cópia “(conflito …)”:\n` +
          report.conflicts.join("\n"),
        15_000,
      );
    }
    if (report.errors.length > 0) {
      new Notice(`NextSync: ${report.errors.length} erro(s):\n${report.errors.slice(0, 5).join("\n")}`, 15_000);
    }
  }
}
