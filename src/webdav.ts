import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { walkTree } from "./concurrency";

export interface RemoteEntry {
  path: string;
  isDir: boolean;
  etag: string;
  size: number;
  mtime: number;
  fileId: string;
}

export interface RemoteListing {
  files: Map<string, RemoteEntry>;
  dirs: Map<string, RemoteEntry>;
  rootExists: boolean;
  skipped: string[];
}

export interface PutResult {
  etag: string;
  fileId: string;
}

export interface NextcloudConfig {
  serverUrl: string;
  loginName: string;
  password: string;
  userId: string;
  remoteFolder: string;
}

export type DeleteResult = "deleted" | "missing" | "changed";

export type MoveResult = "moved" | "missing" | "exists";

export class NextcloudError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "NextcloudError";
  }
}

const OC_NS = "http://owncloud.org/ns";

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  `<d:propfind xmlns:d="DAV:" xmlns:oc="${OC_NS}"><d:prop>` +
  "<d:resourcetype/><d:getetag/><d:getcontentlength/><d:getlastmodified/><oc:fileid/>" +
  "</d:prop></d:propfind>";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function header(res: RequestUrlResponse, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(res.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return "";
}

function childText(el: Element, localName: string, namespace = "DAV:"): string {
  return el.getElementsByTagNameNS(namespace, localName)[0]?.textContent?.trim() ?? "";
}

function describeStatus(status: number): string {
  switch (status) {
    case 401:
      return "Autenticação recusada. Verifique o usuário e a senha de aplicativo.";
    case 403:
      return "Acesso negado pelo servidor (HTTP 403).";
    case 404:
      return "Caminho não encontrado no servidor (HTTP 404).";
    case 423:
      return "Arquivo bloqueado no servidor (HTTP 423). Tente novamente em instantes.";
    case 507:
      return "Espaço insuficiente na conta do Nextcloud (HTTP 507).";
    default:
      return `Resposta inesperada do servidor (HTTP ${status}).`;
  }
}

export function normalizeEtag(etag: string): string {
  return etag.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
}

export function sameEtag(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return normalizeEtag(a) === normalizeEtag(b);
}

export function encodePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

export function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  if (hasControlCharacter(path)) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function validateServerUrl(input: string): string {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NextcloudError("O endereço do servidor é inválido.");
  }
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new NextcloudError("Por segurança, o endereço do servidor precisa usar HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new NextcloudError("O endereço do servidor não pode conter usuário, senha, parâmetros ou âncoras.");
  }
  if (/\/(remote|index)\.php(\/|$)/i.test(url.pathname)) {
    throw new NextcloudError("Informe apenas o endereço raiz do Nextcloud, sem “/remote.php/…”.");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function validateRemoteFolder(input: string): string {
  const folder = input.trim().replace(/^\/+|\/+$/g, "");
  if (!folder) {
    throw new NextcloudError("Defina uma pasta remota. Sincronizar a raiz da conta não é permitido.");
  }
  if (!isSafeRelativePath(folder)) {
    throw new NextcloudError("O nome da pasta remota contém caracteres ou segmentos inválidos.");
  }
  return folder;
}

export class NextcloudClient {
  readonly server: string;
  readonly remoteRoot: string;
  private readonly auth: string;
  private readonly userId: string;
  private readonly dirCreation = new Map<string, Promise<void>>();
  private readonly createdDirIds = new Map<string, string>();

  constructor(config: NextcloudConfig) {
    this.server = validateServerUrl(config.serverUrl);
    this.remoteRoot = validateRemoteFolder(config.remoteFolder);
    this.userId = config.userId;
    this.auth = "Basic " + toBase64(`${config.loginName}:${config.password}`);
  }

  static async discoverUser(serverUrl: string, loginName: string, password: string): Promise<{ id: string; displayName: string }> {
    const server = validateServerUrl(serverUrl);
    const res = await requestUrl({
      url: `${server}/ocs/v2.php/cloud/user?format=json`,
      method: "GET",
      headers: {
        Authorization: "Basic " + toBase64(`${loginName}:${password}`),
        "OCS-APIRequest": "true",
        Accept: "application/json",
      },
      throw: false,
    });
    if (res.status !== 200) throw new NextcloudError(describeStatus(res.status), res.status);

    let body: unknown;
    try {
      body = res.json;
    } catch {
      body = undefined;
    }
    const ocs = isRecord(body) ? body.ocs : undefined;
    const data = isRecord(ocs) && isRecord(ocs.data) ? ocs.data : {};
    const id = stringField(data, "id");
    if (!id) {
      throw new NextcloudError("O servidor respondeu, mas não parece ser um Nextcloud. Confira o endereço.");
    }
    const displayName = stringField(data, "display-name") || stringField(data, "displayname") || id;
    return { id, displayName };
  }

  private get davBase(): string {
    return `${this.server}/remote.php/dav/files/${encodeURIComponent(this.userId)}`;
  }

  private get rootUrl(): string {
    return `${this.davBase}/${encodePath(this.remoteRoot)}`;
  }

  private urlFor(relPath: string): string {
    const rel = encodePath(relPath);
    return rel ? `${this.rootUrl}/${rel}` : this.rootUrl;
  }

  private request(params: RequestUrlParam): Promise<RequestUrlResponse> {
    return requestUrl({
      ...params,
      headers: { ...(params.headers ?? {}), Authorization: this.auth },
      throw: false,
    });
  }

  private parseMultistatus(xml: string): RemoteEntry[] {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) {
      throw new NextcloudError("O servidor devolveu uma resposta WebDAV ilegível.");
    }
    const rootPath = decodeURIComponent(new URL(this.rootUrl).pathname).replace(/\/+$/, "");
    const entries: RemoteEntry[] = [];

    for (const response of Array.from(doc.getElementsByTagNameNS("DAV:", "response"))) {
      const href = childText(response, "href");
      if (!href) continue;
      let fullPath: string;
      try {
        fullPath = decodeURIComponent(new URL(href, this.server + "/").pathname).replace(/\/+$/, "");
      } catch {
        continue;
      }
      if (fullPath !== rootPath && !fullPath.startsWith(rootPath + "/")) continue;

      const entry: RemoteEntry = {
        path: fullPath.slice(rootPath.length).replace(/^\/+/, ""),
        isDir: false,
        etag: "",
        size: 0,
        mtime: 0,
        fileId: "",
      };
      for (const propstat of Array.from(response.getElementsByTagNameNS("DAV:", "propstat"))) {
        if (!/\s200\s/.test(` ${childText(propstat, "status")} `)) continue;
        entry.isDir = propstat.getElementsByTagNameNS("DAV:", "collection").length > 0;
        entry.etag = childText(propstat, "getetag");
        entry.size = parseInt(childText(propstat, "getcontentlength") || "0", 10) || 0;
        const modified = childText(propstat, "getlastmodified");
        entry.mtime = modified ? Date.parse(modified) || 0 : 0;
        entry.fileId = childText(propstat, "fileid", OC_NS);
      }
      entries.push(entry);
    }
    return entries;
  }

  private async propfind(relPath: string, depth: "0" | "1"): Promise<RemoteEntry[] | null> {
    const res = await this.request({
      url: this.urlFor(relPath) + (depth === "1" ? "/" : ""),
      method: "PROPFIND",
      headers: { Depth: depth, "Content-Type": "application/xml; charset=utf-8" },
      body: PROPFIND_BODY,
    });
    if (res.status === 404) return null;
    if (res.status !== 207) throw new NextcloudError(describeStatus(res.status), res.status);
    return this.parseMultistatus(res.text);
  }

  async listAll(descends: (dir: string) => boolean, concurrency: number): Promise<RemoteListing> {
    const listing: RemoteListing = { files: new Map(), dirs: new Map(), rootExists: true, skipped: [] };

    await walkTree([""], concurrency, async (dir) => {
      const entries = await this.propfind(dir, "1");
      if (entries === null) {
        if (dir === "") listing.rootExists = false;
        return [];
      }
      const children: string[] = [];
      for (const entry of entries) {
        if (entry.path === dir) continue;
        if (!isSafeRelativePath(entry.path)) {
          listing.skipped.push(entry.path);
          continue;
        }
        if (entry.isDir) {
          listing.dirs.set(entry.path, entry);
          if (descends(entry.path)) children.push(entry.path);
        } else {
          listing.files.set(entry.path, entry);
        }
      }
      return children;
    });
    return listing;
  }

  async stat(relPath: string): Promise<RemoteEntry | null> {
    const entries = await this.propfind(relPath, "0");
    return entries?.[0] ?? null;
  }

  async get(relPath: string): Promise<{ data: ArrayBuffer; etag: string }> {
    const res = await this.request({ url: this.urlFor(relPath), method: "GET" });
    if (res.status !== 200) throw new NextcloudError(describeStatus(res.status), res.status);
    return { data: res.arrayBuffer, etag: header(res, "etag") };
  }

  async put(relPath: string, data: ArrayBuffer, mtimeMs: number): Promise<PutResult> {
    const headers: Record<string, string> = {};
    if (mtimeMs > 0) headers["X-OC-Mtime"] = String(Math.floor(mtimeMs / 1000));
    const res = await this.request({
      url: this.urlFor(relPath),
      method: "PUT",
      headers,
      contentType: "application/octet-stream",
      body: data,
    });
    if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
      throw new NextcloudError(describeStatus(res.status), res.status);
    }
    const etag = header(res, "etag") || header(res, "oc-etag");
    const fileId = header(res, "oc-fileid");
    if (etag && fileId) return { etag, fileId };
    const stat = await this.stat(relPath);
    return { etag: etag || (stat?.etag ?? ""), fileId: fileId || (stat?.fileId ?? "") };
  }

  async move(from: string, to: string, known: Set<string>): Promise<MoveResult> {
    const parent = to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "";
    if (parent) await this.ensureDir(parent, known);
    const res = await this.request({
      url: this.urlFor(from),
      method: "MOVE",
      headers: { Destination: this.urlFor(to), Overwrite: "F" },
    });
    if (res.status === 201 || res.status === 204) return "moved";
    if (res.status === 404) return "missing";
    if (res.status === 412) return "exists";
    throw new NextcloudError(describeStatus(res.status), res.status);
  }

  async isEmptyDir(relPath: string): Promise<boolean> {
    const entries = await this.propfind(relPath, "1");
    if (entries === null) return false;
    return entries.every((entry) => entry.path === relPath);
  }

  async deleteEmptyDir(relPath: string): Promise<boolean> {
    if (!relPath || !(await this.isEmptyDir(relPath))) return false;
    const res = await this.request({ url: this.urlFor(relPath) + "/", method: "DELETE" });
    if (res.status === 204 || res.status === 200 || res.status === 404) return true;
    throw new NextcloudError(describeStatus(res.status), res.status);
  }

  async delete(relPath: string, expectedEtag?: string): Promise<DeleteResult> {
    const headers: Record<string, string> = {};
    if (expectedEtag) headers["If-Match"] = `"${normalizeEtag(expectedEtag)}"`;
    const res = await this.request({ url: this.urlFor(relPath), method: "DELETE", headers });
    if (res.status === 204 || res.status === 200) return "deleted";
    if (res.status === 404) return "missing";
    if (res.status === 412) return "changed";
    throw new NextcloudError(describeStatus(res.status), res.status);
  }

  private async mkcol(url: string): Promise<string> {
    const res = await this.request({ url, method: "MKCOL" });
    if (res.status !== 201 && res.status !== 405) {
      throw new NextcloudError(describeStatus(res.status), res.status);
    }
    return res.status === 201 ? header(res, "oc-fileid") : "";
  }

  createdFolderId(relDir: string): string | undefined {
    return this.createdDirIds.get(relDir);
  }

  async ensureRoot(): Promise<void> {
    let url = this.davBase;
    for (const segment of this.remoteRoot.split("/")) {
      url += "/" + encodeURIComponent(segment);
      await this.mkcol(url);
    }
  }

  async ensureDir(relDir: string, known: Set<string>): Promise<void> {
    let current = "";
    for (const segment of relDir.split("/").filter((s) => s.length > 0)) {
      current = current ? `${current}/${segment}` : segment;
      if (known.has(current)) continue;
      await this.createDirOnce(current, known);
    }
  }

  private createDirOnce(relDir: string, known: Set<string>): Promise<void> {
    const pending = this.dirCreation.get(relDir);
    if (pending) return pending;
    const creation = this.mkcol(this.urlFor(relDir))
      .then((fileId) => {
        if (fileId) this.createdDirIds.set(relDir, fileId);
        known.add(relDir);
      })
      .finally(() => this.dirCreation.delete(relDir));
    this.dirCreation.set(relDir, creation);
    return creation;
  }
}
