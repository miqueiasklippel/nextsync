export interface ScopeOptions {
  configDir: string;
  pluginId: string;
  ignorePaths: string[];
  syncHidden: boolean;
  syncConfig: boolean;
  syncPlugins: boolean;
}

const ALWAYS_EXCLUDED_NAMES = new Set([".git", ".trash", ".DS_Store", "Thumbs.db", "desktop.ini"]);

function segmentsOf(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

export class SyncScope {
  readonly configDir: string;
  private readonly ownPluginDir: string;
  private readonly pluginsDir: string;
  private readonly configExcluded: string[];
  private readonly ignored: string[];

  constructor(private readonly options: ScopeOptions) {
    this.configDir = options.configDir;
    this.pluginsDir = `${options.configDir}/plugins`;
    this.ownPluginDir = `${this.pluginsDir}/${options.pluginId}`;
    this.configExcluded = [
      `${options.configDir}/workspace.json`,
      `${options.configDir}/workspace-mobile.json`,
      `${options.configDir}/cache`,
    ];
    this.ignored = options.ignorePaths
      .map((raw) => raw.trim().replace(/^\/+|\/+$/g, ""))
      .filter((prefix) => prefix.length > 0);
  }

  get syncHidden(): boolean {
    return this.options.syncHidden;
  }

  isConfigPath(path: string): boolean {
    return isUnder(path, this.configDir);
  }

  isIndexed(path: string): boolean {
    if (this.isConfigPath(path)) return false;
    return !segmentsOf(path).some((segment) => segment.startsWith("."));
  }

  includes(path: string): boolean {
    if (!path || path === this.configDir) return false;
    return this.allows(path);
  }

  descends(dir: string): boolean {
    if (!dir) return true;
    if (dir === this.configDir) return this.options.syncConfig;
    return this.allows(dir);
  }

  private allows(path: string): boolean {
    const segments = segmentsOf(path);
    if (segments.some((segment) => ALWAYS_EXCLUDED_NAMES.has(segment) || segment.startsWith(".Trash-"))) {
      return false;
    }
    if (this.ignored.some((prefix) => isUnder(path, prefix))) return false;

    if (this.isConfigPath(path)) {
      if (!this.options.syncConfig) return false;
      if (isUnder(path, this.ownPluginDir)) return false;
      if (this.configExcluded.some((excluded) => isUnder(path, excluded))) return false;
      if (isUnder(path, this.pluginsDir) || path === `${this.configDir}/community-plugins.json`) {
        return this.options.syncPlugins;
      }
      return true;
    }

    if (segments.some((segment) => segment.startsWith("."))) return this.options.syncHidden;
    return true;
  }
}
