import assert from "node:assert/strict";
import { SyncScope } from "../src/scope.ts";
import { SyncEngine, emptyState, migrateState } from "../src/sync.ts";
import { runPool } from "../src/concurrency.ts";
import { MemoryServer, MemoryVault } from "./harness.mjs";

const baseSettings = {
  propagateDeletions: true,
  confirmRemoteDeletion: true,
  maxDeletions: 50,
  ignorePaths: ["Privado"],
  syncHidden: false,
  syncConfig: false,
  syncPlugins: false,
  concurrency: 4,
};

function setup(options = {}) {
  return {
    vault: options.vault ?? new MemoryVault(options.configDir),
    server: options.server ?? new MemoryServer(options.serverOptions),
    state: emptyState(),
    journal: {},
    settings: { ...baseSettings, ...(options.settings ?? {}) },
  };
}

async function sync(env, { approve = true } = {}) {
  const asked = [];
  const renames = [];
  const scope = new SyncScope({
    configDir: env.vault.configDir,
    pluginId: "nextsync",
    ignorePaths: env.settings.ignorePaths,
    syncHidden: env.settings.syncHidden,
    syncConfig: env.settings.syncConfig,
    syncPlugins: env.settings.syncConfig && env.settings.syncPlugins,
  });
  const app = { vault: env.vault, fileManager: env.vault.fileManager };
  const engine = new SyncEngine(app, env.server, env.settings, scope, env.state, env.journal, {
    onProgress() {},
    persist: async () => {},
    beforeLocalTrash() {},
    beforeLocalRename(from, to) {
      renames.push([from, to]);
    },
    confirmRemoteDeletions: async (paths) => {
      asked.push(...paths);
      return approve;
    },
  });
  const report = await engine.run();
  return { report, asked, renames };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("primeira sincronização respeita pastas ignoradas, ocultos e configuração", async () => {
  const env = setup();
  env.vault.put("Notas/a.md", "A1");
  env.vault.put("b.md", "B1");
  env.vault.put("Privado/x.md", "segredo");
  env.vault.put(".obsidian/app.json", "{}");
  env.vault.put("Notas/.oculto.md", "h");
  env.server.putFile("c.md", "C1");
  const { report } = await sync(env);
  assert.equal(report.uploaded, 2);
  assert.equal(report.downloaded, 1);
  assert.equal(env.server.read("Notas/a.md"), "A1");
  assert.equal(env.vault.read("c.md"), "C1");
  assert.equal(env.server.read("Privado/x.md"), undefined);
  assert.equal(env.server.read(".obsidian/app.json"), undefined);
  assert.equal(env.server.read("Notas/.oculto.md"), undefined);
});

test("alterações nos dois sentidos", async () => {
  const env = setup();
  env.vault.put("b.md", "B1");
  env.server.putFile("c.md", "C1");
  await sync(env);
  env.vault.put("b.md", "B2");
  env.server.putFile("c.md", "C2");
  const { report } = await sync(env);
  assert.equal(env.server.read("b.md"), "B2");
  assert.equal(env.vault.read("c.md"), "C2");
  assert.equal(report.conflicts.length, 0);
});

test("conflito preserva as duas versões", async () => {
  const env = setup();
  env.vault.put("b.md", "B1");
  await sync(env);
  env.vault.put("b.md", "local");
  env.server.putFile("b.md", "remoto");
  const { report } = await sync(env);
  assert.equal(report.conflicts.length, 1);
  assert.equal(env.vault.read("b.md"), "local");
  const copy = [...env.vault.files.keys()].find((key) => key.includes("(conflito"));
  assert.ok(copy);
  assert.equal(env.vault.read(copy), "remoto");
  assert.equal(env.server.read(copy), "remoto");
});

test("exclusão recusada restaura e confirmada exclui", async () => {
  const env = setup();
  env.vault.put("fica.md", "permanece");
  env.vault.put("a.md", "A");
  await sync(env);
  env.vault.remove("a.md");
  let result = await sync(env, { approve: false });
  assert.deepEqual(result.asked, ["a.md"]);
  assert.equal(env.vault.read("a.md"), "A");
  env.vault.remove("a.md");
  result = await sync(env);
  assert.equal(result.report.deletedRemote, 1);
  assert.equal(env.server.read("a.md"), undefined);
});

test("excluído no cofre e editado no servidor é restaurado", async () => {
  const env = setup();
  env.vault.put("fica.md", "permanece");
  env.vault.put("c.md", "C");
  await sync(env);
  env.vault.remove("c.md");
  env.server.putFile("c.md", "editado");
  const { asked } = await sync(env);
  assert.equal(asked.length, 0);
  assert.equal(env.vault.read("c.md"), "editado");
});

test("excluído no servidor vai para a lixeira do cofre", async () => {
  const env = setup();
  env.vault.put("fica.md", "permanece");
  env.vault.put("b.md", "B");
  await sync(env);
  env.server.files.delete("b.md");
  const { report } = await sync(env);
  assert.equal(report.deletedLocal, 1);
  assert.equal(env.vault.read("b.md"), undefined);
  assert.ok([...env.vault.files.keys()].some((key) => key.startsWith(".trash/")));
});

test("limite de exclusões bloqueia sem alterar nada", async () => {
  const env = setup({ settings: { maxDeletions: 3 } });
  env.vault.put("fica.md", "permanece");
  for (let i = 0; i < 5; i++) env.vault.put(`m${i}.md`, "x");
  await sync(env);
  for (let i = 0; i < 5; i++) env.vault.remove(`m${i}.md`);
  await assert.rejects(() => sync(env), /limite/);
  assert.equal(env.server.read("m0.md"), "x");
});

test("trava contra pasta remota vazia", async () => {
  const env = setup();
  env.vault.put("a.md", "A");
  await sync(env);
  env.server.files.clear();
  await assert.rejects(() => sync(env), /pasta remota está vazia/);
  assert.equal(env.vault.read("a.md"), "A");
});

test("caminho remoto malicioso é relatado e ignorado", async () => {
  const env = setup();
  env.server.skipped = ["../fora.md"];
  const { report } = await sync(env);
  assert.ok(report.errors[0].includes("nome inválido"));
});

test("arquivos ocultos sincronizam quando ativados, exceto .git e .trash", async () => {
  const env = setup({ settings: { syncHidden: true } });
  env.vault.put("Notas/.oculto.md", "h");
  env.vault.put(".meta/x.json", "m");
  env.vault.put(".git/config", "g");
  env.vault.put(".trash/velho.md", "t");
  env.server.putFile(".remoto/y.txt", "r");
  await sync(env);
  assert.equal(env.server.read("Notas/.oculto.md"), "h");
  assert.equal(env.server.read(".meta/x.json"), "m");
  assert.equal(env.server.read(".git/config"), undefined);
  assert.equal(env.server.read(".trash/velho.md"), undefined);
  assert.equal(env.vault.read(".remoto/y.txt"), "r");
});

test("configuração sincroniza com exclusões fixas e plugins opcionais", async () => {
  const env = setup({ settings: { syncConfig: true } });
  env.vault.put(".obsidian/app.json", "{a}");
  env.vault.put(".obsidian/snippets/x.css", "css");
  env.vault.put(".obsidian/workspace.json", "{w}");
  env.vault.put(".obsidian/plugins/nextsync/data.json", "{segredo}");
  env.vault.put(".obsidian/plugins/outro/main.js", "js");
  env.vault.put(".obsidian/community-plugins.json", "[]");
  await sync(env);
  assert.equal(env.server.read(".obsidian/app.json"), "{a}");
  assert.equal(env.server.read(".obsidian/snippets/x.css"), "css");
  assert.equal(env.server.read(".obsidian/workspace.json"), undefined);
  assert.equal(env.server.read(".obsidian/plugins/nextsync/data.json"), undefined);
  assert.equal(env.server.read(".obsidian/plugins/outro/main.js"), undefined);
  assert.equal(env.server.read(".obsidian/community-plugins.json"), undefined);

  env.settings.syncPlugins = true;
  await sync(env);
  assert.equal(env.server.read(".obsidian/plugins/outro/main.js"), "js");
  assert.equal(env.server.read(".obsidian/community-plugins.json"), "[]");
  assert.equal(env.server.read(".obsidian/plugins/nextsync/data.json"), undefined);
});

test("pasta de configuração personalizada nunca vaza quando desativada", async () => {
  const env = setup({ configDir: ".config" });
  env.vault.put(".config/app.json", "{}");
  env.vault.put("nota.md", "n");
  await sync(env);
  assert.equal(env.server.read(".config/app.json"), undefined);
  assert.equal(env.server.read("nota.md"), "n");
});

test("conflito em configuração: vence o mais recente, sem cópia", async () => {
  const env = setup({ settings: { syncConfig: true } });
  env.vault.put(".obsidian/app.json", "{v1}", 1_000_000);
  await sync(env);
  env.vault.put(".obsidian/app.json", "{local}", 5_000_000);
  env.server.putFile(".obsidian/app.json", "{remoto}", 9_000_000);
  const { report } = await sync(env);
  assert.equal(report.conflicts.length, 0);
  assert.equal(env.vault.read(".obsidian/app.json"), "{remoto}");
  assert.ok(![...env.vault.files.keys()].some((key) => key.includes("(conflito")));
});

test("novo dispositivo adota a configuração do servidor", async () => {
  const env = setup({ settings: { syncConfig: true } });
  env.server.putFile(".obsidian/app.json", "{servidor}", 1_000);
  env.vault.put(".obsidian/app.json", "{padrão}", 9_999_999);
  await sync(env);
  assert.equal(env.vault.read(".obsidian/app.json"), "{servidor}");
  assert.equal(env.server.read(".obsidian/app.json"), "{servidor}");
});

test("pastas vazias são criadas nos dois sentidos", async () => {
  const env = setup();
  env.vault.mkdirp("Projetos/Vazia");
  env.server.mkdirp("Arquivo/2026");
  const { report } = await sync(env);
  assert.ok(env.server.dirs.has("Projetos/Vazia"));
  assert.ok(env.vault.dirs.has("Arquivo/2026"));
  assert.ok(report.foldersCreated >= 3);
  assert.ok("Projetos/Vazia" in env.state.folders);
});

test("pasta vazia excluída no cofre é excluída no servidor com confirmação", async () => {
  const env = setup();
  env.vault.mkdirp("Velha/Sub");
  await sync(env);
  env.vault.removeTree("Velha");
  const { report, asked } = await sync(env);
  assert.deepEqual(asked, ["Velha/", "Velha/Sub/"]);
  assert.equal(report.foldersDeleted, 2);
  assert.ok(!env.server.dirs.has("Velha"));
});

test("pasta remota com arquivo novo não é apagada", async () => {
  const env = setup();
  env.vault.mkdirp("Caixa");
  await sync(env);
  env.vault.removeTree("Caixa");
  env.server.putFile("Caixa/novo.md", "novo");
  await sync(env);
  assert.equal(env.server.read("Caixa/novo.md"), "novo");
  assert.equal(env.vault.read("Caixa/novo.md"), "novo");
});

test("pasta vazia excluída no servidor é removida do cofre", async () => {
  const env = setup();
  env.server.mkdirp("Temporária");
  await sync(env);
  env.server.dirs.delete("Temporária");
  const { report } = await sync(env);
  assert.ok(!env.vault.dirs.has("Temporária"));
  assert.equal(report.foldersDeleted, 1);
});

test("renomeação registrada vira MOVE, sem reenviar nem excluir", async () => {
  const env = setup();
  env.vault.put("Notas/velho.md", "conteúdo");
  await sync(env);
  const putsBefore = env.server.calls.put;
  env.vault.moveTree("Notas/velho.md", "Notas/novo.md");
  env.journal["Notas/novo.md"] = "Notas/velho.md";
  const { report, asked } = await sync(env);
  assert.equal(report.moved, 1);
  assert.equal(env.server.calls.put, putsBefore);
  assert.equal(asked.length, 0);
  assert.equal(env.server.read("Notas/novo.md"), "conteúdo");
  assert.equal(env.server.read("Notas/velho.md"), undefined);
  assert.ok("Notas/novo.md" in env.state.files);
  assert.deepEqual(env.journal, {});
});

test("renomeação local com edição remota simultânea traz a edição", async () => {
  const env = setup();
  env.vault.put("a.md", "v1");
  await sync(env);
  env.server.putFile("a.md", "v2-remoto");
  env.vault.moveTree("a.md", "b.md");
  env.journal["b.md"] = "a.md";
  await sync(env);
  assert.equal(env.vault.read("b.md"), "v2-remoto");
  assert.equal(env.server.read("b.md"), "v2-remoto");
  assert.equal(env.server.read("a.md"), undefined);
});

test("renomeação de pasta é um único MOVE, incluindo subitens renomeados depois", async () => {
  const env = setup();
  env.vault.put("A/x.md", "x");
  env.vault.put("A/y.md", "y");
  env.vault.put("A/Sub/z.md", "z");
  await sync(env);
  const putsBefore = env.server.calls.put;
  env.vault.moveTree("A", "B");
  env.vault.moveTree("B/x.md", "B/x2.md");
  env.journal["B"] = "A";
  env.journal["B/y.md"] = "A/y.md";
  env.journal["B/x2.md"] = "A/x.md";
  const { report, asked } = await sync(env);
  assert.equal(env.server.calls.put, putsBefore);
  assert.equal(asked.length, 0);
  assert.equal(report.moved, 2);
  assert.equal(env.server.read("B/x2.md"), "x");
  assert.equal(env.server.read("B/y.md"), "y");
  assert.equal(env.server.read("B/Sub/z.md"), "z");
  assert.ok(!env.server.dirs.has("A"));
});

test("renomeação feita no servidor é aplicada no cofre pelo fileid", async () => {
  const env = setup();
  env.vault.put("Notas/a.md", "A");
  await sync(env);
  const getsBefore = env.server.calls.get;
  env.server.renameExternally("Notas/a.md", "Notas/renomeado.md");
  const { report, renames } = await sync(env);
  assert.equal(report.moved, 1);
  assert.deepEqual(renames, [["Notas/a.md", "Notas/renomeado.md"]]);
  assert.equal(env.vault.read("Notas/renomeado.md"), "A");
  assert.equal(env.vault.read("Notas/a.md"), undefined);
  assert.equal(env.server.calls.get, getsBefore);
});

test("pasta renomeada no servidor é renomeada no cofre", async () => {
  const env = setup();
  env.vault.put("Clientes/x.md", "x");
  env.vault.put("Clientes/2026/y.md", "y");
  await sync(env);
  env.server.renameExternally("Clientes", "Contatos");
  const { report } = await sync(env);
  assert.equal(report.moved, 1);
  assert.equal(env.vault.read("Contatos/x.md"), "x");
  assert.equal(env.vault.read("Contatos/2026/y.md"), "y");
  assert.ok(!env.vault.dirs.has("Clientes"));
  assert.equal(report.uploaded + report.downloaded, 0);
});

test("renomeação feita com o Obsidian fechado é reconhecida pelo conteúdo", async () => {
  const env = setup();
  env.vault.put("relatorio.md", "conteúdo único 123");
  env.vault.put("outro.md", "outro");
  await sync(env);
  const putsBefore = env.server.calls.put;
  env.vault.mkdirp("Arquivo");
  env.vault.moveTree("relatorio.md", "Arquivo/relatorio-2026.md");
  const { report, asked } = await sync(env);
  assert.equal(report.moved, 1);
  assert.equal(asked.length, 0);
  assert.equal(env.server.calls.put, putsBefore);
  assert.equal(env.server.read("Arquivo/relatorio-2026.md"), "conteúdo único 123");
  assert.equal(env.server.read("relatorio.md"), undefined);
});

test("renomeações divergentes nos dois lados não perdem nada", async () => {
  const env = setup();
  env.vault.put("doc.md", "D");
  await sync(env);
  env.vault.moveTree("doc.md", "local.md");
  env.journal["local.md"] = "doc.md";
  env.server.renameExternally("doc.md", "remoto.md");
  await sync(env);
  assert.equal(env.vault.read("local.md"), "D");
  assert.equal(env.vault.read("remoto.md"), "D");
  assert.equal(env.server.read("local.md"), "D");
  assert.equal(env.server.read("remoto.md"), "D");
});

test("transferências paralelas respeitam o limite e criam pastas sem corrida", async () => {
  const env = setup({ serverOptions: { latency: 6 }, settings: { concurrency: 4 } });
  for (let i = 0; i < 24; i++) env.vault.put(`Lote/${i % 3}/Sub/arquivo-${i}.md`, `conteúdo ${i}`);
  const { report } = await sync(env);
  assert.equal(report.uploaded, 24);
  assert.equal(report.errors.length, 0);
  assert.ok(env.server.maxInflight > 1, `máximo simultâneo: ${env.server.maxInflight}`);
  assert.ok(env.server.maxInflight <= 4, `máximo simultâneo: ${env.server.maxInflight}`);
  assert.equal(env.server.read("Lote/2/Sub/arquivo-23.md"), "conteúdo 23");
});

test("concorrência 1 é estritamente sequencial", async () => {
  const env = setup({ serverOptions: { latency: 3 }, settings: { concurrency: 1 } });
  for (let i = 0; i < 6; i++) env.vault.put(`f${i}.md`, `${i}`);
  await sync(env);
  assert.equal(env.server.maxInflight, 1);
});

function snapshotCalls(server) {
  return { ...server.calls };
}

function assertQuiet(server, before, label) {
  for (const kind of ["put", "get", "move", "delete", "mkcol"]) {
    assert.equal(server.calls[kind], before[kind], `${label}: operação “${kind}” inesperada numa sincronização sem mudanças`);
  }
}

test("uma segunda sincronização sem mudanças não faz nenhuma operação", async () => {
  const env = setup({ settings: { syncHidden: true, syncConfig: true, syncPlugins: true } });
  env.vault.put("Notas/a.md", "A");
  env.vault.put("Notas/.oculto.md", "h");
  env.vault.put(".obsidian/app.json", "{}");
  env.vault.put(".obsidian/plugins/outro/main.js", "js");
  env.vault.mkdirp("Vazia/Funda");
  env.server.putFile("Remoto/b.md", "B");
  env.server.mkdirp("RemotoVazio");
  await sync(env);
  let before = snapshotCalls(env.server);
  await sync(env);
  assertQuiet(env.server, before, "após primeira sincronização");

  env.vault.put("Notas/a.md", "A2");
  env.server.putFile("Remoto/b.md", "B2");
  env.vault.moveTree("Notas", "Notas2");
  env.journal["Notas2"] = "Notas";
  env.server.renameExternally("Remoto", "Remoto2");
  env.vault.put("x.md", "local");
  env.server.putFile("x.md", "remoto");
  await sync(env);
  before = snapshotCalls(env.server);
  await sync(env);
  assertQuiet(env.server, before, "após renomeações, edições e conflito");
});

test("renomear para pasta ignorada não perde o arquivo", async () => {
  const env = setup();
  env.vault.put("fica.md", "permanece");
  env.vault.put("a.md", "A");
  await sync(env);
  env.vault.mkdirp("Privado");
  env.vault.moveTree("a.md", "Privado/a.md");
  env.journal["Privado/a.md"] = "a.md";
  const { asked } = await sync(env, { approve: false });
  assert.deepEqual(asked, ["a.md"]);
  assert.equal(env.vault.read("Privado/a.md"), "A");
  assert.equal(env.server.read("a.md"), "A");
});

test("runPool nunca ultrapassa o limite", async () => {
  let active = 0;
  let peak = 0;
  await runPool([...Array(20).keys()], 3, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
  });
  assert.equal(peak, 3);
});

test("migração do histórico antigo preserva os arquivos", () => {
  const old = { "a.md": { localMtime: 1, localSize: 2, etag: "x" } };
  const migrated = migrateState(old, undefined);
  assert.deepEqual(migrated.files, old);
  assert.deepEqual(migrated.folders, {});
  const current = migrateState({ files: old, folders: { A: {} } }, 2);
  assert.deepEqual(current.folders, { A: {} });
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FALHA ${name}`);
    console.log(error);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} testes passaram`);
if (failed > 0) process.exit(1);
