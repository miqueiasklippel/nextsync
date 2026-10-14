export class TAbstractFile {}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}

export function normalizePath(path) {
  return path;
}

export function requestUrl() {
  throw new Error("Rede indisponível nos testes.");
}
