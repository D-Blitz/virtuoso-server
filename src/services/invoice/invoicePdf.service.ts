import prisma from '../../prisma';
import { getOrganizationId } from '../../auth/context';
import { invoiceService } from './invoice.service';
import { resolvePdfTheme } from './invoicePdfTheme';
import { renderInvoiceHtml, type InvoicePdfView } from './invoicePdfTemplate';
import { renderHtmlToPdf } from './invoicePdfRenderer';

/**
 * Phase E — invoice → themeable PDF orchestrator.
 *
 * The invoice read DTO (invoiceService.get) carries only a SLIM issuer and
 * client (id/name, no address/fiscal/bank/theme). To render a legally-shaped
 * invoice we re-load the data that actually prints:
 *
 *   - the FULL issuer BillingIdentity  → header identity, address, SIRET/TVA,
 *     IBAN/BIC, logo, legal mentions, VAT-exempt posture and the per-issuer
 *     `pdfTheme` (colors/font/layout). Falls back to the Organization name
 *     for legacy invoices with no issuer.
 *   - the FULL client                  → the "facturé à" address/contact.
 *   - the SCHOOL identity              → used as the bill-to when the invoice
 *     is addressed to the school (a teacher's BILLS_SCHOOL split invoice).
 *
 * All money/date/rate formatting and theme resolution happen here, then the
 * pure template (invoicePdfTemplate) lays out the already-localized strings
 * and the Puppeteer renderer turns that HTML into a PDF buffer.
 */

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Brouillon',
  SENT: 'Envoyée',
  PARTIALLY_PAID: 'Partiellement réglée',
  PAID: 'Réglée',
  VOID: 'Annulée',
};

const DEFAULT_VAT_EXEMPT_MENTION = 'TVA non applicable, art. 293 B du CGI';

function httpError(message: string, statusCode = 400): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/** Build the issuer/school postal address as discrete printable lines. */
function addressLines(row: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
}): string[] {
  const cityLine = [row.postalCode, row.city].filter(Boolean).join(' ').trim();
  return [row.addressLine1, row.addressLine2, cityLine, row.country]
    .map((s) => (s ?? '').trim())
    .filter((s) => s.length > 0);
}

export type InvoicePdfResult = {
  buffer: Buffer;
  filename: string;
};

export class InvoicePdfService {
  private requireOrg(): string {
    const organizationId = getOrganizationId();
    if (!organizationId) throw httpError('Contexte organisation manquant.', 401);
    return organizationId;
  }

  async generate(invoiceId: string): Promise<InvoicePdfResult> {
    const organizationId = this.requireOrg();

    // Org-scoped read (throws 404 if the invoice isn't in this org).
    const invoice = await invoiceService.get(invoiceId);

    const locale = 'fr-FR';
    const currency = invoice.currency || 'EUR';

    const money = (cents: number): string =>
      new Intl.NumberFormat(locale, { style: 'currency', currency }).format(
        (cents ?? 0) / 100,
      );
    const fmtDate = (d: string | Date | null | undefined): string => {
      if (!d) return '';
      const date = d instanceof Date ? d : new Date(d);
      if (Number.isNaN(date.getTime())) return '';
      return new Intl.DateTimeFormat(locale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(date);
    };
    const fmtRate = (r: number): string =>
      `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(r ?? 0)} %`;

    // Full issuer identity (the slim DTO issuer lacks address/fiscal/theme).
    const issuerRow = invoice.issuerId
      ? await prisma.billingIdentity.findFirst({ where: { id: invoice.issuerId } })
      : null;

    // Org — fallback issuer name for legacy invoices, and a bill-to fallback.
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    });

    const theme = resolvePdfTheme(issuerRow?.pdfTheme ?? null);

    const issuer: InvoicePdfView['issuer'] = {
      legalName: issuerRow?.legalName ?? org?.name ?? 'Facture',
      legalForm: issuerRow?.legalForm ?? null,
      logoUrl: issuerRow?.logoUrl ?? null,
      addressLines: issuerRow ? addressLines(issuerRow) : [],
      contactLines: issuerRow
        ? [
            issuerRow.phone ? `Tél. ${issuerRow.phone}` : '',
            issuerRow.email ?? '',
          ].filter((s) => s.length > 0)
        : [],
      fiscalLines: issuerRow
        ? [
            issuerRow.siret ? `SIRET : ${issuerRow.siret}` : '',
            issuerRow.vatNumber ? `TVA : ${issuerRow.vatNumber}` : '',
            issuerRow.rcs ? `RCS : ${issuerRow.rcs}` : '',
          ].filter((s) => s.length > 0)
        : [],
    };

    // Bill-to: the school (for a teacher's BILLS_SCHOOL invoice) or the client.
    let billTo: InvoicePdfView['billTo'];
    if (invoice.billToType === 'SCHOOL') {
      const school = await prisma.billingIdentity.findFirst({
        where: { ownerType: 'SCHOOL' },
      });
      billTo = {
        heading: 'Adressée à',
        name: school?.legalName ?? org?.name ?? 'Organisation',
        addressLines: school ? addressLines(school) : [],
        contactLines: school
          ? [school.phone ? `Tél. ${school.phone}` : '', school.email ?? ''].filter(
              (s) => s.length > 0,
            )
          : [],
      };
    } else {
      const client = await prisma.client.findFirst({
        where: { id: invoice.clientId },
        select: { firstname: true, lastname: true, email: true, phone: true, address: true },
      });
      const clientName = client
        ? `${client.firstname} ${client.lastname}`.trim()
        : `${invoice.client.firstname} ${invoice.client.lastname}`.trim();
      billTo = {
        heading: 'Facturé à',
        name: clientName || '—',
        addressLines: (client?.address ?? '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
        contactLines: [
          client?.phone ? `Tél. ${client.phone}` : '',
          client?.email ?? invoice.client.email ?? '',
        ].filter((s) => s.length > 0),
      };
    }

    // Split / addressed-to-school provenance note.
    const ctxParts: string[] = [];
    if (invoice.parentInvoice) {
      ctxParts.push(
        `issue de la répartition de la facture ${invoice.parentInvoice.number}`,
      );
    }
    if (invoice.billToType === 'SCHOOL') ctxParts.push("adressée à l’organisation");
    const contextNote = ctxParts.length ? `Facture ${ctxParts.join(', ')}.` : null;

    // The per-line owner ("Pour") is INTERNAL split bookkeeping — never expose
    // it on a client-facing invoice. Only show it on invoices addressed to the
    // organisation itself (internal recap).
    const showOwnerColumn =
      invoice.billToType === 'SCHOOL' &&
      invoice.lines.some((l: any) => !!l.facilitatorId);

    const lines: InvoicePdfView['lines'] = invoice.lines.map((l: any) => {
      const effectiveRate = l.vatRate ?? invoice.vatRate ?? 0;
      return {
        description: l.description ?? '',
        owner: l.facilitator
          ? `${l.facilitator.firstname} ${l.facilitator.lastname}`.trim()
          : 'Organisation',
        quantity: String(l.quantity ?? 1),
        unitPrice: money(l.unitPriceCents ?? 0),
        amount: money(l.amountCents ?? 0),
        vatRate: fmtRate(effectiveRate),
      };
    });

    // VAT breakdown grouped by effective per-line rate.
    const byRate = new Map<number, { baseCents: number; vatCents: number }>();
    for (const l of invoice.lines as any[]) {
      const rate = l.vatRate ?? invoice.vatRate ?? 0;
      const cur = byRate.get(rate) ?? { baseCents: 0, vatCents: 0 };
      cur.baseCents += l.amountCents ?? 0;
      cur.vatCents += l.vatCents ?? 0;
      byRate.set(rate, cur);
    }
    const vatBreakdown: InvoicePdfView['vatBreakdown'] = [...byRate.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([rate, v]) => ({
        rateLabel: fmtRate(rate),
        base: money(v.baseCents),
        vat: money(v.vatCents),
      }));

    const view: InvoicePdfView = {
      theme,
      issuer,
      billTo,
      meta: {
        title: 'Facture',
        number: invoice.number,
        statusLabel: STATUS_LABELS[invoice.status] ?? invoice.status,
        isDraft: invoice.status === 'DRAFT' || invoice.status === 'VOID',
        issueDateLabel: fmtDate(invoice.issueDate ?? invoice.createdAt),
        dueDateLabel: invoice.dueDate ? fmtDate(invoice.dueDate) : null,
      },
      contextNote,
      showOwnerColumn,
      lines,
      vatBreakdown,
      totals: {
        subtotal: money(invoice.subtotalCents),
        vat: money(invoice.vatCents),
        total: money(invoice.totalCents),
        showPayments: (invoice.paidCents ?? 0) > 0,
        paid: money(invoice.paidCents ?? 0),
        balance: money(invoice.balanceCents ?? invoice.totalCents),
      },
      vatExemptMention: issuerRow?.vatExempt
        ? issuerRow.vatExemptMention ?? DEFAULT_VAT_EXEMPT_MENTION
        : null,
      bank:
        theme.showBankDetails && issuerRow && (issuerRow.iban || issuerRow.bic)
          ? { iban: issuerRow.iban ?? null, bic: issuerRow.bic ?? null }
          : null,
      legalMentions:
        theme.showLegalMentions && issuerRow?.legalMentions
          ? issuerRow.legalMentions
          : null,
      notes: invoice.notes ?? null,
      footerNote: theme.footerNote,
    };

    const html = renderInvoiceHtml(view);
    const buffer = await renderHtmlToPdf(html);

    const safeNumber = String(invoice.number).replace(/[^a-zA-Z0-9._-]+/g, '-');
    return { buffer, filename: `Facture-${safeNumber}.pdf` };
  }
}

export const invoicePdfService = new InvoicePdfService();
