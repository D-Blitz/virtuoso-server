import type { InvoicePdfTheme } from './invoicePdfTheme';

/**
 * Phase E — invoice PDF template (pure HTML builder).
 *
 * `renderInvoiceHtml` is a side-effect-free function: view-model in, a full
 * standalone HTML document out (inline CSS, no external assets except the
 * issuer logo URL). The orchestrator (invoicePdf.service.ts) does all the
 * data loading, money/date formatting and theme resolution, then hands this
 * a fully-prepared, already-localized `InvoicePdfView`. Keeping formatting
 * out of here means the template only escapes + lays out strings.
 *
 * The theme drives colors/fonts via CSS custom properties on :root, so the
 * stylesheet itself stays readable and a new theme knob is a one-line wire-up.
 */

export type InvoicePdfView = {
  theme: InvoicePdfTheme;
  issuer: {
    legalName: string;
    legalForm: string | null;
    logoUrl: string | null;
    addressLines: string[];
    contactLines: string[];
    fiscalLines: string[];
  };
  billTo: {
    heading: string;
    name: string;
    addressLines: string[];
    contactLines: string[];
  };
  meta: {
    title: string;
    number: string;
    statusLabel: string;
    isDraft: boolean;
    issueDateLabel: string;
    dueDateLabel: string | null;
  };
  contextNote: string | null;
  showOwnerColumn: boolean;
  lines: Array<{
    description: string;
    owner: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    vatRate: string;
  }>;
  vatBreakdown: Array<{ rateLabel: string; base: string; vat: string }>;
  totals: {
    subtotal: string;
    vat: string;
    total: string;
    showPayments: boolean;
    paid: string;
    balance: string;
  };
  vatExemptMention: string | null;
  bank: { iban: string | null; bic: string | null } | null;
  legalMentions: string | null;
  notes: string | null;
  footerNote: string | null;
};

/** Escape text for safe interpolation into HTML element content/attributes. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape then turn newlines into <br> for multi-line free text. */
function escMultiline(s: string): string {
  return esc(s).replace(/\r?\n/g, '<br />');
}

/** Render a stack of already-plain lines as escaped <div>s. */
function lineStack(lines: string[], className: string): string {
  return lines
    .filter((l) => l && l.trim().length > 0)
    .map((l) => `<div class="${className}">${esc(l)}</div>`)
    .join('');
}

export function renderInvoiceHtml(vm: InvoicePdfView): string {
  const t = vm.theme;

  const logoBlock = vm.issuer.logoUrl
    ? `<img class="logo" src="${esc(vm.issuer.logoUrl)}" alt="${esc(vm.issuer.legalName)}" />`
    : '';

  const headerNoteBlock = t.headerNote
    ? `<div class="header-note">${esc(t.headerNote)}</div>`
    : '';

  const issuerFiscal = vm.issuer.fiscalLines.length
    ? `<div class="issuer-fiscal">${lineStack(vm.issuer.fiscalLines, 'fiscal-line')}</div>`
    : '';

  const dueRow = vm.meta.dueDateLabel
    ? `<tr><td class="meta-key">Échéance</td><td class="meta-val">${esc(vm.meta.dueDateLabel)}</td></tr>`
    : '';

  const statusRow = vm.meta.isDraft
    ? `<tr><td class="meta-key">Statut</td><td class="meta-val"><span class="status-pill">${esc(vm.meta.statusLabel)}</span></td></tr>`
    : '';

  const contextBlock = vm.contextNote
    ? `<div class="context-note">${esc(vm.contextNote)}</div>`
    : '';

  const ownerHead = vm.showOwnerColumn ? '<th class="col-owner">Pour</th>' : '';

  const lineRows = vm.lines
    .map(
      (l) => `
      <tr>
        <td class="col-desc">${escMultiline(l.description)}</td>
        ${vm.showOwnerColumn ? `<td class="col-owner">${esc(l.owner)}</td>` : ''}
        <td class="num col-qty">${esc(l.quantity)}</td>
        <td class="num col-unit">${esc(l.unitPrice)}</td>
        <td class="num col-amount">${esc(l.amount)}</td>
        <td class="num col-vat">${esc(l.vatRate)}</td>
      </tr>`,
    )
    .join('');

  const vatBreakdownRows = vm.vatBreakdown
    .map(
      (b) => `
      <tr>
        <td class="bd-label">TVA ${esc(b.rateLabel)}</td>
        <td class="num">${esc(b.base)}</td>
        <td class="num">${esc(b.vat)}</td>
      </tr>`,
    )
    .join('');

  const vatBreakdownBlock =
    vm.vatBreakdown.length > 0
      ? `
      <table class="breakdown">
        <thead>
          <tr>
            <th class="bd-label">Base par taux</th>
            <th class="num">HT</th>
            <th class="num">TVA</th>
          </tr>
        </thead>
        <tbody>${vatBreakdownRows}</tbody>
      </table>`
      : '';

  const paymentRows = vm.totals.showPayments
    ? `
      <tr class="totals-paid">
        <td class="tk">Déjà réglé</td>
        <td class="num tv">${esc(vm.totals.paid)}</td>
      </tr>
      <tr class="totals-balance">
        <td class="tk">Solde dû</td>
        <td class="num tv">${esc(vm.totals.balance)}</td>
      </tr>`
    : '';

  const vatExemptBlock = vm.vatExemptMention
    ? `<div class="vat-exempt">${esc(vm.vatExemptMention)}</div>`
    : '';

  const notesBlock = vm.notes
    ? `<div class="block"><div class="block-title">Notes</div><div class="block-body">${escMultiline(
        vm.notes,
      )}</div></div>`
    : '';

  const bankBlock =
    vm.bank && (vm.bank.iban || vm.bank.bic)
      ? `<div class="block"><div class="block-title">Règlement par virement</div><div class="block-body">${[
          vm.bank.iban ? `IBAN : ${esc(vm.bank.iban)}` : '',
          vm.bank.bic ? `BIC : ${esc(vm.bank.bic)}` : '',
        ]
          .filter(Boolean)
          .join('<br />')}</div></div>`
      : '';

  const legalBlock = vm.legalMentions
    ? `<div class="legal">${escMultiline(vm.legalMentions)}</div>`
    : '';

  const footerBlock = vm.footerNote
    ? `<div class="footer-note">${esc(vm.footerNote)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>${esc(vm.meta.title)} ${esc(vm.meta.number)}</title>
<style>
  :root {
    --accent: ${t.accentColor};
    --accent-text: ${t.accentTextColor};
    --text: ${t.textColor};
    --muted: ${t.mutedColor};
    --border: ${t.borderColor};
    --bg: ${t.pageBackground};
    --font: ${t.fontFamily};
    --fs: ${t.fontSizePt}pt;
    --logo-max-h: ${t.logoMaxHeightPx}px;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: var(--fs);
    line-height: 1.45;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }

  .top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 24px;
    margin-bottom: 28px;
  }
  .issuer { max-width: 58%; }
  .logo { max-height: var(--logo-max-h); max-width: 260px; margin-bottom: 10px; display: block; }
  .issuer-name { font-size: 1.25em; font-weight: 700; color: var(--text); }
  .issuer-form { color: var(--muted); margin-bottom: 6px; }
  .header-note { color: var(--muted); font-style: italic; margin-bottom: 6px; }
  .addr-line { color: var(--text); }
  .contact-line { color: var(--muted); }
  .issuer-fiscal { margin-top: 8px; }
  .fiscal-line { color: var(--muted); font-size: 0.9em; }

  .meta { min-width: 38%; }
  .invoice-title {
    font-size: 1.7em;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    text-align: right;
    margin-bottom: 8px;
  }
  .meta-table { width: 100%; border-collapse: collapse; }
  .meta-table td { padding: 3px 0; vertical-align: top; }
  .meta-key { color: var(--muted); padding-right: 12px; white-space: nowrap; }
  .meta-val { text-align: right; font-weight: 600; }
  .meta-number { color: var(--accent); }
  .status-pill {
    display: inline-block;
    padding: 1px 8px;
    border: 1px solid var(--accent);
    border-radius: 999px;
    color: var(--accent);
    font-size: 0.85em;
    font-weight: 600;
  }

  .billto {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 14px;
    margin-bottom: 18px;
    max-width: 320px;
  }
  .billto-heading {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.8em;
    color: var(--muted);
    margin-bottom: 4px;
  }
  .billto-name { font-weight: 700; }

  .context-note {
    color: var(--muted);
    font-style: italic;
    margin-bottom: 16px;
  }

  table.lines {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 18px;
  }
  table.lines thead th {
    background: var(--accent);
    color: var(--accent-text);
    font-weight: 600;
    text-align: left;
    padding: 8px 10px;
    font-size: 0.92em;
  }
  table.lines thead th.num { text-align: right; }
  table.lines tbody td {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  table.lines tbody tr:nth-child(even) td { background: rgba(0, 0, 0, 0.018); }
  .col-qty { width: 7%; }
  .col-unit { width: 14%; }
  .col-amount { width: 16%; }
  .col-vat { width: 9%; }
  .col-owner { width: 16%; }

  .summary {
    display: flex;
    justify-content: space-between;
    gap: 24px;
    align-items: flex-start;
  }
  .summary-left { flex: 1; max-width: 55%; }
  .summary-right { width: 300px; }

  table.breakdown { width: 100%; border-collapse: collapse; }
  table.breakdown th, table.breakdown td {
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    font-size: 0.9em;
  }
  table.breakdown th { color: var(--muted); font-weight: 600; text-align: left; }
  table.breakdown th.num { text-align: right; }
  .bd-label { text-align: left; }

  table.totals { width: 100%; border-collapse: collapse; }
  table.totals td { padding: 5px 10px; }
  table.totals .tk { color: var(--muted); }
  table.totals .tv { font-weight: 600; }
  table.totals .totals-total td {
    border-top: 2px solid var(--accent);
    font-size: 1.15em;
    font-weight: 700;
    color: var(--accent);
    padding-top: 8px;
  }
  table.totals .totals-balance td {
    border-top: 1px solid var(--border);
    font-weight: 700;
  }

  .vat-exempt {
    margin-top: 14px;
    padding: 8px 10px;
    border-left: 3px solid var(--accent);
    background: rgba(0, 0, 0, 0.02);
    color: var(--text);
    font-size: 0.92em;
  }

  .blocks { margin-top: 22px; display: flex; flex-direction: column; gap: 12px; }
  .block-title {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.78em;
    color: var(--muted);
    margin-bottom: 2px;
  }
  .block-body { color: var(--text); }

  .legal {
    margin-top: 22px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 0.82em;
  }
  .footer-note {
    margin-top: 14px;
    text-align: center;
    color: var(--muted);
    font-size: 0.82em;
  }
</style>
</head>
<body>
  <div class="top">
    <div class="issuer">
      ${logoBlock}
      <div class="issuer-name">${esc(vm.issuer.legalName)}</div>
      ${vm.issuer.legalForm ? `<div class="issuer-form">${esc(vm.issuer.legalForm)}</div>` : ''}
      ${headerNoteBlock}
      ${lineStack(vm.issuer.addressLines, 'addr-line')}
      ${lineStack(vm.issuer.contactLines, 'contact-line')}
      ${issuerFiscal}
    </div>
    <div class="meta">
      <div class="invoice-title">${esc(vm.meta.title)}</div>
      <table class="meta-table">
        <tr><td class="meta-key">Numéro</td><td class="meta-val meta-number">${esc(
          vm.meta.number,
        )}</td></tr>
        <tr><td class="meta-key">Date</td><td class="meta-val">${esc(
          vm.meta.issueDateLabel,
        )}</td></tr>
        ${dueRow}
        ${statusRow}
      </table>
    </div>
  </div>

  <div class="billto">
    <div class="billto-heading">${esc(vm.billTo.heading)}</div>
    <div class="billto-name">${esc(vm.billTo.name)}</div>
    ${lineStack(vm.billTo.addressLines, 'addr-line')}
    ${lineStack(vm.billTo.contactLines, 'contact-line')}
  </div>

  ${contextBlock}

  <table class="lines">
    <thead>
      <tr>
        <th class="col-desc">Désignation</th>
        ${ownerHead}
        <th class="num col-qty">Qté</th>
        <th class="num col-unit">P.U. HT</th>
        <th class="num col-amount">Montant HT</th>
        <th class="num col-vat">TVA</th>
      </tr>
    </thead>
    <tbody>${lineRows}</tbody>
  </table>

  <div class="summary">
    <div class="summary-left">
      ${vatBreakdownBlock}
    </div>
    <div class="summary-right">
      <table class="totals">
        <tr>
          <td class="tk">Sous-total HT</td>
          <td class="num tv">${esc(vm.totals.subtotal)}</td>
        </tr>
        <tr>
          <td class="tk">TVA</td>
          <td class="num tv">${esc(vm.totals.vat)}</td>
        </tr>
        <tr class="totals-total">
          <td>Total TTC</td>
          <td class="num">${esc(vm.totals.total)}</td>
        </tr>
        ${paymentRows}
      </table>
    </div>
  </div>

  ${vatExemptBlock}

  <div class="blocks">
    ${notesBlock}
    ${bankBlock}
  </div>

  ${legalBlock}
  ${footerBlock}
</body>
</html>`;
}
