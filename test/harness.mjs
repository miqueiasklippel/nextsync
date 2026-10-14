import { TFile, TFolder } from "obsidian";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parentOf(path) {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

function isUnder(path, prefix) {
  return path === prefix || path.startsWith(prefix + "/");
}

function toBuffer(data) {
  const bytes = typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);
  return bytes.slice().buffer;
}

export class MemoryVault {
  constructor(configDir = ".obsidian") {
    this.configDir = configDir;
    this.files = new Map();
    this.dirs = new Set();
    this.clock = 1_000_000;
    this.events = [];
    this.adapter = this.createAdapter();
    this.fileManager = { trashFile: async (file) => this.trashPath(file.path) };
  }

  tick() {
    this.clock += 1000;
    return this.clock;
  }

  isIndexed(path) {
    if (isUnder(path, this.configDir)) return false;
    return !path.split("/").some((segment) => segment.startsWith("."));
  }

  ensureParents(path) {
    let current = "";
    for (const segment of parentOf(path).split("/").filter(Boolean)) {
      current = current ? `${current}/${segment}` : segment;
      this.dirs.add(current);
    }
  }

  requireParent(path) {
    const parent = parentOf(path);
    if (parent && !this.dirs.has(parent)) throw new Error(`Pasta inexistente: ${parent}`);
  }

  put(path, text, mtime) {
    this.ensureParents(path);
    this.files.set(path, { data: toBuffer(text), mtime: mtime ?? this.tick() });
  }

  mkdirp(path) {
    this.ensureParents(`${path}/x`);
  }

  read(path) {
    const file = this.files.get(path);
    return file ? decoder.decode(file.data) : undefined;
  }

  remove(path) {
    this.files.delete(path);
  }

  removeTree(path) {
    for (const key of [...this.files.keys()]) if (isUnder(key, path)) this.files.delete(key);
    for (const key of [...this.dirs]) if (isUnder(key, path)) this.dirs.delete(key);
  }

  moveTree(from, to) {
    if (this.files.has(to) || this.dirs.has(to)) throw new Error(`Destino existe: ${to}`);
    this.requireParent(to);
    for (const key of [...this.files.keys()]) {
      if (isUnder(key, from)) {
        this.files.set(to + key.slice(from.length), this.files.get(key));
        this.files.delete(key);
      }
    }
    for (const key of [...this.dirs]) {
      if (isUnder(key, from)) {
        this.dirs.delete(key);
        this.dirs.add(to + key.slice(from.length));
      }
    }
  }

  trashPath(path) {
    const target = `.trash/${path.split("/").pop()}-${this.tick()}`;
    this.ensureParents(target);
    if (this.files.has(path)) {
      this.files.set(target, this.files.get(path));
      this.files.delete(path);
    } else {
      this.removeTree(path);
    }
  }

  tfile(path) {
    const entry = this.files.get(path);
    const file = new TFile();
    file.path = path;
    file.stat = { mtime: entry.mtime, ctime: entry.mtime, size: entry.data.byteLength };
    return file;
  }

  tfolder(path) {
    const folder = new TFolder();
    folder.path = path;
    const children = [];
    for (const key of this.files.keys()) if (parentOf(key) === path && this.isIndexed(key)) children.push(this.tfile(key));
    for (const key of this.dirs) if (parentOf(key) === path && this.isIndexed(key)) children.push(this.tfolder(key));
    folder.children = children;
    return folder;
  }

  getFiles() {
    return [...this.files.keys()].filter((path) => this.isIndexed(path)).map((path) => this.tfile(path));
  }

  getAllFolders() {
    return [...this.dirs].filter((path) => this.isIndexed(path)).map((path) => this.tfolder(path));
  }

  getFileByPath(path) {
    return this.isIndexed(path) && this.files.has(path) ? this.tfile(path) : null;
  }

  getFolderByPath(path) {
    return this.isIndexed(path) && this.dirs.has(path) ? this.tfolder(path) : null;
  }

  getAbstractFileByPath(path) {
    return this.getFileByPath(path) ?? this.getFolderByPath(path);
  }

  async readBinary(file) {
    return this.files.get(file.path).data.slice(0);
  }

  async modifyBinary(file, data, options) {
    this.files.set(file.path, { data: data.slice(0), mtime: options?.mtime ?? this.tick() });
  }

  async createBinary(path, data, options) {
    if (this.files.has(path) || this.dirs.has(path)) throw new Error(`Já existe: ${path}`);
    this.requireParent(path);
    this.files.set(path, { data: data.slice(0), mtime: options?.mtime ?? this.tick() });
    return this.tfile(path);
  }

  async createFolder(path) {
    if (this.files.has(path) || this.dirs.has(path)) throw new Error(`Já existe: ${path}`);
    this.requireParent(path);
    this.dirs.add(path);
  }

  async rename(file, newPath) {
    this.events.push(["rename", file.path, newPath]);
    this.moveTree(file.path, newPath);
  }

  createAdapter() {
    const vault = this;
    const clean = (path) => path.replace(/^\/+|\/+$/g, "");
    return {
      async list(path) {
        const dir = clean(path);
        if (dir && !vault.dirs.has(dir)) throw new Error(`Pasta inexistente: ${dir}`);
        return {
          files: [...vault.files.keys()].filter((key) => parentOf(key) === dir),
          folders: [...vault.dirs].filter((key) => parentOf(key) === dir),
        };
      },
      async stat(path) {
        const file = vault.files.get(path);
        if (file) return { type: "file", mtime: file.mtime, ctime: file.mtime, size: file.data.byteLength };
        if (vault.dirs.has(path)) return { type: "folder", mtime: 0, ctime: 0, size: 0 };
        return null;
      },
      async exists(path) {
        return vault.files.has(path) || vault.dirs.has(path);
      },
      async readBinary(path) {
        const file = vault.files.get(path);
        if (!file) throw new Error(`Inexistente: ${path}`);
        return file.data.slice(0);
      },
      async writeBinary(path, data, options) {
        vault.requireParent(path);
        vault.files.set(path, { data: data.slice(0), mtime: options?.mtime ?? vault.tick() });
      },
      async mkdir(path) {
        vault.mkdirp(path);
      },
      async rename(from, to) {
        vault.moveTree(from, to);
      },
      async rmdir(path, recursive) {
        const busy = [...vault.files.keys(), ...vault.dirs].some((key) => key !== path && isUnder(key, path));
        if (busy && !recursive) throw new Error(`Pasta não vazia: ${path}`);
        vault.removeTree(path);
      },
      async trashLocal(path) {
        vault.trashPath(path);
      },
    };
  }
}

export class MemoryServer {
  constructor({ latency = 0 } = {}) {
    this.files = new Map();
    this.dirs = new Map();
    this.nextId = 100;
    this.nextEtag = 1;
    this.latency = latency;
    this.inflight = 0;
    this.maxInflight = 0;
    this.calls = { put: 0, get: 0, move: 0, delete: 0, mkcol: 0, propfind: 0 };
    this.createdIds = new Map();
  }

  async io(kind) {
    this.calls[kind]++;
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    if (this.latency) await sleep(1 + Math.floor(Math.random() * this.latency));
    this.inflight--;
  }

  etag() {
    return `"e${this.nextEtag++}"`;
  }

  putFile(path, text, mtime = 0) {
    let current = "";
    for (const segment of parentOf(path).split("/").filter(Boolean)) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.dirs.has(current)) this.dirs.set(current, { fileId: String(this.nextId++), etag: this.etag() });
    }
    const existing = this.files.get(path);
    this.files.set(path, {
      data: toBuffer(text),
      etag: this.etag(),
      fileId: existing?.fileId ?? String(this.nextId++),
      mtime,
    });
  }

  mkdirp(path) {
    let current = "";
    for (const segment of path.split("/").filter(Boolean)) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.dirs.has(current)) this.dirs.set(current, { fileId: String(this.nextId++), etag: this.etag() });
    }
  }

  read(path) {
    const file = this.files.get(path);
    return file ? decoder.decode(file.data) : undefined;
  }

  renameExternally(from, to) {
    this.moveTree(from, to);
  }

  moveTree(from, to) {
    for (const key of [...this.files.keys()]) {
      if (isUnder(key, from)) {
        this.files.set(to + key.slice(from.length), this.files.get(key));
        this.files.delete(key);
      }
    }
    for (const key of [...this.dirs.keys()]) {
      if (isUnder(key, from)) {
        this.dirs.set(to + key.slice(from.length), this.dirs.get(key));
        this.dirs.delete(key);
      }
    }
  }

  entry(path) {
    const file = this.files.get(path);
    if (file) {
      return { path, isDir: false, etag: file.etag, size: file.data.byteLength, mtime: file.mtime, fileId: file.fileId };
    }
    const dir = this.dirs.get(path);
    if (dir) return { path, isDir: true, etag: dir.etag, size: 0, mtime: 0, fileId: dir.fileId };
    return null;
  }

  async listAll(descends) {
    const listing = { files: new Map(), dirs: new Map(), rootExists: true, skipped: [...(this.skipped ?? [])] };
    const visit = async (dir) => {
      await this.io("propfind");
      for (const key of this.dirs.keys()) {
        if (parentOf(key) !== dir) continue;
        listing.dirs.set(key, this.entry(key));
        if (descends(key)) await visit(key);
      }
      for (const key of this.files.keys()) {
        if (parentOf(key) === dir) listing.files.set(key, this.entry(key));
      }
    };
    await visit("");
    return listing;
  }

  async ensureRoot() {}

  async ensureDir(relDir, known) {
    let current = "";
    for (const segment of relDir.split("/").filter(Boolean)) {
      current = current ? `${current}/${segment}` : segment;
      if (known.has(current)) continue;
      await this.io("mkcol");
      if (!this.dirs.has(parentOf(current)) && parentOf(current)) throw new Error(`409 ao criar ${current}`);
      if (!this.dirs.has(current)) {
        const fileId = String(this.nextId++);
        this.dirs.set(current, { fileId, etag: this.etag() });
        this.createdIds.set(current, fileId);
      }
      known.add(current);
    }
  }

  createdFolderId(path) {
    return this.createdIds.get(path);
  }

  async stat(path) {
    await this.io("propfind");
    return this.entry(path);
  }

  async get(path) {
    await this.io("get");
    const file = this.files.get(path);
    if (!file) throw new Error(`404 ${path}`);
    return { data: file.data.slice(0), etag: file.etag };
  }

  async put(path, data, mtimeMs) {
    await this.io("put");
    const parent = parentOf(path);
    if (parent && !this.dirs.has(parent)) throw new Error(`409 pasta-mãe ausente para ${path}`);
    const existing = this.files.get(path);
    const record = {
      data: data.slice(0),
      etag: this.etag(),
      fileId: existing?.fileId ?? String(this.nextId++),
      mtime: mtimeMs,
    };
    this.files.set(path, record);
    return { etag: record.etag, fileId: record.fileId };
  }

  async move(from, to, known) {
    const parent = parentOf(to);
    if (parent) await this.ensureDir(parent, known);
    await this.io("move");
    if (!this.files.has(from) && !this.dirs.has(from)) return "missing";
    if (this.files.has(to) || this.dirs.has(to)) return "exists";
    this.moveTree(from, to);
    return "moved";
  }

  async delete(path, expectedEtag) {
    await this.io("delete");
    const file = this.files.get(path);
    if (!file) return "missing";
    if (expectedEtag && file.etag.replace(/"/g, "") !== expectedEtag.replace(/"/g, "")) return "changed";
    this.files.delete(path);
    return "deleted";
  }

  async isEmptyDir(path) {
    await this.io("propfind");
    if (!this.dirs.has(path)) return false;
    return ![...this.files.keys(), ...this.dirs.keys()].some((key) => key !== path && isUnder(key, path));
  }

  async deleteEmptyDir(path) {
    if (!(await this.isEmptyDir(path))) return false;
    await this.io("delete");
    this.dirs.delete(path);
    return true;
  }
}
