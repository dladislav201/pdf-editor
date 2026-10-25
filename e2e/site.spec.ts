import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { readFormFields } from '../packages/editor/src/pdf/forms';
import { downloadBytes, expectPainted, longPdf, openFile, openSample, pdfText } from './helpers';

/** Clicks a point of a page given as fractions of its width and height. */
async function clickPage(page: Page, x: number, y: number, index = 0) {
  const box = (await page.locator(`.pdfsdk-page[data-page-index="${index}"]`).boundingBox())!;
  await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
}

async function download(page: Page): Promise<Uint8Array> {
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /^Download/ }).click()]);
  return downloadBytes(file);
}

const squash = (text: string) => text.replace(/\s+/g, '');

test('start page fits the screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'A contract', exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('opens a PDF and keeps the bars on screen', async ({ page }) => {
  await openSample(page, 'A contract');
  await expect(page.getByText('1 / 3').filter({ visible: true })).toBeVisible();
  const width = page.viewportSize()!.width;
  for (const bar of [page.getByRole('navigation', { name: 'Tools' }), page.getByRole('button', { name: /^Download/ })]) {
    const box = (await bar.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
  }
});

test('lets a finger scroll the pages, except while drawing', async ({ page }) => {
  await openSample(page, 'A contract');
  const overlay = page.locator('.pdfsdk-page__overlay').first();
  const touchAction = () => overlay.evaluate((el) => getComputedStyle(el).touchAction);
  // Chromium reports "pan-x pan-y pinch-zoom" as "manipulation".
  expect(await touchAction()).toMatch(/pan-y|manipulation/);
  await page.getByRole('button', { name: 'Draw' }).click();
  expect(await touchAction()).toBe('none');
});

test('edits a paragraph and saves it into the PDF', async ({ page }) => {
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

test('finds text on every page', async ({ page }) => {
  await openSample(page, 'A contract');
  await page.getByRole('button', { name: /^Find in document/ }).click();
  await page.getByRole('textbox', { name: 'Find in document' }).fill('Provider');
  await expect(page.getByText(/^1 of \d+$/)).toBeVisible();
  await page.getByRole('textbox', { name: 'Find in document' }).press('Enter');
  await expect(page.getByText(/^2 of \d+$/)).toBeVisible();
});

test('fills a form and saves the values', async ({ page }) => {
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

test('types a signature and places it', async ({ page }) => {
  await openSample(page, 'A contract');
  await page.getByRole('button', { name: 'Sign' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add your signature' });
  await dialog.getByRole('button', { name: 'Type', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Your name' }).fill('Jane Doe');
  await dialog.getByRole('button', { name: 'Place signature' }).click();
  await clickPage(page, 0.5, 0.5);
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

test('shows page thumbnails', async ({ page }) => {
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
