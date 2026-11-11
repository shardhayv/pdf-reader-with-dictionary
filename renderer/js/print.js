/**
 * print.js — printing a virtualized document.
 *
 * The reader keeps only a handful of pages in the DOM, at whatever zoom is
 * on screen, so printing the live DOM produced a few real pages followed by
 * hundreds of numbered placeholders, each split across sheets. Printing
 * therefore gets its own surface: every page is rendered once at print
 * resolution into #print-root, the print stylesheet shows that and hides the
 * application, and the surface is discarded afterwards.
 *
 * Rendering a long book takes a while, so it runs behind a progress dialog
 * that can be cancelled, and each page is released to a compressed image as
 * soon as it is painted so memory stays flat.
 */

import { $, openModal, closeModal, announce, nextFrame, toast } from './dom.js';
import * as viewer from './viewer.js';

const PRINT_DPI = 150;          // sharp text on paper without 30 MB bitmaps
const PRINT_MAX_PIXELS = 12e6;  // per page; large-format sheets are scaled down
const SAME_SIZE_TOLERANCE_PT = 1.5;

/** The print run in progress, if any: { cancelled } */
let job = null;
let urls = [];
let pageSheet = null;

export function isPreparing() {
  return !!job;
}

/** Abandon a preparation in progress (Cancel button, Escape, new document). */
export function cancelPrint() {
  if (job) job.cancelled = true;
}

/** Drop the print surface and free every page image. */
export function clearPrint() {
  $('print-root')?.replaceChildren();
  for (const url of urls) URL.revokeObjectURL(url);
  urls = [];
  if (pageSheet) {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== pageSheet);
    pageSheet = null;
  }
}

/**
 * Tell the print engine the document's own page size. Without it a landscape
 * slide deck prints as small landscape images on portrait paper. Only done
 * when every page shares one size; a mixed document falls back to the
 * printer's paper and each page is fitted to it.
 */
function applyPageSize(sizes) {
  const first = sizes[0];
  const uniform = first && sizes.every(size =>
    Math.abs(size.width - first.width) <= SAME_SIZE_TOLERANCE_PT &&
    Math.abs(size.height - first.height) <= SAME_SIZE_TOLERANCE_PT);
  const rule = uniform
    ? `@page { size: ${first.width.toFixed(2)}pt ${first.height.toFixed(2)}pt; margin: 0; }`
    : '@page { margin: 0; }';
  // A constructed stylesheet is CSSOM, not inline style, so the page's
  // style-src 'self' policy is left exactly as strict as it was.
  pageSheet = new CSSStyleSheet();
  pageSheet.replaceSync(rule);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageSheet];
}

/**
 * Build the print surface for the open document.
 * @param {{onProgress?: (done: number, total: number) => void}} [options]
 * @returns {Promise<{pages: number, failed: number} | null>} null if cancelled
 *          or the document changed underneath.
 */
export async function preparePrint({ onProgress = null } = {}) {
  if (!viewer.hasDocument() || job) return null;
  clearPrint();

  const run = { cancelled: false };
  job = run;
  const generation = viewer.documentGeneration();
  const total = viewer.pageCount();
  const root = $('print-root');
  const sizes = [];
  let failed = 0;

  try {
    for (let n = 1; n <= total; n++) {
      if (run.cancelled || generation !== viewer.documentGeneration()) return null;

      const image = await viewer.renderPageImage(n, { dpi: PRINT_DPI, maxPixels: PRINT_MAX_PIXELS });
      if (run.cancelled || generation !== viewer.documentGeneration()) {
        if (image) URL.revokeObjectURL(image.url);
        return null;
      }

      const sheet = document.createElement('div');
      sheet.className = 'print-page';
      if (image) {
        urls.push(image.url);
        sizes.push({ width: image.widthPt, height: image.heightPt });
        const img = new Image();
        img.alt = `Page ${n}`;
        img.src = image.url;
        sheet.appendChild(img);
        root.appendChild(sheet);
        // The print engine snapshots the DOM; an undecoded image prints blank.
        await img.decode().catch(() => {});
      } else {
        // Never drop a page silently: a missing sheet would renumber the rest.
        failed++;
        sheet.classList.add('print-page--failed');
        sheet.textContent = `Page ${n} could not be rendered.`;
        root.appendChild(sheet);
      }
      onProgress?.(n, total);
    }
    if (run.cancelled || generation !== viewer.documentGeneration()) return null;
    applyPageSize(sizes);
    return { pages: total, failed };
  } finally {
    if (job === run) job = null;
    if (run.cancelled || generation !== viewer.documentGeneration()) clearPrint();
  }
}

/** Print the open document through the system print dialog. */
export async function printDocument() {
  if (!viewer.hasDocument()) {
    toast('Open a PDF first to print it.');
    return;
  }
  if (job) return;

  const overlay = $('print-overlay');
  const status = $('print-status');
  const bar = $('print-progress');
  const fill = $('print-progress-fill');
  const total = viewer.pageCount();

  const progress = (done) => {
    const percent = Math.round((done / total) * 100);
    status.textContent = `Rendering page ${Math.min(done + 1, total)} of ${total}…`;
    bar.setAttribute('aria-valuenow', String(percent));
    fill.style.transform = `scaleX(${done / total})`;
  };
  progress(0);
  openModal(overlay, { focus: $('print-cancel') });
  announce(`Preparing ${total} ${total === 1 ? 'page' : 'pages'} for printing`);

  let result = null;
  try {
    result = await preparePrint({ onProgress: progress });
  } catch (error) {
    console.error('Gloss could not prepare the document for printing:', error);
    clearPrint();
    closeModal(overlay);
    toast('This document could not be prepared for printing.', { long: true });
    return;
  }
  closeModal(overlay);
  if (!result) return; // cancelled, or a different document was opened

  if (result.failed > 0) {
    toast(`${result.failed} ${result.failed === 1 ? 'page' : 'pages'} could not be rendered and will print as a note.`,
      { long: true });
  }

  // Let the progress dialog leave the screen before the system dialog, which
  // blocks this window until it is dismissed, takes over.
  await nextFrame();
  await nextFrame();
  // window.print() blocks until the dialog closes and fires afterprint on the
  // way out. Releasing the surface on that event — never on a timer — means a
  // reader who takes their time choosing a printer cannot print blank sheets.
  // Should the event ever be lost, the next print or document change frees it.
  window.addEventListener('afterprint', clearPrint, { once: true });
  window.print();
}

export function init() {
  $('print-cancel').addEventListener('click', cancelPrint);
  viewer.on('documentclosed', () => {
    cancelPrint();
    clearPrint();
  });
}
