---
title: Redigera skannad PDF och behåll originalutseendet
description: En skannad PDF är en bild av en sida, så vanliga redigerare kan inte ändra texten. Så redigerar du den ändå, med bokstäver ur själva skanningen.
date: 2026-10-28
tool: /sv/redigera-skannad-pdf
toolName: Redigera en skannad PDF
translates: how-to-edit-a-scanned-pdf
---

Du öppnar ett skannat avtal eller en skannad faktura, klickar på ett ord för att rätta det, och ingenting händer. Det är inte redigeraren som krånglar: en skannad PDF innehåller ingen text alls. Varje sida är ett fotografi av ett papper, och för en dator är bokstäverna på den bara mörka pixlar.

För att ändra ett ord i en skanning måste två saker hända. Först måste sidan **läsas**, så att redigeraren vet vilka pixlar som är vilka bokstäver. Sedan måste det nya ordet **ritas** så att det ser ut som om det alltid stått där.

## Steg 1: låt sidan läsas

Att läsa en sidbild kallas OCR (optisk teckenigenkänning). I de flesta verktyg är det ett separat steg som du måste hitta och köra själv. I redigeraren här sker det när du behöver det:

1. Öppna PDF-filen och välj **Redigera text**.
2. Klicka på raden du vill ändra.
3. Första klicket på en skannad sida läser den sidan. Det tar några sekunder och sker på din enhet. Inget laddas upp.
4. När det är klart öppnas raden du klickade på för redigering.

Därefter öppnas varje stycke på sidan direkt.

## Steg 2: ändra orden

Skriv som i vilket dokument som helst. Raderna bryts medan du skriver, och stycket behåller sin bredd och justering.

Det intressanta är vad som händer när du är klar. De flesta redigerare täcker de gamla orden med en vit ruta och skriver de nya ovanpå i ett standardtypsnitt, och det syns lätt: typsnittet är för rent, för svart och helt rakt på en sida som lutar lite.

Här sätts de nya orden **med bokstäver utklippta ur själva skanningen**. Varje ”a” du skriver är ett ”a” som redan finns någonstans på sidan, i samma storlek och tjocklek, tonat till samma bläck och placerat längs samma lätta lutning som resten av raden. Ord du inte rört behåller sina ursprungliga pixlar. Resultatet är en sida som fortfarande ser skannad ut, med dina ändringar i.

## Vad händer med stämplar och namnteckningar?

De finns kvar. Bara de svarta bokstäverna du ändrar raderas och ritas om. Går en blå stämpel eller en namnteckning över raden behålls stämpeln, och luckorna där de gamla bokstäverna stod fylls med stämpeln runt omkring i stället för med vita hål.

## Så får du bra resultat

- **Skanna i 200–300 dpi.** Skanningar med låg upplösning har för få pixlar per bokstav för att kunna läsas tillförlitligt.
- **Håll sidan plan och rak.** En lätt lutning rättas till, men inte ett foto som tagits snett.
- **Bara maskinskriven text.** Handskrift känns inte igen.
- **Språk:** svenska, engelska, tyska, norska och ukrainska känns igen. De svenska sidorna läser svenska och engelska. För de andra språken byter du sidans språk högst upp.
- Skriver du en bokstav som inte finns någonstans på sidan ritas den med ett liknande öppet typsnitt, så en ovanlig bokstav kan se lite renare ut än resten.

## Är det privat?

Ja. Skanningen läses och redigeras i din webbläsare. Filen lämnar aldrig din enhet, och det spelar roll för just de dokument som brukar skannas: avtal, fakturor och id-handlingar.

När du är klar laddar du ner PDF-filen. Den ändrade texten ingår också i ett dolt textlager, så att sidan går att söka i och kopiera, och redigera igen senare.
