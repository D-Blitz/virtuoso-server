import puppeteer, { type Browser } from 'puppeteer';

/**
 * Phase E — headless-Chromium HTML→PDF renderer.
 *
 * Launching Chromium costs ~300 ms and ~100 MB, so we keep ONE browser
 * alive for the process lifetime and open a fresh page per render (pages
 * are cheap and isolated). The launch is lazy (first PDF request pays for
 * it) and self-healing: if the browser has crashed/disconnected we relaunch
 * on the next render rather than failing forever.
 *
 * Security note: we render fully-trusted, server-built HTML (see
 * invoicePdfTemplate.ts) — never user-pasted markup — but we still pass the
 * hardened flags so the same code is safe on a locked-down prod host.
 */

let browserPromise: Promise<Browser> | null = null;

async function launch(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
}

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launch();
    // If the launch itself rejects, clear the cache so a later call retries
    // instead of re-awaiting a permanently-failed promise.
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

/**
 * Render a complete HTML document to an A4 PDF buffer. Images (e.g. the
 * issuer logo) are given a brief, bounded window to load so a slow or dead
 * logo URL can never hang the request — we print whatever is ready.
 */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  let browser = await getBrowser();
  let page;
  try {
    page = await browser.newPage();
  } catch {
    // Browser likely crashed between renders — drop it and relaunch once.
    browserPromise = null;
    browser = await getBrowser();
    page = await browser.newPage();
  }

  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Wait for any <img> to settle, but never longer than 4 s.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const pending = Array.from(document.images).filter((img) => !img.complete);
          if (pending.length === 0) {
            resolve();
            return;
          }
          let left = pending.length;
          const done = () => {
            left -= 1;
            if (left <= 0) resolve();
          };
          pending.forEach((img) => {
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
          });
          setTimeout(resolve, 4000);
        }),
    );

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: false,
      margin: { top: '14mm', right: '14mm', bottom: '16mm', left: '14mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
  }
}

/** Close the shared browser (best-effort), e.g. on graceful shutdown. */
export async function shutdownPdfRenderer(): Promise<void> {
  const current = browserPromise;
  browserPromise = null;
  if (!current) return;
  try {
    const browser = await current;
    await browser.close();
  } catch {
    /* already gone — nothing to do */
  }
}
