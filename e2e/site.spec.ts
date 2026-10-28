import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, StandardFonts, degrees } from 'pdf-lib';
import { DEMO_LICENSE_KEY } from '../apps/demo/src/license';
import { SITE } from '../apps/demo/src/site';
import { checkLicense } from '../packages/editor/src/license';
import { readFormFields } from '../packages/editor/src/pdf/forms';
import { downloadBytes, expectPainted, gotoApp, longPdf, openFile, openSample, pdfParagraphs, pdfText, reloadApp, waitForApp } from './helpers';

/** Clicks a point of a page given as fractions of its width and height. */
async function clickPage(page: Page, x: number, y: number, index = 0) {
  const box = (await page.locator(`.pdfsdk-page[data-page-index="${index}"]`).boundingBox())!;
  await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
}

async function download(page: Page): Promise<Uint8Array> {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /^Download/ }).first().click()]);
  return downloadBytes(file);
}

const squash = (text: string) => text.replace(/\s+/g, '');

// Tests tagged @phone run on an iPhone on every push (layout, fingers, on-screen keyboards, dialogs);
// the rest run there nightly, with every browser.
test('the site key covers the site\'s own domains, so it never runs as a trial there', async () => {
  for (const host of [new URL(SITE.url).hostname, `www.${new URL(SITE.url).hostname}`, 'pdf-sdk-demo.peer-mcp.workers.dev']) {
    const license = await checkLicense(DEMO_LICENSE_KEY, host);
    expect(license.status, host).toBe('valid');
  }
});

test('start page fits the screen, in every language', { tag: '@phone' }, async ({ page }) => {
  await gotoApp(page, '/');
  await expect(page.getByRole('button', { name: 'A contract', exact: true })).toBeVisible();
  // German words are the longest: the samples wrap on a phone rather than push the page sideways.
  for (const path of ['/', '/de', '/nb', '/sv', '/uk']) {
    await gotoApp(page, path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});

test('opens a PDF and keeps the bars on screen', { tag: '@phone' }, async ({ page }) => {
  await openSample(page, 'A contract');
  await expect(page.getByText('1 / 3').filter({ visible: true })).toBeVisible();
  const width = page.viewportSize()!.width;
  for (const bar of [page.getByRole('navigation', { name: 'Tools' }), page.getByRole('button', { name: /^Download/ })]) {
    const box = (await bar.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  }
});

test('a reload opens the same file again, with its changes kept a moment after each', { tag: '@phone' }, async ({ page }) => {
  await openSample(page, 'A contract');
  const leaving = () =>
    page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      dispatchEvent(event);
      return event.defaultPrevented;
    });
  // Nothing changed yet: leaving needs no question.
  expect(await leaving()).toBe(false);
  /** What a reload goes by: the history state, the navigation, this tab's id and the files kept in this browser. */
  const kept = () =>
    page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const open = indexedDB.open('lovelydoc', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('open-files', { keyPath: 'tab' });
          open.onsuccess = () => {
            const all = open.result.transaction('open-files').objectStore('open-files').getAll();
            all.onsuccess = () => {
              const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
              resolve(JSON.stringify({ state: history.state, navigation: navigation?.type, tab: sessionStorage.getItem('tab'), kept: all.result.map((k: { tab: string; name: string }) => [k.tab, k.name]) }));
              open.result.close();
            };
          };
        }),
    );
  // The file is kept before the page goes (a person doesn't reload within the same instant).
  await expect.poll(async () => JSON.parse(await kept()).kept.length).toBe(1);

  await reloadApp(page);
  await expect(page.locator('.workspace'), await kept()).toBeVisible();
  await expectPainted(page);
  await expect(page.getByText('Services agreement.pdf').filter({ visible: true })).toBeVisible();
  await expect(page.getByText('1 / 3').filter({ visible: true })).toBeVisible();

  // A change not downloaded: the browser asks before the page goes.
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Highlight' }).click();
  const box = (await page.locator('.pdfsdk-page[data-page-index="0"]').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  // Just changed: not kept yet, so leaving asks; a moment later it's kept and leaving needn't.
  expect(await leaving()).toBe(true);
  await expect.poll(leaving, { timeout: 10_000 }).toBe(false);
  await reloadApp(page);
  await expectPainted(page);
  await expect(page.locator('.pdfsdk-highlight')).toHaveCount(1);

  // Back on the start page, the file is let go: a reload stays there.
  await page.getByRole('button', { name: 'Back to start' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await reloadApp(page);
  await expect(page.getByRole('button', { name: 'A contract', exact: true })).toBeVisible();
});

test('a tab left open over a deploy reloads for the new code instead of failing', async ({ page, browserName }) => {
  // WebKit keeps a failed chunk for its address, even across the reload; after a real deploy the reloaded page asks for new ones.
  test.skip(browserName === 'webkit', 'the same address stands in for the new chunk');
  // After a deploy the old build's chunks are gone: the first request for one fails, as it would then.
  const gone = async (pattern: string) => {
    let failed = 0;
    await page.route(pattern, (route) => (failed++ ? route.continue() : route.fulfill({ status: 404, body: 'gone' })));
    return () => failed;
  };
  const errors: string[] = [];
  page.on('request', (request) => request.url().includes('/api/errors') && errors.push(request.postData() ?? ''));
  let loads = 0;
  page.on('load', () => loads++);

  await gotoApp(page);
  const workspace = await gone('**/assets/Workspace-*.js');
  await page.getByRole('button', { name: 'A contract', exact: true }).click();
  // One reload, and the file chosen before it opens.
  await expectPainted(page);
  await expect(page.getByText('Services agreement.pdf').filter({ visible: true })).toBeVisible();
  expect(workspace()).toBe(2);
  expect(loads).toBe(2);

  // The page's language, which the page can't show without (a later deploy: its own reload).
  await page.evaluate(() => sessionStorage.removeItem('lovelydoc.reloaded'));
  const german = await gone('**/assets/de-*.js');
  await gotoApp(page, '/de');
  await expect(page.getByRole('button', { name: 'Einen Vertrag', exact: true })).toBeVisible();
  expect(german()).toBe(2);
  expect(errors).toEqual([]);
});

test('clears copies kept for tabs that were closed, and gives a reloaded tab its own copy', async ({ page }) => {
  await openSample(page, 'A contract');
  /** The tab ids of the files kept in this browser, after `change` ran on the store. */
  const store = (change: 'read' | 'plant') =>
    page.evaluate(
      (change) =>
        new Promise<string[]>((resolve) => {
          const open = indexedDB.open('lovelydoc', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('open-files', { keyPath: 'tab' });
          open.onsuccess = () => {
            const tx = open.result.transaction('open-files', 'readwrite');
            const files = tx.objectStore('open-files');
            // A copy a closed tab left an hour ago.
            if (change === 'plant') files.put({ tab: 'closed-tab', at: Date.now() - 3_600_000, name: 'Old.pdf', type: 'application/pdf', lastModified: 0, bytes: new ArrayBuffer(8), options: {} });
            const all = files.getAllKeys();
            tx.oncomplete = () => {
              resolve((all.result as string[]).sort());
              open.result.close();
            };
          };
        }),
      change,
    );
  await expect.poll(async () => (await store('read')).length).toBe(1);
  const [own] = await store('read');
  expect(await store('plant')).toContain('closed-tab');

  await reloadApp(page);
  await expectPainted(page);
  // The closed tab's copy is gone; this tab now keeps its file under a new id (a duplicated tab would too).
  const after = await store('read');
  expect(after).not.toContain('closed-tab');
  const tab = await page.evaluate(() => sessionStorage.getItem('tab'));
  expect(tab).not.toBe(own);
  expect(after).toContain(tab);
});

test('lets a finger scroll the pages, except while drawing', { tag: '@phone' }, async ({ page }) => {
  await openSample(page, 'A contract');
  const overlay = page.locator('.pdfsdk-page__overlay').first();
  const touchAction = () => overlay.evaluate((el) => getComputedStyle(el).touchAction);
  // Chromium reports "pan-x pan-y pinch-zoom" as "manipulation".
  expect(await touchAction()).toMatch(/pan-y|manipulation/);
  await page.getByRole('button', { name: 'Draw' }).click();
  expect(await touchAction()).toBe('none');
});

test('edits a paragraph and saves it into the PDF', { tag: '@phone' }, async ({ page }) => {
  await openSample(page, 'A contract');
  await page.getByRole('button', { name: 'Edit text' }).click();
  // The opening paragraph, under the title.
  await clickPage(page, 0.3, 0.215);
  // The paragraph editor draws its own caret over the page.
  const editor = page.locator('.pdfsdk-caret');
  await expect(editor).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Replaced opening paragraph.');
  await page.keyboard.press('Escape');
  const [first] = await pdfText(await download(page));
  expect(squash(first!)).toContain('Replacedopeningparagraph.');
  expect(squash(first!)).not.toContain('isenteredintoby');
});

test('keeps an edited paragraph across a reload', async ({ page }) => {
  await openSample(page, 'A contract');
  await page.getByRole('button', { name: 'Edit text' }).click();
  await clickPage(page, 0.3, 0.215);
  await expect(page.locator('.pdfsdk-caret')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.keyboard.type(' Kept across a reload.');
  const leaving = () =>
    page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      dispatchEvent(event);
      return event.defaultPrevented;
    });
  // A paragraph still open isn't kept: leaving asks.
  await page.waitForTimeout(1500);
  expect(await leaving()).toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(leaving, { timeout: 10_000 }).toBe(false);
  await reloadApp(page);
  await expectPainted(page);
  const [first] = await pdfText(await download(page));
  expect(squash(first!)).toContain('Keptacrossareload.');
});

test('the Edit text hint mentions Esc only while a paragraph is open', async ({ page }) => {
  await openSample(page, 'A contract');
  await page.getByRole('button', { name: 'Edit text' }).click();
  await expect(page.getByText('Click a paragraph to edit it.', { exact: true })).toBeVisible();
  await clickPage(page, 0.3, 0.215);
  await expect(page.getByText('Esc or a click outside finishes the paragraph.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Click a paragraph to edit it.', { exact: true })).toBeVisible();
});

test('undoes typing in an open paragraph, with any keyboard layout', async ({ page }) => {
  await openSample(page, 'A contract');
  await page.getByRole('button', { name: 'Edit text' }).click();
  await clickPage(page, 0.3, 0.215);
  await expect(page.locator('.pdfsdk-caret')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Replaced opening paragraph.');
  // ⌘Z on a Ukrainian layout: the key is "я", the code is still KeyZ.
  await page.locator('.pdfsdk-text-input').dispatchEvent('keydown', { key: 'я', code: 'KeyZ', metaKey: true, ctrlKey: true, bubbles: true });
  await page.keyboard.press('Escape');
  const [first] = await pdfText(await download(page));
  expect(squash(first!)).toContain('isenteredintoby');
  expect(squash(first!)).not.toContain('Replacedopeningparagraph.');
});

test('undoes and redoes a paragraph edit after leaving it', async ({ page }) => {
  await openSample(page, 'A contract');
  await page.getByRole('button', { name: 'Edit text' }).click();
  await clickPage(page, 0.3, 0.215);
  await expect(page.locator('.pdfsdk-caret')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Replaced opening paragraph.');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^Download · 1 edit/ })).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
  let [first] = await pdfText(await download(page));
  expect(squash(first!)).toContain('isenteredintoby');

  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(page.getByRole('button', { name: /^Download · 1 edit/ })).toBeVisible();
  [first] = await pdfText(await download(page));
  expect(squash(first!)).toContain('Replacedopeningparagraph.');
});

test('takes edits from on-screen keyboards that change the input themselves, as Android ones do', { tag: '@phone' }, async ({ page }, info) => {
  await openSample(page, 'A contract');
  await page.getByRole('button', { name: 'Edit text' }).click();
  await clickPage(page, 0.3, 0.215);
  await expect(page.locator('.pdfsdk-caret')).toHaveCount(1);
  const input = page.locator('.pdfsdk-text-input');
  // Never empty: a keyboard always has something to delete, so it reports Backspace.
  await expect(input).toHaveValue('\u200b\u200b');
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  // A Backspace the browser doesn't let the page cancel: the input loses a character, then says so.
  await input.evaluate((el: HTMLTextAreaElement) => {
    el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', cancelable: false, bubbles: true }));
    el.value = el.value.slice(0, -1);
    el.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
  });
  // Text that arrives only as a change of the input.
  await input.evaluate((el: HTMLTextAreaElement) => {
    el.value += '!';
    el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '!', bubbles: true }));
  });
  await expect(input).toHaveValue('\u200b\u200b');
  if (info.project.name === 'chromium') {
    // A word composed by an input method, committed once.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: ' ok', selectionStart: 3, selectionEnd: 3 });
    await cdp.send('Input.insertText', { text: ' ok' });
  }
  await page.keyboard.press('Escape');
  // Retyped words are drawn one by one: compare without the gaps.
  const [first] = await pdfText(await download(page));
  const ending = info.project.name === 'chromium' ? 'togetherthe"Parties"!ok' : 'togetherthe"Parties"!';
  expect(squash(first!)).toContain(ending);
  expect(squash(first!)).not.toContain('"Parties".');
  expect(squash(first!)).not.toContain('okok');
});

test('deletes a word with the system\'s word key: Option on a Mac, Ctrl elsewhere', async ({ page }) => {
  await openSample(page, 'A contract');
  await page.getByRole('button', { name: 'Edit text' }).click();
  await clickPage(page, 0.3, 0.215);
  await expect(page.locator('.pdfsdk-caret')).toHaveCount(1);
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.keyboard.press(`${mac ? 'Alt' : 'Control'}+Backspace`);
  await page.keyboard.press(`${mac ? 'Alt' : 'Control'}+Backspace`);
  await page.keyboard.press('Escape');
  const [first] = await pdfText(await download(page));
  // The last word and its punctuation go, then "the": the rest of the line stays.
  expect(squash(first!)).toContain('andCustomerareeacha"Party"andtogether');
  expect(squash(first!)).not.toContain('togetherthe');
});

test('opens text under a watermark across the page, and leaves the watermark where it is', async ({ page }) => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const sheet = pdf.addPage([400, 400]);
  ['The supplier delivers the goods to the address', 'given in the order within ten working days.'].forEach((text, i) =>
    sheet.drawText(text, { x: 40, y: 250 - i * 14, size: 11, font }),
  );
  sheet.drawText('Payment is due within thirty days.', { x: 40, y: 200, size: 11, font });
  sheet.drawText('CONFIDENTIAL', { x: 60, y: 80, size: 48, font, rotate: degrees(45), opacity: 0.2 });
  const bytes = await pdf.save();
  const watermark = (await pdfParagraphs(bytes)).find((p) => p.text === 'CONFIDENTIAL')!;
  await openFile(page, 'Watermarked.pdf', bytes);
  await page.getByRole('button', { name: 'Edit text' }).click();
  // Inside the watermark's bounding box, on the paragraph's first line.
  await clickPage(page, 0.3, 1 - 250 / 400 - 0.005);
  await expect(page.locator('.pdfsdk-caret')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.keyboard.type(' Partial deliveries are allowed when the customer agrees to them in writing.');
  await page.keyboard.press('Escape');
  const after = await pdfParagraphs(await download(page));
  expect(after.find((p) => p.text.startsWith('The supplier'))!.text).toContain('in writing.');
  // The paragraph under it grew and pushed the next one down; the watermark stays.
  expect(after.find((p) => p.text.startsWith('Payment'))!.baseline).toBeLessThan(200 - 5);
  expect(after.find((p) => p.text === 'CONFIDENTIAL')!.baseline).toBeCloseTo(watermark.baseline, 1);
});

test('makes text bold and pushes what is below down when a paragraph grows', async ({ page }) => {
  await openSample(page, 'A contract');
  const before = await pdfParagraphs(await download(page));
  const heading = before.find((p) => p.text === '1. Scope of Services')!;
  await page.getByRole('button', { name: 'Edit text' }).click();
  await clickPage(page, 0.3, 0.215);
  await expect(page.locator('.pdfsdk-caret')).toHaveCount(1);
  // The first word: from the paragraph's start, extended to the end of the word.
  await page.keyboard.press('ControlOrMeta+ArrowUp');
  for (let i = 0; i < 'This'.length; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.keyboard.type(' Either Party may assign this Agreement to an affiliate with written notice to the other Party.');
  await page.keyboard.press('Escape');

  const after = await pdfParagraphs(await download(page));
  const opening = after.find((p) => p.text.startsWith('This Software'))!;
  expect(opening.fonts['This']).toBe('Helvetica-Bold');
  expect(opening.fonts['Software']).toBe('Helvetica');
  expect(opening.text).toContain('written notice to the other Party.');
  // The paragraph grew by a line or more; the heading under it moved down as much.
  const moved = after.find((p) => p.text === '1. Scope of Services')!;
  expect(heading.baseline - moved.baseline).toBeGreaterThan(10);
});

test('pulls what is below up when a paragraph gets shorter, and puts it back on undo', async ({ page }) => {
  await openSample(page, 'A contract');
  const before = await pdfParagraphs(await download(page));
  const heading = before.find((p) => p.text === '1. Scope of Services')!;
  const footer = before.find((p) => p.text.startsWith('Northwind Software Ltd.'))!;
  await page.getByRole('button', { name: 'Edit text' }).click();
  await clickPage(page, 0.3, 0.215);
  await expect(page.locator('.pdfsdk-caret')).toHaveCount(1);
  // From the end of the paragraph up two lines: it ends after its second line.
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');

  const after = await pdfParagraphs(await download(page));
  const pulled = after.find((p) => p.text === '1. Scope of Services')!;
  expect(pulled.baseline - heading.baseline).toBeGreaterThan(20);
  // The footer sits apart, at the bottom of the page: it stays.
  expect(after.find((p) => p.text.startsWith('Northwind Software Ltd.'))!.baseline).toBeCloseTo(footer.baseline, 1);

  await page.getByRole('button', { name: 'Undo' }).click();
  const undone = await pdfParagraphs(await download(page));
  expect(undone.find((p) => p.text === '1. Scope of Services')!.baseline).toBeCloseTo(heading.baseline, 1);
});

test('sets a word in another size and font', { tag: '@phone' }, async ({ page }) => {
  await openSample(page, 'A contract');
  await page.getByRole('button', { name: 'Edit text' }).click();
  await clickPage(page, 0.3, 0.215);
  await expect(page.locator('.pdfsdk-caret')).toHaveCount(1);
  await expect(page.getByRole('combobox', { name: 'Font' })).toHaveValue('doc:helvetica');
  await page.keyboard.press('ControlOrMeta+ArrowUp');
  for (let i = 0; i < 'This'.length; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.getByRole('combobox', { name: 'Text size' }).selectOption('18');
  await page.getByRole('combobox', { name: 'Font' }).selectOption('serif');
  await expect(page.getByRole('combobox', { name: 'Text size' })).toHaveValue('18');
  // The paragraph still has the caret: typing goes on in it.
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.keyboard.type(' Signed.');
  await page.keyboard.press('Escape');

  const after = await pdfParagraphs(await download(page));
  const opening = after.find((p) => p.text.includes('Software Services Agreement'))!;
  expect(opening.fonts['This']).toMatch(/Tinos-Regular/);
  expect(opening.sizes['This']).toBe(18);
  expect(opening.fonts['Software']).toBe('Helvetica');
  expect(opening.sizes['Software']).toBe(10.5);
  expect(opening.text).toContain('"Parties". Signed.');
});

/** Each text markup annotation of a saved PDF's first page: its type and its quads as [x, y] corners. */
async function marks(bytes: Uint8Array): Promise<{ subtype: string; quads: [number, number][][] }[]> {
  const doc = await PDFDocument.load(bytes);
  const annots = doc.getPage(0).node.Annots();
  return Array.from({ length: annots?.size() ?? 0 }, (_, i) => {
    const dict = annots!.lookup(i, PDFDict);
    const values = dict.lookup(PDFName.of('QuadPoints'), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
    const quads = [];
    for (let q = 0; q + 8 <= values.length; q += 8) quads.push([0, 1, 2, 3].map((k) => [values[q + k * 2]!, values[q + k * 2 + 1]!] as [number, number]));
    return { subtype: dict.lookup(PDFName.of('Subtype'), PDFName).decodeText(), quads };
  });
}

test('highlights, underlines and strikes out text by dragging across it', { tag: '@phone' }, async ({ page, isMobile }) => {
  await openSample(page, 'A contract');
  const box = (await page.locator('.pdfsdk-page[data-page-index="0"]').boundingBox())!;
  /** Drags between two points of the first page given as fractions of its width and height. */
  const drag = async (from: [number, number], to: [number, number]) => {
    await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 5 });
    await page.mouse.up();
  };
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Highlight' }).click();
  // Phones have the choice of markup where wider screens have the hint.
  if (!isMobile) await expect(page.getByText('Drag across text to highlight it')).toBeVisible();
  // From the middle of the first line of "Provider shall deliver …" to the middle of its third.
  await drag([0.64, 0.2895], [0.26, 0.3273]);
  await page.getByRole('button', { name: 'Underline' }).click();
  // Past the end of the line: up to its last word.
  await drag([0.115, 0.354], [0.95, 0.354]);
  await page.getByRole('button', { name: 'Strike out' }).click();
  await drag([0.115, 0.372], [0.38, 0.372]);

  // Each quad as its left, right, bottom and top.
  const marked = (await marks(await download(page))).map(({ subtype, quads }) => ({
    subtype,
    lines: quads.map(([top, end, bottom]) => ({ left: top![0], right: end![0], bottom: bottom![1], top: top![1] })),
  }));
  expect(marked.map((m) => [m.subtype, m.lines.length])).toEqual([
    ['Highlight', 3],
    ['Underline', 1],
    ['StrikeOut', 1],
  ]);
  const [first, middle, last] = marked[0]!.lines;
  // Line by line, each about as high as the text: the first starts mid-line, the middle one is whole, the last stops mid-line.
  for (const line of marked[0]!.lines) expect(line.top - line.bottom).toBeGreaterThan(8);
  expect(first!.left).toBeGreaterThan(middle!.left + 100);
  expect(last!.right).toBeLessThan(middle!.right - 100);
  expect(first!.bottom).toBeGreaterThan(middle!.top - 3);
  expect(marked[1]!.lines[0]!.right - marked[1]!.lines[0]!.left).toBeGreaterThan(300);
  expect(marked[2]!.lines[0]!.right - marked[2]!.lines[0]!.left).toBeLessThan(200);
});

test('marks a whole word with a double click, and text that runs up the page along it', { tag: '@phone' }, async ({ page }) => {
  await openSample(page, 'A contract');
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Highlight' }).click();
  const box = (await page.locator('.pdfsdk-page[data-page-index="0"]').boundingBox())!;
  // "Services" in the opening paragraph, right after picking the tool: on a slow machine before the page's text is read.
  await page.mouse.dblclick(box.x + box.width * 0.262, box.y + box.height * 0.2015);
  const [word] = await marks(await download(page));
  const [topStart, topEnd, bottomStart] = word!.quads[0]!;
  expect(word!.subtype).toBe('Highlight');
  expect(topEnd![0] - topStart![0]).toBeGreaterThan(25);
  expect(topEnd![0] - topStart![0]).toBeLessThan(60);
  expect(topStart![1] - bottomStart![1]).toBeGreaterThan(8);

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const sheet = pdf.addPage([400, 400]);
  sheet.drawText('Upright text', { x: 40, y: 350, size: 12, font });
  sheet.drawText('Label going up', { x: 300, y: 100, size: 12, font, rotate: degrees(90) });
  await openFile(page, 'Label.pdf', await pdf.save());
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Highlight' }).click();
  const sheetBox = (await page.locator('.pdfsdk-page[data-page-index="0"]').boundingBox())!;
  const at = (x: number, y: number) => [sheetBox.x + (sheetBox.width * x) / 400, sheetBox.y + (sheetBox.height * (400 - y)) / 400] as const;
  // From the label's start up past its end, just left of its baseline.
  await page.mouse.move(...at(296, 101));
  await page.mouse.down();
  await page.mouse.move(...at(296, 260), { steps: 6 });
  await page.mouse.up();
  const [label] = await marks(await download(page));
  const [top, end, bottom, bottomEnd] = label!.quads[0]!;
  expect(label!.subtype).toBe('Highlight');
  // Along the text is up the page; its top edge is to the left of its bottom edge.
  expect(end![1] - top![1]).toBeGreaterThan(70);
  expect(bottomEnd![1] - bottom![1]).toBeGreaterThan(70);
  expect(bottom![0] - top![0]).toBeGreaterThan(8);
  expect(Math.abs(end![0] - top![0])).toBeLessThan(0.5);
});

test('opens a password-protected PDF after asking for its password', async ({ page }) => {
  const bytes = readFileSync(new URL('../packages/editor/test/fixtures/protected-user.pdf', import.meta.url));
  await gotoApp(page, '/');
  await page.locator('input[type=file]').setInputFiles({ name: 'Protected.pdf', mimeType: 'application/pdf', buffer: bytes });
  const dialog = page.getByRole('dialog', { name: 'This PDF is protected' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password').fill('wrong');
  await dialog.getByRole('button', { name: 'Open' }).click();
  await expect(dialog.getByText('That password isn’t right. Try again.')).toBeVisible();
  await dialog.getByLabel('Password').fill('secret');
  await dialog.getByRole('button', { name: 'Open' }).click();
  await expectPainted(page);
  await expect(page.getByText(/Opened with its password/)).toBeVisible();
  // The copy has no password: pdf-lib (which refuses encrypted files) reads it.
  const saved = await download(page);
  expect((await PDFDocument.load(saved)).getPageCount()).toBe(1);
  expect(squash((await pdfText(saved))[0]!)).toContain('SoftwareServicesAgreement');
});

test('saves a PDF with a password that opens it, here and in other viewers', { tag: '@phone' }, async ({ page }) => {
  await openSample(page, 'A contract');
  await page.getByRole('button', { name: 'More ways to save' }).click();
  await page.getByRole('menuitem', { name: /With a password/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Protect with a password' });
  await dialog.getByLabel('Password', { exact: true }).fill('Kyiv 2026');
  await dialog.getByLabel('Repeat the password').fill('Kyiv 2025');
  await expect(dialog.getByText('The passwords don’t match.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Download' })).toBeDisabled();
  await dialog.getByLabel('Repeat the password').fill('Kyiv 2026');
  const [file] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download' }).click()]);
  await expect(dialog).toBeHidden();
  const bytes = await downloadBytes(file);
  expect(file.suggestedFilename()).toBe('Services agreement.pdf');
  await expect(pdfText(bytes)).rejects.toThrow();
  expect(squash((await pdfText(bytes, 'Kyiv 2026'))[0]!)).toContain('SOFTWARESERVICESAGREEMENT');

  // Opened here again, it asks for the password.
  await gotoApp(page, '/');
  await page.locator('input[type=file]').setInputFiles({ name: 'Protected.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  const ask = page.getByRole('dialog', { name: 'This PDF is protected' });
  await ask.getByLabel('Password').fill('Kyiv 2026');
  await ask.getByRole('button', { name: 'Open' }).click();
  await expectPainted(page);
});

test('asks for the password again after cancelling', async ({ page }) => {
  const bytes = readFileSync(new URL('../packages/editor/test/fixtures/protected-user.pdf', import.meta.url));
  await gotoApp(page, '/');
  await page.locator('input[type=file]').setInputFiles({ name: 'Protected.pdf', mimeType: 'application/pdf', buffer: bytes });
  const dialog = page.getByRole('dialog', { name: 'This PDF is protected' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Enter password' }).click();
  await dialog.getByLabel('Password').fill('secret');
  await dialog.getByRole('button', { name: 'Open' }).click();
  await expectPainted(page);
  await expect(page.getByRole('button', { name: 'Enter password' })).toHaveCount(0);
});

test('opens a PDF with only an owner password without asking, and saves it', async ({ page }) => {
  const bytes = readFileSync(new URL('../packages/editor/test/fixtures/protected-owner.pdf', import.meta.url));
  await openFile(page, 'Restricted.pdf', bytes);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await PDFDocument.load(await download(page))).getPageCount()).toBe(1);
});

test('finds text on every page', async ({ page }) => {
  await openSample(page, 'A contract');
  await page.getByRole('button', { name: /^Find in document/ }).click();
  await page.getByRole('textbox', { name: 'Find in document' }).fill('Provider');
  await expect(page.getByText(/^1 of \d+$/)).toBeVisible();
  await page.getByRole('textbox', { name: 'Find in document' }).press('Enter');
  await expect(page.getByText(/^2 of \d+$/)).toBeVisible();
});

test('keeps form entries across a reload', async ({ page }) => {
  await openSample(page, 'A form');
  const leaving = () =>
    page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      dispatchEvent(event);
      return event.defaultPrevented;
    });
  expect(await leaving()).toBe(false);
  await page.locator('input.pdfsdk-field').first().fill('Olena');
  await expect.poll(leaving).toBe(true);
  await expect.poll(leaving, { timeout: 10_000 }).toBe(false);
  await reloadApp(page);
  await expect(page.locator('input.pdfsdk-field').first()).toHaveValue('Olena');
});

test('fills a form and saves the values', { tag: '@phone' }, async ({ page }) => {
  await openSample(page, 'A form');
  await expect(page.getByText('7 fields to fill.')).toBeVisible();
  await page.locator('input.pdfsdk-field').first().fill('Olena Koval');
  await page.getByRole('radio').nth(1).click();
  await page.getByRole('checkbox').click();
  await page.getByRole('combobox').selectOption('Canada');
  const fields = readFormFields(await PDFDocument.load(await download(page)));
  expect(Object.fromEntries(fields.map((f) => [f.name, f.value]))).toMatchObject({
    full_name: 'Olena Koval',
    membership: 'Plus',
    terms: true,
    country: 'Canada',
  });
});

test('types a signature and places it', { tag: '@phone' }, async ({ page }) => {
  await openSample(page, 'A contract');
  await page.getByRole('button', { name: 'Sign' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add your signature' });
  await dialog.getByRole('button', { name: 'Type', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Your name' }).fill('Jane Doe');
  await dialog.getByRole('button', { name: 'Place signature' }).click();
  await clickPage(page, 0.5, 0.5);
  // A reload a moment later keeps it.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const event = new Event('beforeunload', { cancelable: true });
        dispatchEvent(event);
        return event.defaultPrevented;
      }),
    )
    .toBe(false);
  await reloadApp(page);
  await expectPainted(page);
  await expect(page.locator('.pdfsdk-page image')).toHaveCount(1);
  const doc = await PDFDocument.load(await download(page));
  const stamps = doc
    .getPage(0)
    .node.Annots()
    ?.asArray()
    .map((ref) => doc.context.lookup(ref))
    .filter(
      (annot) =>
        annot &&
        'get' in annot &&
        String((annot as never as { get(n: PDFName): unknown }).get(PDFName.of('Subtype'))) === '/Stamp',
    );
  expect(stamps?.length).toBe(1);
});

test('lifts a signature and a stamp off a photo of paper in shadow, and places them', { tag: '@phone' }, async ({ page, isMobile }) => {
  await openSample(page, 'A contract');
  await page.getByRole('button', { name: 'Sign' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add your signature' });
  await dialog.getByRole('button', { name: 'Photo', exact: true }).click();
  // A phone photo: warm paper going into shadow, a signature, and a pale blue stamp in the shadow.
  const jpeg = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext('2d')!;
    const light = ctx.createLinearGradient(0, 0, 800, 0);
    light.addColorStop(0, 'rgb(245,238,225)');
    light.addColorStop(1, 'rgb(150,140,125)');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, 800, 600);
    ctx.strokeStyle = 'rgb(30,30,45)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    for (let x = 80; x < 460; x += 4) ctx.lineTo(x, 300 + Math.sin(x / 30) * 60);
    ctx.stroke();
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = 'rgb(60,80,200)';
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(620, 300, 85, 0, Math.PI * 2);
    ctx.stroke();
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/jpeg', 0.9));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  // A picture the browser can't read says so.
  await dialog.locator('input[type=file]').setInputFiles({ name: 'photo.heic', mimeType: 'image/heic', buffer: Buffer.from('not a picture') });
  await expect(dialog.getByText('This picture can’t be read here.')).toBeVisible();
  await dialog.locator('input[type=file]').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg) });
  await expect(dialog.getByText('This picture can’t be read here.')).toBeHidden();
  await expect(dialog.getByLabel('Clean up the background')).toBeVisible();
  // Phones have no preview beside the dialog: the result shows in the tab.
  await expect(dialog.locator('.sign-upload__preview')).toBeVisible({ visible: !!isMobile });

  /** The preview's pixels: its size, the top-left corner's alpha, and the opaque ones by colour. */
  const preview = () =>
    dialog.locator('.modal__paper img').evaluate(async (img: HTMLImageElement) => {
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let opaque = 0;
      let blue = 0;
      let dark = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3]! < 200) continue;
        opaque++;
        if (px[i + 2]! > px[i]! + 40) blue++;
        if (px[i]! < 70 && px[i + 1]! < 70 && px[i + 2]! < 90) dark++;
      }
      return { width: canvas.width, height: canvas.height, corner: px[3]!, opaque, blue, dark };
    });
  const own = await preview();
  // Cut down to the ink, the shadowed paper gone, the stamp blue and the signature dark.
  expect(own.width).toBeLessThan(700);
  expect(own.corner).toBe(0);
  expect(own.blue).toBeGreaterThan(1500);
  expect(own.dark).toBeGreaterThan(1500);
  expect(own.opaque).toBeLessThan(own.width * own.height * 0.2);

  await dialog.getByRole('button', { name: 'Black' }).click();
  await expect.poll(async () => (await preview()).blue).toBe(0);
  expect((await preview()).dark).toBeGreaterThan(own.dark + 1000);

  await dialog.getByRole('button', { name: 'Place signature' }).click();
  await clickPage(page, 0.5, 0.5);
  const doc = await PDFDocument.load(await download(page));
  const annots = doc.getPage(0).node.Annots()!;
  const kinds = Array.from({ length: annots.size() }, (_, i) => annots.lookup(i, PDFDict).lookup(PDFName.of('Subtype'), PDFName).decodeText());
  expect(kinds).toEqual(['Stamp']);
});

test('shows page thumbnails', { tag: '@phone' }, async ({ page }) => {
  await openSample(page, 'A contract');
  await page.getByRole('button', { name: 'Pages', exact: true }).click();
  await expect(page.locator('.thumb')).toHaveCount(3);
  await expect.poll(() => page.locator('.thumb canvas, .thumb img').count()).toBeGreaterThanOrEqual(3);
});

test('compresses a scan', async ({ page }) => {
  await openSample(page, 'A scanned invoice');
  await page.getByRole('button', { name: 'More ways to save' }).click();
  await page.getByRole('menuitem', { name: /Compressed PDF/ }).click();
  await page.getByRole('button', { name: 'Compress', exact: true }).click();
  await expect(page.getByText(/% smaller|Already as small/)).toBeVisible({ timeout: 30_000 });
});

test('recognizes the text of a scan', async ({ page }) => {
  test.setTimeout(120_000);
  await openSample(page, 'A scanned invoice');
  await page.getByRole('button', { name: 'Recognize text' }).click();
  await expect(page.getByText(/words recognized/)).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: /^Find in document/ }).click();
  await page.getByRole('textbox', { name: 'Find in document' }).fill('Supplier');
  await expect(page.getByText(/^1 of \d+$/)).toBeVisible();
  await page.getByRole('textbox', { name: 'Find in document' }).fill('Toner cartridge');
  await expect(page.getByText('1 of 1')).toBeVisible();
});

test('reads a scan when Edit text clicks on it and opens the line', async ({ page }) => {
  test.setTimeout(120_000);
  await openSample(page, 'A scanned invoice');
  await expect(page.getByText(/Click any line on the scan/)).toBeVisible();
  // "Supplier: Northwind Supplies Ltd, …" (below the notices on a phone), without pressing Recognize text first.
  await clickPage(page, 0.25, 0.134);
  await expect(page.locator('.pdfsdk-caret')).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByText(/words recognized/)).toBeVisible();
});

test('reads a German scan in German', async ({ page }) => {
  test.setTimeout(120_000);
  await gotoApp(page, '/de');
  await page.getByRole('button', { name: 'Eine gescannte Rechnung' }).click();
  await expectPainted(page);
  await page.getByRole('button', { name: 'Text erkennen' }).click();
  await expect(page.getByText(/Wörter erkannt/)).toBeVisible({ timeout: 90_000 });
  await page.getByRole('button', { name: /^Im Dokument suchen/ }).click();
  for (const word of ['Müller', 'Hauptstraße', 'Bäckerei Großmann']) {
    await page.getByRole('textbox', { name: 'Im Dokument suchen' }).fill(word);
    await expect(page.getByText('1 von 1')).toBeVisible();
  }
});

test('opens a 300-page document quickly and reaches its end', async ({ page }, info) => {
  test.setTimeout(120_000);
  const bytes = await longPdf(300);
  const started = Date.now();
  await openFile(page, 'Long report.pdf', bytes);
  const opened = Date.now() - started;
  await expect(page.getByText('1 / 300').filter({ visible: true })).toBeVisible();
  // Jump to the last page and wait for it to be drawn.
  await page.locator('.pdfsdk-page[data-page-index="299"]').scrollIntoViewIfNeeded();
  await expectPainted(page, 299);
  await page.getByRole('button', { name: /^Find in document/ }).click();
  const searched = Date.now();
  await page.getByRole('textbox', { name: 'Find in document' }).fill('checkpoint300');
  await expect(page.getByText('1 of 1')).toBeVisible({ timeout: 60_000 });
  info.annotations.push({ type: 'timing', description: `open ${opened} ms, search ${Date.now() - searched} ms` });
  expect(opened).toBeLessThan(10_000);
});

test('every page in the sitemap is plain HTML with its own title, heading and structured data', async ({ request }, info) => {
  test.skip(info.project.name !== 'chromium', 'Server output: one browser is enough.');
  const sitemap = await (await request.get('/sitemap.xml')).text();
  const paths = [...sitemap.matchAll(/<loc>https?:\/\/[^/]+(\/[^<]*)<\/loc>/g)].map((m) => m[1]!);
  expect(paths.length).toBeGreaterThanOrEqual(14);
  expect(paths).toContain('/blog');
  const titles = new Set<string>();
  for (const path of paths) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    const html = await response.text();
    titles.add(/<title>([^<]+)<\/title>/.exec(html)?.[1] ?? '');
    expect(html, path).toMatch(/<h1>[^<]+<\/h1>/);
    expect(html, path).toContain(`<link rel="canonical" href="`);
    // Tool pages answer questions; guides are articles.
    expect(html, path).toContain(path.startsWith('/blog') ? (path === '/blog' ? '"@type":"Blog"' : '"@type":"Article"') : '"@type":"FAQPage"');
  }
  expect(titles.size).toBe(paths.length);
  expect(await (await request.get('/robots.txt')).text()).toContain('Sitemap:');
});

test('the SDK page is plain HTML for search, and its form asks for a trial key', async ({ page, request }, info) => {
  if (info.project.name === 'chromium') {
    const html = await (await request.get('/sdk')).text();
    expect(html).toContain('<h1>A PDF editor for your web app.</h1>');
    expect(html).toContain('"@type":"SoftwareApplication"');
  }
  // The Worker isn't in the preview: answer for it, and see what the form sends.
  const sent: unknown[] = [];
  await page.route('**/api/trial', async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: sent.length === 1 ? 400 : 204 });
  });
  await gotoApp(page, '/sdk');
  await page.getByRole('link', { name: 'Get a trial key' }).click();
  await page.getByLabel('Your name').fill('Jane Doe');
  await page.getByLabel('Work email').fill('jane@acme.com');
  await page.getByLabel('Company').fill('Acme');
  await page.getByLabel('Domains the key should cover').fill('app.acme.com');
  await page.getByLabel('What are you building?').fill('Contracts in our CRM');
  // Turned away (say, a domain it can't take): it says so, and keeps what was typed.
  await page.getByRole('button', { name: 'Request a trial key' }).click();
  await expect(page.getByText('That didn’t go through.')).toBeVisible();
  await page.getByRole('button', { name: 'Request a trial key' }).click();
  await expect(page.getByText('We’ll send your key to jane@acme.com')).toBeVisible();
  expect(sent[1]).toEqual({ name: 'Jane Doe', email: 'jane@acme.com', company: 'Acme', domains: 'app.acme.com', message: 'Contracts in our CRM', website: '' });
});

test('a tool page opens its tool', async ({ page }) => {
  const bytes = await longPdf(1);
  await gotoApp(page, '/compress-pdf');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Compress a PDF.');
  await page.locator('input[type=file]').setInputFiles({ name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page.getByRole('dialog', { name: 'Compress PDF' })).toBeVisible();
  await gotoApp(page, '/sign-pdf');
  await page.locator('input[type=file]').setInputFiles({ name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page.getByRole('dialog', { name: 'Add your signature' })).toBeVisible();
});

test('every language has its own pages, linked to each other, and a German page works in German', async ({ page, request }, info) => {
  const bytes = await longPdf(1);
  if (info.project.name === 'chromium') {
    const html = await (await request.get('/de/pdf-komprimieren')).text();
    expect(html).toContain('<html lang="de">');
    expect(html).toContain('<h1>Ein PDF komprimieren.</h1>');
    for (const [lang, path] of [
      ['en', '/compress-pdf'],
      ['nb', '/nb/komprimer-pdf'],
      ['sv', '/sv/komprimera-pdf'],
      ['uk', '/uk/stysnuty-pdf'],
      ['x-default', '/compress-pdf'],
    ]) {
      expect(html).toMatch(new RegExp(`hreflang="${lang}" href="[^"]+${path}"`));
    }
    const sitemap = await (await request.get('/sitemap.xml')).text();
    expect(sitemap.match(/<loc>/g)!.length).toBeGreaterThanOrEqual(70);
  }
  await gotoApp(page, '/uk');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Редагуйте будь-який PDF просто в браузері.');
  await page.getByRole('button', { name: 'Мова' }).click();
  await page.getByRole('menuitem', { name: 'Deutsch' }).click();
  await expect(page).toHaveURL(/\/de$/);
  await waitForApp(page);
  await page.locator('input[type=file]').setInputFiles({ name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  // Exactly: the start page's footer is "Alle Werkzeuge".
  await expect(page.getByRole('navigation', { name: 'Werkzeuge', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Herunterladen/ })).toBeVisible();
});

test('counts visits, except from a browser marked with ?notrack', async ({ page }) => {
  // What each count sent; WebKit doesn't show a beacon's body, only that it went.
  const sent: string[] = [];
  await page.route('**/api/events', async (route) => {
    sent.push(route.request().postData() ?? '');
    await route.fulfill({ status: 204 });
  });
  // Counts go out when the page is hidden (or every few seconds).
  const hide = () => page.evaluate(() => dispatchEvent(new Event('pagehide')));
  await gotoApp(page, '/');
  await hide();
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  expect(sent.join()).toMatch(/view\.home\.en|^$/);

  sent.length = 0;
  await gotoApp(page, '/?notrack=1');
  await expect(page.getByText('Visits from this browser are no longer counted.')).toBeVisible();
  // The address is clean again; the mark stays for the next visits.
  expect(new URL(page.url()).search).toBe('');
  await gotoApp(page, '/sdk');
  await hide();
  await page.waitForTimeout(500);
  expect(sent).toEqual([]);

  await gotoApp(page, '/?notrack=0');
  await expect(page.getByText('Visits from this browser are counted again.')).toBeVisible();
  await hide();
  await expect.poll(() => sent.length).toBeGreaterThan(0);
});

test('a page opens in the dark theme picked before, without waiting for the app', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
  // No app code at all: what the page looks like before it loads.
  await page.route('**/assets/*.js', (route) => route.abort());
  await page.goto('/de');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(20, 20, 20)');
});
