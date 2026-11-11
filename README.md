# RefBoard

Quadro de imagens de referência para iPad. Abre e grava arquivos `.pur` do PureRef 2.1, os mesmos do RefBoard do Mac.

**Abrir:** https://felipecoutojj-max.github.io/refboard/

## Instalar no iPad
1. Abra o endereço acima no **Safari**.
2. Toque em **Compartilhar** e depois em **Adicionar à Tela de Início**.
3. Abra o RefBoard pelo ícone: ele roda em tela cheia e funciona sem internet.

As imagens ficam só no iPad. Nada é enviado para servidor nenhum.

## Como usar

| Gesto | O que faz |
| --- | --- |
| Tocar numa imagem | Seleciona |
| Tocar e segurar numa imagem | Soma à seleção |
| Arrastar uma imagem | Move a seleção |
| Arrastar no fundo | Retângulo de seleção |
| Dois dedos | Movem o quadro e dão zoom |
| Quadradinhos nos cantos | Redimensionam |
| Bolinha acima da imagem | Gira (encaixa de 90 em 90 graus) |

- **Importar** traz fotos, arquivos de imagem e PDF (cada página vira uma imagem).
- **Colar** traz a imagem copiada em outro app, por exemplo no Freeform.
- Também dá para arrastar imagens de outro app em Split View.
- **Caneta** desenha por cima do quadro, com o dedo ou com o Apple Pencil. Quando o app percebe o Pencil, o dedo passa a mover o quadro; a opção "Dedo desenha" volta ao modo anterior.
- **Transparência** age na seleção, ou em todas as imagens se nada estiver selecionado.
- A barra de baixo aparece com a seleção: girar, espelhar, tamanho, duplicar, ordem, recortar e excluir.

## Salvar
O quadro em andamento fica guardado no iPad e volta quando o app é aberto de novo.

**Salvar** gera o arquivo `.pur` e abre a folha de compartilhamento: escolha **Salvar em Arquivos**. Um app web não pode gravar por cima de um arquivo do iPad, então cada salvamento entrega um arquivo novo.

## Limites conhecidos
- Notas de texto e grupos de um `.pur` não aparecem na tela, mas são regravados como vieram.
- Quadros muito grandes (centenas de megabytes) podem não caber na memória do Safari.
- Links de imagem só funcionam quando o site de origem permite o download. Copiar a imagem ou salvá-la em Fotos sempre funciona.

## Para quem mexe no código
Sem etapa de build: `index.html`, `style.css`, `app.js`, `pur.js` (formato `.pur`) e `pur-worker.js`.

    node testes/roundtrip.js <quadro.pur> <pasta-de-saida>

Bibliotecas em `vendor/`: sql.js 1.15.2 (MIT) e pdf.js 6.5.438 (Apache 2.0), com as licenças ao lado.

RefBoard é um projeto independente, sem vínculo com o PureRef.
