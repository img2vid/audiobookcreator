import { test, expect } from '@playwright/test';
import { zipSync, strToU8, unzipSync } from 'fflate';
import { readFile } from 'node:fs/promises';

test('CPU-only real synthesis, WAV/ZIP download, reload and chunk reuse without remote requests', async ({ page, context, browserName }) => {
  const errors: string[] = [], external: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await context.route('**/*', route => {
    if (!new URL(route.request().url()).hostname.match(/^(127\.0\.0\.1|localhost)$/)) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Book Conversion Desk', exact: true })).toBeVisible();
  await page.getByText('Import or paste a new book', { exact: true }).click();
  await page.getByLabel('New book title').fill('CPU book');
  await page.getByLabel('Source text (review extraction before rendering)').fill('Chapter 1\nHello, world. This audiobook is rendered locally.');
  await page.getByRole('button', { name: 'Create book', exact: true }).click();
  await expect(page.getByText('Book created.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Render / resume book', exact: true }).click();
  await expect(page.getByText('Render complete.', { exact: false })).toBeVisible({ timeout: 90000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Part WAV', exact: true }).click()]);
  const path = await download.path(); const wav = await readFile(path!);
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF'); expect(wav.readUInt32LE(24)).toBe(22050);
  expect(wav.byteLength).toBeGreaterThan(10000); expect(wav.some((x, i) => i > 44 && x !== 0)).toBeTruthy();
  await page.getByRole('button', { name: 'Preview part', exact: true }).click();
  const audio = page.getByLabel('Rendered chapter preview'); await expect(audio).toBeVisible();
  await audio.evaluate(async (a: HTMLAudioElement) => { a.load(); await new Promise<void>((resolve, reject) => { a.onloadedmetadata = () => resolve(); a.onerror = () => reject(new Error('WAV playback failed')); }); });
  expect(await audio.evaluate((a: HTMLAudioElement) => a.duration)).toBeGreaterThan(0);
  await page.reload(); await page.getByLabel('Saved books', { exact: true }).selectOption({ label: 'CPU book' });
  await page.getByRole('button', { name: 'Render / resume book', exact: true }).click();
  await expect(page.getByText(/1\/1 chunks · 1 reused/)).toBeVisible();
  // Force the cross-browser Blob download path; File System Access needs a human picker.
  await page.evaluate(() => Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }));
  const [zip] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export book ZIP', exact: true }).click()]);
  const entries = unzipSync(new Uint8Array(await readFile((await zip.path())!)));
  expect(Object.keys(entries)).toEqual(expect.arrayContaining(['project.json', 'chapters.json', 'playlist.m3u8']));
  expect(Object.keys(entries).some(n => n.endsWith('.wav'))).toBeTruthy();
  expect(errors).toEqual([]); expect(external).toEqual([]);
  await page.screenshot({ path: `test-results/book-desk-${browserName}.png`, fullPage: true });
});

test('EPUB spine reads all 65 sections, arbitrary XML attributes, percent encoded relative paths', async ({ page }) => {
  const entries: Record<string, Uint8Array> = {
    'META-INF/container.xml': strToU8(`<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>`),
  };
  const manifest: string[] = [], refs: string[] = [];
  for (let i = 0; i < 65; i++) {
    manifest.push(`<item href='text/Chapter%20${i}.xhtml' media-type='application/xhtml+xml' id='c${i}'/>`); refs.unshift(`<itemref idref='c${i}'/>`);
    entries[`OPS/text/Chapter ${i}.xhtml`] = strToU8(`<html><body><h1>Chapter ${i}</h1><p>Unique content ${i}.</p></body></html>`);
  }
  entries['OPS/book.opf'] = strToU8(`<package xmlns="http://www.idpf.org/2007/opf"><manifest>${manifest.join('')}</manifest><spine>${refs.join('')}</spine></package>`);
  await page.goto('/');
  await page.getByLabel('Import book files').setInputFiles({ name: 'spine.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(zipSync(entries)) });
  await expect(page.getByText(/1\/1 files imported/)).toBeVisible();
  await page.getByText('Import or paste a new book', { exact: true }).click();
  const text = await page.getByLabel('Source text (review extraction before rendering)').inputValue();
  expect(text).toContain('Unique content 0.'); expect(text).toContain('Unique content 64.');
  expect(text.indexOf('Unique content 64.')).toBeLessThan(text.indexOf('Unique content 0.'));
  expect((text.match(/Unique content/g) ?? []).length).toBe(65);
});

test('pause and stop retain completed chunks and do not report cancellation as failure', async ({ page }) => {
  await page.goto('/'); await page.getByText('Import or paste a new book', { exact: true }).click();
  await page.getByLabel('Source text (review extraction before rendering)').fill('Chapter 1\n' + 'This is a short line for testing rendering and cancellation. '.repeat(100));
  await page.getByRole('button', { name: 'Create book', exact: true }).click();
  await page.getByRole('button', { name: 'Render / resume book', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('Stopped. Completed chunks are saved;', { exact: false })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
});

test('PDF.js extracts page text in operator order', async ({ page }) => {
  const stream = 'BT /F1 18 Tf 50 720 Td (First sentence.) Tj 0 -30 Td [(Second) -100 (sentence.)] TJ 0 -30 Td (Third sentence.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n', offsets = [0];
  objects.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length; pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await page.goto('/'); await page.getByLabel('Import book files').setInputFiles({ name: 'ordered.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) });
  await expect(page.getByText(/1\/1 files imported/)).toBeVisible({ timeout: 60000 });
  await page.getByText('Import or paste a new book', { exact: true }).click();
  const text = await page.getByLabel('Source text (review extraction before rendering)').inputValue();
  expect(text.indexOf('First sentence.')).toBeLessThan(text.indexOf('Second'));
  expect(text.indexOf('Second')).toBeLessThan(text.indexOf('Third sentence.'));
});

test('local Tesseract reads image text with no cloud fallback', async ({ page, context }) => {
  const external: string[] = [];
  await context.route('**/*', route => {
    if (!new URL(route.request().url()).hostname.match(/^(127\.0\.0\.1|localhost)$/)) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  await page.goto('/');
  const image = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 800; c.height = 240;
    const ctx = c.getContext('2d')!; ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 800, 240);
    ctx.fillStyle = 'black'; ctx.font = '48px sans-serif'; ctx.fillText('LOCAL AUDIOBOOK', 35, 100); ctx.fillText('Reading works offline.', 35, 175);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.getByLabel('Use local English OCR for images and scanned PDFs (slower)').check();
  await page.getByLabel('Import book files').setInputFiles({ name: 'scan.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
  await expect(page.getByText(/1\/1 files imported/)).toBeVisible({ timeout: 90000 });
  await page.getByText('Import or paste a new book', { exact: true }).click();
  expect(await page.getByLabel('Source text (review extraction before rendering)').inputValue()).toMatch(/LOCAL AUDIOBOOK/);
  expect(external).toEqual([]);
});
