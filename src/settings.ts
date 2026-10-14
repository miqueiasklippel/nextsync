import { App, Notice, PluginSettingTab, SecretComponent, Setting, SettingDefinitionItem } from "obsidian";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, MIN_CONCURRENCY, clampConcurrency } from "./concurrency";
import type NextSyncPlugin from "./main";
import { validateRemoteFolder, validateServerUrl } from "./webdav";

export interface NextSyncSettings {
  serverUrl: string;
  loginName: string;
  passwordSecretId: string;
  userId: string;
  remoteFolder: string;
  autoSyncMinutes: number;
  syncOnStartup: boolean;
  propagateDeletions: boolean;
  confirmRemoteDeletion: boolean;
  maxDeletions: number;
  ignorePaths: string[];
  syncHidden: boolean;
  syncConfig: boolean;
  syncPlugins: boolean;
  concurrency: number;
}

export const DEFAULT_SETTINGS: NextSyncSettings = {
  serverUrl: "",
  loginName: "",
  passwordSecretId: "",
  userId: "",
  remoteFolder: "Obsidian",
  autoSyncMinutes: 0,
  syncOnStartup: false,
  propagateDeletions: true,
  confirmRemoteDeletion: true,
  maxDeletions: 50,
  ignorePaths: [],
  syncHidden: false,
  syncConfig: false,
  syncPlugins: false,
  concurrency: DEFAULT_CONCURRENCY,
};

const CREDENTIAL_KEYS = new Set(["serverUrl", "loginName", "passwordSecretId"]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toWholeNumber(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export class NextSyncSettingTab extends PluginSettingTab {
  private connectionStatus = "";

  constructor(app: App, private readonly plugin: NextSyncPlugin) {
    super(app, plugin);
  }

  getControlValue(key: string): unknown {
    const settings = this.plugin.settings;
    switch (key) {
      case "ignorePaths":
        return settings.ignorePaths.join("\n");
      case "serverUrl":
      case "loginName":
      case "passwordSecretId":
      case "remoteFolder":
      case "autoSyncMinutes":
      case "maxDeletions":
      case "syncOnStartup":
      case "propagateDeletions":
      case "confirmRemoteDeletion":
      case "syncHidden":
      case "syncConfig":
      case "syncPlugins":
      case "concurrency":
        return settings[key];
      default:
        return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    switch (key) {
      case "serverUrl":
      case "loginName":
      case "passwordSecretId":
        settings[key] = typeof value === "string" ? value.trim() : "";
        break;
      case "remoteFolder":
        settings.remoteFolder = typeof value === "string" ? value.trim().replace(/^\/+|\/+$/g, "") : "";
        break;
      case "ignorePaths":
        settings.ignorePaths = (typeof value === "string" ? value : "")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        break;
      case "autoSyncMinutes":
      case "maxDeletions":
        settings[key] = toWholeNumber(value);
        break;
      case "concurrency":
        settings.concurrency = clampConcurrency(Number(value));
        break;
      case "syncOnStartup":
      case "propagateDeletions":
      case "confirmRemoteDeletion":
      case "syncHidden":
      case "syncConfig":
      case "syncPlugins":
        settings[key] = value === true;
        break;
      default:
        return;
    }

    if (CREDENTIAL_KEYS.has(key)) {
      settings.userId = "";
      this.connectionStatus = "";
    }
    await this.plugin.saveSettings();
    if (key === "autoSyncMinutes") this.plugin.restartAutoSync();
    if (key === "propagateDeletions" || key === "syncConfig") this.refreshDomState();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const settings = this.plugin.settings;
    const configDir = this.app.vault.configDir;

    return [
      {
        type: "group",
        heading: "Conexão com o Nextcloud",
        items: [
          {
            name: "Endereço do servidor",
            desc: "Somente a raiz do Nextcloud, com HTTPS. Exemplo: https://nuvem.exemplo.com",
            aliases: ["servidor", "url", "nextcloud", "server"],
            control: {
              type: "text",
              key: "serverUrl",
              placeholder: "https://nuvem.exemplo.com",
              validate: (value) => {
                if (!value.trim()) return;
                try {
                  validateServerUrl(value);
                } catch (error) {
                  return errorMessage(error);
                }
              },
            },
          },
          {
            name: "Usuário",
            desc: "Nome de login do Nextcloud (pode ser o e-mail).",
            aliases: ["login", "username"],
            control: { type: "text", key: "loginName" },
          },
          {
            name: "Senha de aplicativo",
            desc:
              "Guardada no armazenamento de segredos do Obsidian, fora do arquivo de configuração do plugin. " +
              "Crie a senha no Nextcloud em Configurações pessoais → Segurança → Dispositivos e sessões.",
            aliases: ["senha", "password", "token", "segredo"],
            render: (setting) => {
              setting.addComponent((el) =>
                new SecretComponent(this.app, el)
                  .setValue(settings.passwordSecretId)
                  .onChange((id) => this.setControlValue("passwordSecretId", id ?? "")),
              );
            },
          },
          {
            name: "Pasta remota",
            desc: "Pasta do Nextcloud que espelhará este cofre. É criada automaticamente se não existir.",
            aliases: ["pasta", "folder", "diretório"],
            control: {
              type: "text",
              key: "remoteFolder",
              placeholder: "Obsidian",
              validate: (value) => {
                try {
                  validateRemoteFolder(value);
                } catch (error) {
                  return errorMessage(error);
                }
              },
            },
          },
          {
            name: "Testar conexão",
            desc: "Verifica o endereço, o usuário e a senha de aplicativo.",
            aliases: ["conexão", "test"],
            render: (setting) => this.renderConnectionTest(setting),
          },
        ],
      },
      {
        type: "group",
        heading: "Sincronização",
        items: [
          {
            name: "Sincronização automática",
            desc: "Intervalo em minutos entre sincronizações automáticas. Use 0 para desativar.",
            aliases: ["intervalo", "automática", "interval"],
            control: { type: "number", key: "autoSyncMinutes", min: 0, defaultValue: 0 },
          },
          {
            name: "Sincronizar ao abrir o Obsidian",
            aliases: ["inicialização", "startup"],
            control: { type: "toggle", key: "syncOnStartup" },
          },
          {
            name: "Transferências simultâneas",
            desc: `Quantos arquivos são enviados ou baixados ao mesmo tempo, de ${MIN_CONCURRENCY} a ${MAX_CONCURRENCY}. Valores maiores aceleram cofres grandes; use 1 em conexões instáveis.`,
            aliases: ["paralelo", "simultâneas", "velocidade", "concurrency"],
            control: {
              type: "number",
              key: "concurrency",
              min: MIN_CONCURRENCY,
              max: MAX_CONCURRENCY,
              defaultValue: DEFAULT_CONCURRENCY,
              validate: (value) => {
                if (!Number.isInteger(value) || value < MIN_CONCURRENCY || value > MAX_CONCURRENCY) {
                  return `Use um número inteiro de ${MIN_CONCURRENCY} a ${MAX_CONCURRENCY}.`;
                }
              },
            },
          },
          {
            name: "Pastas ignoradas",
            desc: "Uma por linha, relativas ao cofre. Tudo o que estiver dentro delas fica fora da sincronização.",
            aliases: ["ignorar", "exclusões", "ignore"],
            control: { type: "textarea", key: "ignorePaths", rows: 4, placeholder: "Rascunhos\nAnexos/Grandes" },
          },
        ],
      },
      {
        type: "group",
        heading: "O que sincronizar",
        items: [
          {
            name: "Arquivos e pastas ocultos",
            desc:
              "Inclui arquivos e pastas cujo nome começa com ponto, em qualquer lugar do cofre. " +
              "As pastas .git e .trash nunca são sincronizadas.",
            aliases: ["ocultos", "hidden", "ponto"],
            control: { type: "toggle", key: "syncHidden" },
          },
          {
            name: "Configurações do Obsidian",
            desc:
              `Sincroniza a pasta de configuração (${configDir}): preferências, atalhos, temas e trechos CSS. ` +
              "O layout das janelas e os dados do NextSync nunca são sincronizados. " +
              "As mudanças recebidas passam a valer depois de reiniciar o Obsidian.",
            aliases: ["configuração", "config", "temas", "atalhos", "settings"],
            control: { type: "toggle", key: "syncConfig" },
          },
          {
            name: "Plugins da comunidade",
            desc:
              "Instala e atualiza nos outros dispositivos os mesmos plugins deste cofre, com as configurações de cada um. " +
              "Exige a opção anterior. O próprio NextSync fica de fora.",
            aliases: ["plugins", "extensões"],
            control: { type: "toggle", key: "syncPlugins", disabled: () => !settings.syncConfig },
          },
        ],
      },
      {
        type: "group",
        heading: "Segurança",
        items: [
          {
            name: "Propagar exclusões",
            desc:
              "Ativado: excluir um arquivo de um lado o exclui do outro. " +
              "Desativado: o arquivo excluído é restaurado a partir do outro lado.",
            aliases: ["exclusão", "delete"],
            control: { type: "toggle", key: "propagateDeletions" },
          },
          {
            name: "Confirmar exclusões no Nextcloud",
            desc:
              "Ao excluir uma nota ou pasta sincronizada, pergunta se ela também deve ser excluída no Nextcloud. " +
              "A mesma confirmação é pedida quando uma sincronização for excluir arquivos no servidor.",
            aliases: ["confirmação", "confirm"],
            control: {
              type: "toggle",
              key: "confirmRemoteDeletion",
              disabled: () => !settings.propagateDeletions,
            },
          },
          {
            name: "Limite de exclusões por sincronização",
            desc: "Se uma sincronização for excluir mais arquivos do que isso, ela é cancelada. Use 0 para não limitar.",
            aliases: ["limite", "limit"],
            control: { type: "number", key: "maxDeletions", min: 0, defaultValue: 50 },
          },
        ],
      },
      {
        type: "group",
        heading: "Manutenção",
        items: [
          {
            name: "Redefinir estado de sincronização",
            desc:
              "Esquece o histórico das sincronizações anteriores. Na próxima vez, os arquivos serão comparados como " +
              "numa primeira sincronização: nada é excluído e as diferenças viram cópias de conflito.",
            aliases: ["redefinir", "reset"],
            render: (setting) => {
              setting.addButton((button) =>
                button
                  .setButtonText("Redefinir")
                  .setDestructive()
                  .onClick(async () => {
                    await this.plugin.resetState();
                    new Notice("NextSync: estado de sincronização redefinido.");
                  }),
              );
            },
          },
        ],
      },
    ];
  }

  private renderConnectionTest(setting: Setting): void {
    const settings = this.plugin.settings;
    if (this.connectionStatus) setting.setDesc(this.connectionStatus);
    else if (settings.userId) setting.setDesc(`Conectado como “${settings.userId}”.`);

    setting.addButton((button) =>
      button
        .setButtonText("Testar conexão")
        .setCta()
        .onClick(async () => {
          button.setDisabled(true).setButtonText("Testando…");
          try {
            const user = await this.plugin.testConnection();
            this.connectionStatus = `Conectado como “${user.displayName}” (ID: ${user.id}).`;
            new Notice(`NextSync: conexão bem-sucedida como ${user.displayName}.`);
          } catch (error) {
            this.connectionStatus = `Falha: ${errorMessage(error)}`;
            new Notice(`NextSync: ${errorMessage(error)}`, 8000);
          } finally {
            setting.setDesc(this.connectionStatus);
            button.setDisabled(false).setButtonText("Testar conexão");
          }
        }),
    );
  }
}
