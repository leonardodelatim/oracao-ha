# Oração Automática

Este app vigia um chat do Telegram. Quando a oração chega, ele baixa o áudio e envia como **nota de voz** para os grupos e as pessoas que você escolher no WhatsApp. Tudo roda dentro do Home Assistant.

> ⚠️ O WhatsApp é conectado de forma **não oficial**, como se fosse o WhatsApp Web. Isso vai contra os termos do WhatsApp e pode levar ao bloqueio do número. As pausas aleatórias entre envios reduzem esse risco, mas não o eliminam.

## 1. Instalar

1. No Home Assistant, abra **Configurações ▸ Apps ▸ Instalar app**.
2. Toque em **⋮ ▸ Repositórios**, cole `https://github.com/leonardodelatim/oracao-ha` e toque em **Adicionar**.
3. Feche a janela e recarregue a página. **Oração Automática** aparece na loja.
4. Toque nele e depois em **Instalar**. A primeira instalação leva alguns minutos.

## 2. Configurar

1. Entre em **https://my.telegram.org** com o seu número e abra **API development tools**.
2. Crie um app com qualquer nome e anote o **api_id** e o **api_hash**.
3. Na aba **Configuração** do app, preencha o **api_id** e o **api_hash**. Ajuste os horários, se quiser, e toque em **Salvar**.
4. Na aba **Informações**, ligue **Mostrar na barra lateral** e toque em **Iniciar**.
5. Abra o item **Oração** na barra lateral e siga os passos da tela:
   - **Telegram:** digite seu número e depois o código que chega no app do Telegram. Em seguida, escolha o chat onde a oração chega.
   - **WhatsApp:** no celular, abra **WhatsApp ▸ ⋮ ▸ Aparelhos conectados ▸ Conectar um aparelho** e leia o QR Code da tela.
   - **Destinos:** cadastre seu número para os testes, marque os grupos e adicione as pessoas.
6. Toque em **Testar (só para mim)** e confira se o áudio chegou. Se você já mandou a oração de hoje à mão, toque em **Já enviei hoje à mão**.

Pronto. A partir de amanhã o envio é automático. Cada áudio também fica salvo em **Mídia ▸ oracao**.

## Opções

| Opção | O que faz |
|---|---|
| Enviar a partir de / até | só envia dentro dessa janela de horário |
| Apenas uma oração por dia | ignora outros áudios depois do primeiro do dia |
| Pausa mínima / máxima | intervalo sorteado entre um envio e outro; valores maiores são mais seguros |
| Mensagem depois do áudio | texto opcional, por exemplo "Bom dia! 🙏" |
| Serviço de notificação | por exemplo `notify.mobile_app_meu_celular`; avisa no celular quando enviar, se der erro ou se o WhatsApp desconectar |

## Usar em automações e no painel

O app cria o sensor **`sensor.oracao_automatica`**. Os estados possíveis são:

- `aguardando`
- `enviando`
- `enviada_hoje`
- `configurar`
- `erro`

O sensor também traz atributos com a data, a hora e o número de envios e falhas.

Para ter **botões** no Home Assistant, adicione isto ao `configuration.yaml` e reinicie:

```yaml
rest_command:
  oracao_reenviar:
    url: http://local-oracao-automatica:8099/api/reenviar
    method: POST
  oracao_teste:
    url: http://local-oracao-automatica:8099/api/teste
    method: POST
```

Assim você pode chamar `rest_command.oracao_reenviar` num botão do painel ou numa automação. Exemplo: avisar às 10h se a oração ainda não saiu.

```yaml
automation:
  - alias: Avisar se a oração não foi enviada
    triggers:
      - trigger: time
        at: "10:00:00"
    conditions:
      - condition: not
        conditions:
          - condition: state
            entity_id: sensor.oracao_automatica
            state: enviada_hoje
    actions:
      - action: notify.mobile_app_meu_celular
        data:
          message: A oração de hoje ainda não foi enviada.
```

## Problemas comuns

- **O QR Code apareceu de novo**: o aparelho foi desconectado no celular. Leia o QR Code outra vez.
- **Um grupo não recebe**: confira se você ainda está no grupo. Se só administradores podem enviar mensagens nele, você precisa ser admin.
- **Uma pessoa não recebe**: confira o número. Ele precisa ter o DDD e o 9 na frente.
- **Ver o que aconteceu**: abra a aba **Registro** do add-on.
