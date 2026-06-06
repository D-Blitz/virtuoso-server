import prisma from '../../prisma';

/**
 * The transaction-client type our EXTENDED Prisma client hands the
 * `$transaction(async (tx) => …)` callback. Derived (rather than using the
 * vanilla `Prisma.TransactionClient`) so it stays in lockstep with the
 * tenant-scope extension's widened surface — see prisma.ts.
 */
type ExtendedTransactionClient = Parameters<
  Parameters<typeof prisma.$transaction>[0]
>[0];

/**
 * Next per-(issuer, year) sequential invoice number, gap-free within the
 * issuer's own namespace.
 *
 *   - "<prefix>-2026-0001" when the issuer sets an invoicePrefix,
 *   - "2026-0001" otherwise.
 *
 * MUST run inside a transaction (read-then-write): the unique index
 * (organizationId, issuerId, number) is the backstop against the
 * vanishingly rare concurrent-create race. Phase C made the counter
 * per-issuer so the school and each freelance teacher keep distinct,
 * gap-free sequences; Phase D reuses it for the teacher's split invoices.
 */
export async function nextInvoiceNumber(
  tx: ExtendedTransactionClient,
  params: {
    organizationId: string;
    issuerId: string | null;
    invoicePrefix: string | null;
  },
): Promise<string> {
  const year = new Date().getFullYear();
  const rawPrefix = params.invoicePrefix?.trim();
  const numberPrefix = rawPrefix ? `${rawPrefix}-${year}-` : `${year}-`;
  const latest = await tx.invoice.findFirst({
    where: {
      organizationId: params.organizationId,
      issuerId: params.issuerId,
      number: { startsWith: numberPrefix },
    },
    orderBy: { number: 'desc' },
    select: { number: true },
  });
  const lastSeq = latest
    ? Number.parseInt(latest.number.slice(numberPrefix.length), 10)
    : 0;
  const seq = (Number.isFinite(lastSeq) ? lastSeq : 0) + 1;
  return `${numberPrefix}${String(seq).padStart(4, '0')}`;
}
