# NextSync

Plugin do Obsidian que sincroniza o cofre com uma pasta do **Nextcloud** por WebDAV.
Funciona no desktop (Linux, Windows e macOS) e no celular (Android e iOS).

Versão atual: **1.1.0** · Requer Obsidian 1.13.1 ou mais recente.

## Instalação

Pelo Obsidian: *Configurações → Plugins da comunidade → Procurar*, pesquise **NextSync**, instale e ative.

Instalação manual: baixe `main.js`, `manifest.json` e `styles.css` da release mais recente e copie-os para `<cofre>/<pasta de configuração>/plugins/nextsync/` (a pasta de configuração é `.obsidian` por padrão).

## Compilação a partir do código-fonte

```bash
npm ci
npm run lint
npm test
npm run build
```

Requer Node.js 18 ou mais recente. `npm run dev` recompila automaticamente a cada alteração.

## Configuração

1. No Nextcloud, crie uma **senha de aplicativo** em *Configurações pessoais → Segurança → Dispositivos e sessões*.
2. Nas configurações do NextSync, informe:
   - **Endereço do servidor**: somente a raiz, com HTTPS (por exemplo, `https://nuvem.exemplo.com`);
   - **Usuário**: o login do Nextcloud;
   - **Senha de aplicativo**;
   - **Pasta remota**: a pasta do Nextcloud que espelhará o cofre.
3. Clique em **Testar conexão**.

### Onde a senha é guardada

A senha é escolhida no armazenamento de segredos do Obsidian (*SecretStorage*) e não é gravada no arquivo de configuração do plugin. Uma senha gravada em texto simples por uma versão anterior é transferida automaticamente para o armazenamento de segredos.

## Declarações

- **Uso de rede**: o plugin se conecta somente ao servidor Nextcloud configurado pelo usuário, pelo WebDAV (`/remote.php/dav/files/…`), para listar, enviar, baixar, mover e excluir arquivos e pastas na pasta escolhida, e pela API OCS (`/ocs/v2.php/cloud/user`), para validar as credenciais. Nenhum outro serviço remoto é contatado.
- **Conta**: exige uma conta Nextcloud em um servidor de sua escolha.
- **Pagamento**: gratuito.
- **Telemetria**: nenhuma.
- **Acesso ao cofre**: para comparar o cofre com o servidor, o plugin lista os arquivos do cofre e lê, cria, altera, renomeia e envia para a lixeira apenas os arquivos dentro do escopo sincronizado. Os arquivos ocultos e a pasta de configuração só são lidos quando as opções correspondentes estão ativadas; as pastas ignoradas nunca são lidas nem enviadas.
- **Arquivos fora do cofre**: o plugin não acessa arquivos fora do cofre.

## Uso

- Ícone de setas circulares na barra lateral ou o comando **“NextSync: Sincronizar agora”**.
- Opcional: sincronização automática a cada *N* minutos e ao abrir o Obsidian.

## Como a sincronização funciona

Para cada arquivo e pasta, o plugin guarda a data e o tamanho locais, o **ETag** e o identificador permanente (`fileid`) do Nextcloud da última sincronização, e compara os dois lados com esse histórico.

| Situação | Ação |
|---|---|
| Alterado só no cofre | Envia ao Nextcloud |
| Alterado só no Nextcloud | Baixa para o cofre |
| Alterado nos dois lados | Conflito: a versão do servidor é salva como `nota (conflito AAAA-MM-DD HHMMSS).md` e a versão local é mantida e enviada |
| Arquivo ou pasta novos de um lado | Cria do outro |
| Renomeado ou movido de um lado | Renomeia ou move do outro, sem nova transferência |
| Excluído no cofre | Exclui no Nextcloud (com confirmação, se ativada) |
| Excluído no Nextcloud | Move o arquivo local para a lixeira definida em *Arquivos e links → Arquivos excluídos* do Obsidian |
| Excluído de um lado e alterado do outro | A versão alterada é restaurada |

Na primeira sincronização, arquivos presentes nos dois lados são comparados byte a byte. Se forem diferentes, viram conflito e nada é sobrescrito.

### Renomeações e movimentações

O NextSync reconhece renomeações de três formas:

1. **No Obsidian**: renomeações e movimentações são registradas no momento em que acontecem e aplicadas no servidor com `MOVE`. Renomear uma pasta a move numa única requisição, com tudo o que há dentro.
2. **No Nextcloud ou em outro dispositivo**: o Nextcloud mantém um identificador permanente (`oc:fileid`), que não muda na renomeação. O plugin então renomeia o arquivo ou a pasta local, em vez de baixá-los de novo.
3. **Com o Obsidian fechado** (por exemplo, pelo gerenciador de arquivos): um arquivo local novo cujo conteúdo é idêntico ao de um arquivo que sumiu (mesmo tamanho e mesmo hash SHA-256) é tratado como renomeação.

Se os dois lados renomearem o mesmo arquivo com nomes diferentes, os dois nomes são mantidos, e nada se perde.

### Pastas vazias

As pastas são acompanhadas como os arquivos. Uma pasta criada de um lado é criada do outro; uma pasta excluída de um lado é excluída do outro, mas **somente se estiver vazia**. Uma pasta que recebeu arquivos novos do outro lado é mantida.

### Arquivos ocultos e configurações

As opções ficam em *Configurações → NextSync → O que sincronizar*, todas desativadas por padrão:

- **Arquivos e pastas ocultos**: arquivos e pastas cujo nome começa com ponto, em qualquer lugar do cofre.
- **Configurações do Obsidian**: a pasta de configuração, com preferências, atalhos, aparência, temas e trechos CSS. As mudanças recebidas de outro dispositivo passam a valer depois de reiniciar o Obsidian.
- **Plugins da comunidade** (exige a opção anterior): os plugins instalados, as configurações de cada um e a lista de plugins ativados.

Estes itens **nunca** são sincronizados, quaisquer que sejam as opções: as pastas `.git` e `.trash`, os arquivos `.DS_Store` e `Thumbs.db`, o layout das janelas (`workspace.json` e `workspace-mobile.json`) e a pasta do próprio NextSync, que guarda o estado de sincronização de cada dispositivo.

Quando um arquivo de configuração muda nos dois lados, vence a versão modificada por último, sem cópia de conflito. Num dispositivo que ativa a sincronização de configurações pela primeira vez, a versão que já está no servidor é adotada.

### Transferências simultâneas

O número de transferências ao mesmo tempo é definido em *Configurações → NextSync → Transferências simultâneas*, de 1 a 8 (padrão: 4). A listagem do servidor também é feita em paralelo. Use 1 em conexões instáveis ou servidores sobrecarregados.

## Confirmação de exclusões

Com **Confirmar exclusões no Nextcloud** ativada (padrão), ao excluir uma nota ou pasta sincronizada aparece uma janela com a lista dos itens afetados (as pastas aparecem com `/` no final):

- **Excluir também no Nextcloud**: os itens são excluídos imediatamente no servidor e vão para a lixeira do Nextcloud.
- **Manter no Nextcloud**: os itens permanecem no servidor e voltam para o cofre na próxima sincronização.

A janela aparece logo depois da exclusão no Obsidian, porque o Obsidian não oferece aos plugins um aviso anterior à exclusão. A confirmação também é pedida quando uma sincronização encontra itens que deixaram de existir no cofre, por exemplo, excluídos com o Obsidian fechado.

A opção pode ser desativada em *Configurações → NextSync → Segurança*. Ela só tem efeito com **Propagar exclusões** ativada.

## Segurança

- Exige **HTTPS**. HTTP só é aceito para `localhost`.
- Recusa endereços com usuário, senha, parâmetros ou caminhos `/remote.php` embutidos.
- Exige uma pasta remota; não sincroniza a raiz da conta.
- Ignora nomes de arquivo remotos inválidos ou perigosos (por exemplo, com `..`, barras invertidas ou caracteres de controle).
- Exclusões no servidor usam `If-Match` com o ETag conhecido. Se o arquivo foi alterado no Nextcloud depois da última sincronização, ele não é excluído e volta para o cofre.
- Pastas só são excluídas quando estão vazias, dos dois lados.
- Movimentações nunca sobrescrevem um item existente (`Overwrite: F`).
- Exclusões locais seguem a preferência de arquivos excluídos do Obsidian (pasta `.trash` do cofre ou lixeira do sistema); no servidor, vão para a lixeira do Nextcloud.
- A sincronização é interrompida quando a pasta remota ou o cofre aparecem vazios inesperadamente, ou quando o número de exclusões passa do limite configurado (padrão: 50).
- Trocar servidor, usuário ou pasta remota zera o histórico automaticamente.
- Operações de sincronização e de exclusão são executadas em fila, nunca ao mesmo tempo.
- A senha e o cabeçalho de autenticação nunca são registrados no console.

## Limitações conhecidas

- Uma pasta que contém itens fora do escopo da sincronização (por exemplo, arquivos ocultos com essa opção desativada) não é excluída do outro lado, porque lá ela não está vazia.
- Renomeações feitas fora do Obsidian só são reconhecidas quando o conteúdo do arquivo não mudou na mesma operação; caso contrário, são tratadas como exclusão seguida de criação.
