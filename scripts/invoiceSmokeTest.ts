/**
 * Invoicing + multi-tender + cheque-lifecycle smoke test (Phase 1.9).
 *
 * DB-backed regression guard for InvoiceService + PaymentService. Drives
 * the services DIRECTLY inside a faked request context (no HTTP / no
 * auth) against the real database, seeding a throwaway client and
 * purging everything tied to it afterwards.
 *
 * Locks the invariants that make the transactional loop correct:
 *
 *   - line math: subtotal = Σ(qty × unit); VAT is snapshotted from the
 *     org rate; total = subtotal + VAT.
 *   - per-(org, year) sequential invoice numbers ("2026-0001", +1, …).
 *   - balance is DERIVED: paid = Σ(settled payments), balance = total −
 *     paid; status (DRAFT/SENT/PARTIALLY_PAID/PAID/VOID) is recomputed.
 *   - THE cheque rule: a cheque is NOT income until CASHED. Recording a
 *     cheque leaves the invoice balance untouched; only cashing it moves
 *     the money. Cash / transfer settle immediately.
 *   - cheque lifecycle PENDING_DEPOSIT → DEPOSITED → CASHED is forward-
 *     only and irreversible once cashed.
 *   - guards: can't void / record against a settled or void invoice;
 *     can't edit lines once money has landed.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/invoiceSmokeTest.ts [organizationId]
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

import { requestContext, type RequestContext } from '../src/auth/context';
import { InvoiceService } from '../src/services/invoice/invoice.service';
import { PaymentService } from '../src/services/payment.service';
import { issueBillingService } from '../src/services/invoice/issueBilling.service';
import { invoiceSplitService } from '../src/services/invoice/invoiceSplit.service';
import enginePrisma from '../src/prisma';

const raw = new PrismaClient();
const invoiceService = new InvoiceService();
const paymentService = new PaymentService();

const TEST_CLIENT_EMAIL = 'smoke-invoice@test.io';
// Deterministic emails so a crashed run's seeded teachers are reclaimable.
const TEST_FAC_EMAILS = [
  'smoke-fac-a@test.io',
  'smoke-fac-b@test.io',
  'smoke-fac-c@test.io',
];

let assertionCount = 0;
let failureCount = 0;

function assert(cond: unknown, label: string): void {
  assertionCount += 1;
  if (!cond) {
    failureCount += 1;
    console.error(`  ❌  ${label}`);
  } else {
    console.log(`  ✅  ${label}`);
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  assertionCount += 1;
  if (actual === expected) {
    console.log(`  ✅  ${label}`);
  } else {
    failureCount += 1;
    console.error(`  ❌  ${label}`);
    console.error(`      expected: ${JSON.stringify(expected)}`);
    console.error(`      actual:   ${JSON.stringify(actual)}`);
  }
}

async function expectThrow(fn: () => Promise<unknown>, label: string): Promise<void> {
  assertionCount += 1;
  try {
    await fn();
    failureCount += 1;
    console.error(`  ❌  ${label} (expected throw, none happened)`);
  } catch {
    console.log(`  ✅  ${label}`);
  }
}

async function purge(organizationId: string): Promise<void> {
  const client = await raw.client.findFirst({
    where: { organizationId, email: TEST_CLIENT_EMAIL },
    select: { id: true },
  });
  if (client) {
    // payments → invoices (lines + allocations cascade) → client. Payment
    // cascades its allocations; Invoice cascades its lines + allocations.
    // Payment.invoiceId has no cascade, so clear payments first.
    await raw.payment.deleteMany({ where: { clientId: client.id } });
    await raw.invoice.deleteMany({ where: { clientId: client.id } });
    await raw.client.delete({ where: { id: client.id } });
  }

  // Throwaway teachers seeded for the N-way split case. Their FACILITATOR
  // billing identities hold the FK to the teacher, so drop identities first.
  // Any invoice lines / allocations referencing them are already gone with
  // the client's invoices/payments above.
  const facs = await raw.facilitator.findMany({
    where: { organizationId, email: { in: TEST_FAC_EMAILS } },
    select: { id: true },
  });
  if (facs.length) {
    const facIds = facs.map((f) => f.id);
    await raw.billingIdentity.deleteMany({ where: { facilitatorId: { in: facIds } } });
    await raw.facilitator.deleteMany({ where: { id: { in: facIds } } });
  }
}

async function main() {
  const organizationId =
    process.argv[2] ??
    process.env.DEV_DEFAULT_ORG_ID ??
    (await raw.organization.findFirst({ select: { id: true } }))?.id;

  if (!organizationId) {
    console.error('No organization found — pass an id or set DEV_DEFAULT_ORG_ID.');
    process.exit(1);
  }
  const org = await raw.organization.findUnique({
    where: { id: organizationId },
    select: { name: true, vatRate: true },
  });
  if (!org) {
    console.error(`Organization ${organizationId} not found.`);
    process.exit(1);
  }
  const vatRate = org.vatRate ?? 0;
  console.log(`\nInvoicing smoke — org "${org.name}" (VAT ${vatRate}%)\n`);

  await purge(organizationId);

  // Fresh throwaway client for the run.
  const client = await raw.client.create({
    data: {
      organizationId,
      email: TEST_CLIENT_EMAIL,
      firstname: 'Smoke',
      lastname: 'Invoice',
      phone: '5550000000',
      birthdate: new Date('2010-01-01'),
      address: 'test',
    },
  });

  const ctx = {
    userId: 'smoke-user',
    organizationId,
    email: 'smoke@test.io',
    roleId: null,
    roleName: 'Smoke',
    permissions: new Set(),
  } as unknown as RequestContext;

  // If the org has no SCHOOL billing identity yet, the N-way case creates a
  // throwaway one — tracked here so the finally block removes only what we made.
  let createdSchoolIdentityId: string | null = null;

  try {
    await requestContext.run(ctx, async () => {
      const expectedVat = (subtotal: number) => Math.round(subtotal * (vatRate / 100));

      // ── 1. Create + line math + VAT snapshot + number format ──────
      console.log('1. Invoice creation: line math, VAT snapshot, numbering');
      const inv1 = await invoiceService.create({
        clientId: client.id,
        status: 'SENT',
        lines: [
          { description: 'Cours de piano', quantity: 1, unitPriceCents: 10000 },
          { description: 'Frais de dossier', quantity: 2, unitPriceCents: 500 },
        ],
      });
      const sub1 = 10000 + 2 * 500; // 11000
      assertEq(inv1.subtotalCents, sub1, 'subtotal = Σ(qty × unit)');
      assertEq(inv1.vatRate, vatRate, 'vatRate snapshotted from org');
      assertEq(inv1.vatCents, expectedVat(sub1), 'VAT = round(subtotal × rate)');
      assertEq(inv1.totalCents, sub1 + expectedVat(sub1), 'total = subtotal + VAT');
      assertEq(inv1.paidCents, 0, 'fresh invoice: paid = 0');
      assertEq(inv1.balanceCents, inv1.totalCents, 'fresh invoice: balance = total');
      assertEq(inv1.status, 'SENT', 'created with status SENT');
      const year = new Date().getFullYear();
      assert(
        new RegExp(`^${year}-\\d{4}$`).test(inv1.number),
        `number matches "${year}-NNNN" (got ${inv1.number})`,
      );

      // ── 2. Sequential numbering ───────────────────────────────────
      console.log('\n2. Sequential per-org numbering');
      const inv2 = await invoiceService.create({
        clientId: client.id,
        lines: [{ description: 'Solfège', quantity: 1, unitPriceCents: 4000 }],
      });
      const seq1 = Number.parseInt(inv1.number.split('-')[1], 10);
      const seq2 = Number.parseInt(inv2.number.split('-')[1], 10);
      assertEq(seq2, seq1 + 1, 'second invoice number = first + 1');
      assertEq(inv2.status, 'DRAFT', 'no explicit status → DRAFT');

      // ── 3. Cash settles immediately → PARTIALLY_PAID ──────────────
      console.log('\n3. Cash payment settles immediately');
      const cashCents = 5000;
      const cash = await paymentService.recordManual({
        clientId: client.id,
        invoiceId: inv1.id,
        amountCents: cashCents,
        method: 'CASH',
      });
      assertEq(cash.status, 'SUCCEEDED', 'cash payment → SUCCEEDED immediately');
      assertEq(cash.chequeStatus, null, 'cash payment has no chequeStatus');
      {
        const v = await invoiceService.get(inv1.id);
        assertEq(v.paidCents, cashCents, 'paid = cash amount');
        assertEq(v.balanceCents, inv1.totalCents - cashCents, 'balance = total − cash');
        assertEq(v.status, 'PARTIALLY_PAID', 'partial cash → PARTIALLY_PAID');
      }

      // ── 4. THE rule: cheque is NOT income until cashed ────────────
      console.log('\n4. Cheque recorded → pending, NOT counted as income');
      const chequeCents = inv1.totalCents - cashCents; // would clear the balance
      const cheque = await paymentService.recordManual({
        clientId: client.id,
        invoiceId: inv1.id,
        amountCents: chequeCents,
        method: 'CHECK',
        chequeNumber: '0001234',
        chequeBank: 'Crédit Mutuel',
        expectedDepositDate: new Date('2026-06-15T00:00:00Z'),
      });
      assertEq(cheque.status, 'PENDING', 'cheque payment → PENDING (not income yet)');
      assertEq(cheque.chequeStatus, 'PENDING_DEPOSIT', 'cheque starts PENDING_DEPOSIT');
      {
        const v = await invoiceService.get(inv1.id);
        assertEq(v.paidCents, cashCents, 'paid UNCHANGED — uncashed cheque excluded');
        assertEq(v.balanceCents, inv1.totalCents - cashCents, 'balance UNCHANGED');
        assertEq(v.status, 'PARTIALLY_PAID', 'still PARTIALLY_PAID despite full cheque');
      }

      // ── 5. Cheque appears in the tracker while pending ────────────
      console.log('\n5. Cheque tracker lists pending cheques');
      {
        const tracker = await paymentService.listCheques();
        assert(
          tracker.items.some((c: any) => c.id === cheque.id),
          'pending cheque appears in tracker',
        );
        assert(
          tracker.summary.pendingCents >= chequeCents,
          'tracker pendingCents includes the cheque',
        );
      }

      // ── 6. Lifecycle: DEPOSITED keeps it pending; CASHED = income ──
      console.log('\n6. Cheque lifecycle → CASHED flips income');
      {
        const deposited = await paymentService.setChequeStatus(cheque.id, 'DEPOSITED');
        assertEq(deposited.chequeStatus, 'DEPOSITED', 'cheque → DEPOSITED');
        assertEq(deposited.status, 'PENDING', 'DEPOSITED is still not income');
        const v = await invoiceService.get(inv1.id);
        assertEq(v.paidCents, cashCents, 'DEPOSITED: paid still excludes cheque');
      }
      {
        const cashed = await paymentService.setChequeStatus(cheque.id, 'CASHED');
        assertEq(cashed.chequeStatus, 'CASHED', 'cheque → CASHED');
        assertEq(cashed.status, 'SUCCEEDED', 'CASHED flips payment to SUCCEEDED');
        const v = await invoiceService.get(inv1.id);
        assertEq(v.paidCents, inv1.totalCents, 'paid now includes cashed cheque');
        assertEq(v.balanceCents, 0, 'balance cleared');
        assertEq(v.status, 'PAID', 'fully settled → PAID');
      }

      // ── 7. Cashed cheque leaves the default tracker ───────────────
      console.log('\n7. Cashed cheque drops out of the pending tracker');
      {
        const tracker = await paymentService.listCheques();
        assert(
          !tracker.items.some((c: any) => c.id === cheque.id),
          'cashed cheque no longer in default tracker',
        );
        const all = await paymentService.listCheques({ includeCashed: true });
        assert(
          all.items.some((c: any) => c.id === cheque.id),
          'cashed cheque visible with includeCashed',
        );
      }

      // ── 8. Lifecycle guards ───────────────────────────────────────
      console.log('\n8. Lifecycle + mutation guards');
      await expectThrow(
        () => paymentService.setChequeStatus(cheque.id, 'DEPOSITED'),
        'cannot move a CASHED cheque backwards',
      );
      await expectThrow(
        () => invoiceService.voidInvoice(inv1.id),
        'cannot void a settled invoice',
      );
      await expectThrow(
        () =>
          invoiceService.update(inv1.id, {
            lines: [{ description: 'x', unitPriceCents: 100 }],
          }),
        'cannot edit lines of a paid invoice',
      );
      await expectThrow(
        () =>
          paymentService.recordManual({
            clientId: client.id,
            amountCents: -1,
            method: 'CASH',
          }),
        'rejects non-positive amount',
      );
      await expectThrow(
        () =>
          paymentService.recordManual({
            clientId: client.id,
            amountCents: 100,
            method: 'STRIPE' as any,
          }),
        'rejects STRIPE as a manual method',
      );

      // ── 9. Void a clean draft, then block payment on it ───────────
      console.log('\n9. Void a draft invoice');
      {
        const voided = await invoiceService.voidInvoice(inv2.id);
        assertEq(voided.status, 'VOID', 'clean draft → VOID');
        await expectThrow(
          () =>
            paymentService.recordManual({
              clientId: client.id,
              invoiceId: inv2.id,
              amountCents: 100,
              method: 'CASH',
            }),
          'cannot record payment against a void invoice',
        );
      }

      // ── 10. Editing lines on a draft recomputes totals ────────────
      console.log('\n10. Editing draft lines recomputes totals');
      {
        const inv3 = await invoiceService.create({
          clientId: client.id,
          lines: [{ description: 'Initial', quantity: 1, unitPriceCents: 1000 }],
        });
        assertEq(inv3.totalCents, 1000 + expectedVat(1000), 'inv3 initial total');
        const edited = await invoiceService.update(inv3.id, {
          lines: [
            { description: 'A', quantity: 2, unitPriceCents: 1500 },
            { description: 'B', quantity: 1, unitPriceCents: 2000 },
          ],
        });
        const sub3 = 2 * 1500 + 2000; // 5000
        assertEq(edited.subtotalCents, sub3, 'edited subtotal recomputed');
        assertEq(edited.vatCents, expectedVat(sub3), 'edited VAT recomputed');
        assertEq(edited.totalCents, sub3 + expectedVat(sub3), 'edited total recomputed');
        assertEq(edited.lines.length, 2, 'lines replaced (2 lines)');
      }

      // ── 11. Payment-first billing: generate an invoice FROM a payment ─
      console.log('\n11. Generate invoice from a standalone payment');
      {
        // (a) Standalone CASH (income) → numbered PAID invoice whose total
        //     equals the gross to the cent (VAT forced to 0).
        const standaloneCash = await paymentService.recordManual({
          clientId: client.id,
          amountCents: 7500,
          method: 'CASH',
        });
        assertEq(standaloneCash.invoiceId, null, 'standalone cash has no invoice');
        assertEq(standaloneCash.status, 'SUCCEEDED', 'standalone cash → SUCCEEDED');

        const genCashRes = await paymentService.generateInvoiceFromPayment(
          standaloneCash.id,
        );
        assertEq(genCashRes.invoices.length, 1, 'single-biller default → 1 invoice');
        const genCash = genCashRes.invoices[0];
        assertEq(genCash.vatRate, 0, 'generated invoice forced to VAT 0');
        assertEq(genCash.vatCents, 0, 'generated invoice VAT = 0');
        assertEq(genCash.subtotalCents, 7500, 'subtotal = payment gross');
        assertEq(genCash.totalCents, 7500, 'total == gross (no rounding gap)');
        assertEq(genCash.paidCents, 7500, 'cash income counts toward the invoice');
        assertEq(genCash.balanceCents, 0, 'fully covered → balance 0');
        assertEq(genCash.status, 'PAID', 'settled payment → invoice PAID');
        assert(
          new RegExp(`^${year}-\\d{4}$`).test(genCash.number),
          `generated invoice is numbered (got ${genCash.number})`,
        );
        assert(
          genCash.lines?.[0]?.description?.startsWith('Paiement espèces du '),
          'line auto-described from tender + date',
        );

        // The payment is now attached to the new invoice.
        const linked = await raw.payment.findUnique({
          where: { id: standaloneCash.id },
          select: { invoiceId: true },
        });
        assertEq(linked?.invoiceId, genCash.id, 'payment now linked to the invoice');

        // (b) Re-generating on an already-linked payment is refused.
        await expectThrow(
          () => paymentService.generateInvoiceFromPayment(standaloneCash.id),
          'cannot regenerate an invoice for a linked payment',
        );

        // (c) Standalone UNCASHED cheque → invoice SENT (cheque not income yet).
        const standaloneCheque = await paymentService.recordManual({
          clientId: client.id,
          amountCents: 6000,
          method: 'CHECK',
          chequeNumber: '0007777',
          chequeBank: 'La Banque Postale',
        });
        assertEq(standaloneCheque.status, 'PENDING', 'standalone cheque → PENDING');

        const genChequeRes = await paymentService.generateInvoiceFromPayment(
          standaloneCheque.id,
        );
        assertEq(genChequeRes.invoices.length, 1, 'single-biller cheque → 1 invoice');
        const genCheque = genChequeRes.invoices[0];
        assertEq(genCheque.totalCents, 6000, 'cheque invoice total == gross');
        assertEq(genCheque.paidCents, 0, 'uncashed cheque is not income yet');
        assertEq(genCheque.balanceCents, 6000, 'balance = full total');
        assertEq(genCheque.status, 'SENT', 'pending cheque → invoice stays SENT');

        // (d) Cannot generate for a refunded / failed payment.
        const refunded = await raw.payment.create({
          data: {
            organizationId,
            clientId: client.id,
            amountCents: 4200,
            currency: 'EUR',
            status: 'REFUNDED',
            purpose: 'ENROLLMENT_BALANCE',
            method: 'CASH',
          },
          select: { id: true },
        });
        await expectThrow(
          () => paymentService.generateInvoiceFromPayment(refunded.id),
          'cannot generate an invoice for a refunded payment',
        );
      }

      // ── 12. Multi-biller N-way split: SCHOOL + 2 teachers ─────────
      console.log('\n12. Multi-biller issue: SCHOOL + 2 teachers (N-way split)');
      {
        // The org's SCHOOL identity issues its share. Reuse the existing one
        // (the common case) or seed a throwaway when the org has none yet.
        let school = await raw.billingIdentity.findFirst({
          where: { organizationId, ownerType: 'SCHOOL' },
          select: { id: true },
        });
        if (!school) {
          school = await raw.billingIdentity.create({
            data: {
              organizationId,
              ownerType: 'SCHOOL',
              legalName: org.name ?? 'École',
            },
            select: { id: true },
          });
          createdSchoolIdentityId = school.id;
        }

        // Two freelance teachers that bill the client directly. Each needs a
        // FACILITATOR billing identity to issue an invoice in their name.
        const facA = await raw.facilitator.create({
          data: {
            organizationId,
            firstname: 'Smoke',
            lastname: 'TeacherA',
            email: TEST_FAC_EMAILS[0],
            phone: '5550000001',
            color: '#aa3344',
            availability: {},
            isBookable: false,
            isBioDisplayed: false,
            billingMode: 'BILLS_CLIENT',
            splitRuleMode: 'PERCENTAGE',
            splitRuleValue: 30,
          },
        });
        const facB = await raw.facilitator.create({
          data: {
            organizationId,
            firstname: 'Smoke',
            lastname: 'TeacherB',
            email: TEST_FAC_EMAILS[1],
            phone: '5550000002',
            color: '#3344aa',
            availability: {},
            isBookable: false,
            isBioDisplayed: false,
            billingMode: 'BILLS_CLIENT',
            splitRuleMode: 'PERCENTAGE',
            splitRuleValue: 33,
          },
        });
        await raw.billingIdentity.create({
          data: {
            organizationId,
            ownerType: 'FACILITATOR',
            facilitatorId: facA.id,
            legalName: 'Smoke Teacher A EI',
            vatExempt: true,
          },
        });
        await raw.billingIdentity.create({
          data: {
            organizationId,
            ownerType: 'FACILITATOR',
            facilitatorId: facB.id,
            legalName: 'Smoke Teacher B EI',
            vatExempt: true,
          },
        });

        const enrollmentId = 'smoke-enrollment-nway';
        const billSubtotal = 10000; // 100€ HT, single line, to be split.
        const { invoices } = await issueBillingService.issue({
          clientId: client.id,
          billers: ['SCHOOL', facA.id, facB.id],
          status: 'SENT',
          enrollmentId,
          lines: [
            {
              description: 'Trimestre piano (réparti)',
              quantity: 1,
              unitPriceCents: billSubtotal,
            },
          ],
          // Settle the whole bill in cash, apportioned across the invoices.
          payment: { method: 'CASH' },
        });

        assertEq(invoices.length, 3, 'SCHOOL + 2 teachers → 3 invoices');
        const sumSubtotal = invoices.reduce(
          (s: number, i: any) => s + i.subtotalCents,
          0,
        );
        assertEq(
          sumSubtotal,
          billSubtotal,
          'issued invoices sum to the bill (HT, cent-exact)',
        );

        // Teachers take their %, the school keeps the remainder.
        const cutA = Math.round(billSubtotal * 0.3); // 3000
        const cutB = Math.round(billSubtotal * 0.33); // 3300
        const cutSchool = billSubtotal - cutA - cutB; // 3700
        const subtotals = invoices
          .map((i: any) => i.subtotalCents)
          .sort((a: number, b: number) => a - b);
        assertEq(
          JSON.stringify(subtotals),
          JSON.stringify([cutA, cutB, cutSchool].sort((a, b) => a - b)),
          'cuts = [teacherA %, teacherB %, school remainder]',
        );

        // Enrollment ↔ invoice axis: every issued line carries the enrollmentId.
        assert(
          invoices.every((i: any) =>
            i.lines.every((l: any) => l.enrollmentId === enrollmentId),
          ),
          'every issued line carries the enrollmentId',
        );

        // Invoice ↔ payment axis: one payment per invoice, settled in full.
        assert(
          invoices.every((i: any) => i.payments.length >= 1),
          'each invoice links its own payment row',
        );
        assert(
          invoices.every((i: any) => i.balanceCents === 0 && i.status === 'PAID'),
          'cash tender apportioned → every invoice PAID',
        );
        const sumPaid = invoices.reduce((s: number, i: any) => s + i.paidCents, 0);
        const sumTotal = invoices.reduce(
          (s: number, i: any) => s + i.totalCents,
          0,
        );
        assertEq(
          sumPaid,
          sumTotal,
          'payments sum exactly to the issued totals (TTC)',
        );

        // Distinct issuers: the school + each teacher's identity.
        const issuerIds = new Set(
          invoices.map((i: any) => i.issuer?.id).filter(Boolean),
        );
        assertEq(issuerIds.size, 3, 'three distinct issuers (school + 2 teachers)');

        // Teacher share-lines are tagged to their facilitator (drives payouts).
        const taggedFacIds = new Set(
          invoices
            .flatMap((i: any) => i.lines)
            .map((l: any) => l.facilitatorId)
            .filter(Boolean),
        );
        assert(
          taggedFacIds.has(facA.id) && taggedFacIds.has(facB.id),
          'teacher share-lines tagged to their facilitator',
        );

        // ── 13. Payment-first SPLIT: org + teacher from ONE standalone payment.
        //     The reported bug: only one invoice came out. With explicit
        //     per-biller shares we must get one invoice PER biller, summing to
        //     the tender to the cent.
        console.log(
          '\n13. Payment-first split: org + teacher from a standalone payment',
        );

        // (a) Explicit shares: teacher 60€, org keeps 30€ of a 90€ cash payment.
        const splitCash = await paymentService.recordManual({
          clientId: client.id,
          amountCents: 9000,
          method: 'CASH',
        });
        const splitRes = await paymentService.generateInvoiceFromPayment(
          splitCash.id,
          ['SCHOOL', facA.id],
          { [facA.id]: 6000, SCHOOL: 3000 },
        );
        assertEq(splitRes.invoices.length, 2, 'org + teacher → 2 invoices (not 1)');
        const splitSum = splitRes.invoices.reduce(
          (s: number, i: any) => s + i.totalCents,
          0,
        );
        assertEq(splitSum, 9000, 'split invoices sum to the payment (cent-exact)');
        const facInv = splitRes.invoices.find((i: any) =>
          i.lines.some((l: any) => l.facilitatorId === facA.id),
        );
        const orgInv = splitRes.invoices.find((i: any) =>
          i.lines.every((l: any) => !l.facilitatorId),
        );
        assertEq(facInv?.totalCents, 6000, 'teacher invoice = pinned share');
        assertEq(orgInv?.totalCents, 3000, 'org invoice = its pinned share');
        assert(
          splitRes.invoices.every(
            (i: any) => i.status === 'PAID' && i.balanceCents === 0,
          ),
          'cash settled → both split invoices PAID',
        );
        const splitIssuers = new Set(
          splitRes.invoices.map((i: any) => i.issuer?.id).filter(Boolean),
        );
        assertEq(splitIssuers.size, 2, 'two distinct issuers (org + teacher)');

        // (b) Org absorbs the remainder when only the teacher's share is given.
        const splitCash2 = await paymentService.recordManual({
          clientId: client.id,
          amountCents: 5000,
          method: 'CASH',
        });
        const splitRes2 = await paymentService.generateInvoiceFromPayment(
          splitCash2.id,
          ['SCHOOL', facA.id],
          { [facA.id]: 2000 },
        );
        assertEq(
          splitRes2.invoices.length,
          2,
          'org absorbs remainder → 2 invoices',
        );
        const facInv2 = splitRes2.invoices.find((i: any) =>
          i.lines.some((l: any) => l.facilitatorId === facA.id),
        );
        const orgInv2 = splitRes2.invoices.find((i: any) =>
          i.lines.every((l: any) => !l.facilitatorId),
        );
        assertEq(facInv2?.totalCents, 2000, 'teacher invoice = pinned share (b)');
        assertEq(orgInv2?.totalCents, 3000, 'org invoice = remainder (b)');

        // (c) Over-allocation (shares exceed the tender) is refused.
        const splitCash3 = await paymentService.recordManual({
          clientId: client.id,
          amountCents: 5000,
          method: 'CASH',
        });
        await expectThrow(
          () =>
            paymentService.generateInvoiceFromPayment(
              splitCash3.id,
              ['SCHOOL', facA.id],
              { [facA.id]: 6000, SCHOOL: 1000 },
            ),
          'over-allocated split is rejected',
        );

        // ── 14. Single-invoice split (sous-traitance): ONE org invoice for the
        //     full amount; the facilitator's share is booked as internal debt
        //     the org owes (heldBySchool/owed), NOT a second client invoice. ──
        console.log(
          '\n14. Single-invoice split: org invoice + facilitator owed (sous-traitance)',
        );

        const balOf = async (facId: string) => {
          const all = await invoiceSplitService.teacherBalances();
          return (
            all.find((b) => b.facilitatorId === facId) ?? {
              heldBySchoolCents: 0,
              paidOutCents: 0,
              directIncomeCents: 0,
              pendingClearanceCents: 0,
              owedCents: 0,
            }
          );
        };

        // (a) facA has an identity, but Mode 2 ignores it: 80€ cash, 50€ owed to
        //     the teacher, org keeps 30€ — must yield exactly ONE client invoice.
        const beforeA = await balOf(facA.id);
        const subCash = await paymentService.recordManual({
          clientId: client.id,
          amountCents: 8000,
          method: 'CASH',
        });
        const subRes = await paymentService.generateInvoiceFromPayment(
          subCash.id,
          ['SCHOOL', facA.id],
          { [facA.id]: 5000 },
          true, // singleInvoice
        );
        assertEq(subRes.invoices.length, 1, 'single-invoice mode → exactly 1 invoice');
        const subInv = subRes.invoices[0] as any;
        assertEq(subInv.totalCents, 8000, 'client invoice = full amount');
        assertEq(subInv.billToType, 'CLIENT', 'single invoice is billed to the client');
        assertEq(
          subInv.issuer?.ownerType,
          'SCHOOL',
          'single invoice issued under the org identity',
        );
        assert(
          subInv.status === 'PAID' && subInv.balanceCents === 0,
          'cash settled → single invoice PAID',
        );
        const subFacLine = subInv.lines.find((l: any) => l.facilitatorId === facA.id);
        const subOrgLine = subInv.lines.find((l: any) => !l.facilitatorId);
        assertEq(subFacLine?.amountCents, 5000, 'facilitator share tagged on a line');
        assertEq(
          subOrgLine?.amountCents,
          3000,
          'org keeps the remainder (untagged line)',
        );
        const afterA = await balOf(facA.id);
        assertEq(
          afterA.heldBySchoolCents - beforeA.heldBySchoolCents,
          5000,
          'org now holds the teacher’s share (heldBySchool += 5000)',
        );
        assertEq(
          afterA.owedCents - beforeA.owedCents,
          5000,
          'reste dû to the teacher += 5000',
        );

        // (b) A facilitator with NO billing identity is fine in Mode 2 (the org
        //     issues): 40€ cash entirely owed to facC → 1 invoice, debt booked.
        const facC = await raw.facilitator.create({
          data: {
            organizationId,
            firstname: 'Smoke',
            lastname: 'TeacherC',
            email: TEST_FAC_EMAILS[2],
            phone: '5550000003',
            color: '#33aa55',
            availability: {},
            isBookable: false,
            isBioDisplayed: false,
            billingMode: 'BILLS_CLIENT',
            splitRuleMode: 'PERCENTAGE',
            splitRuleValue: 50,
          },
        });
        const subCashC = await paymentService.recordManual({
          clientId: client.id,
          amountCents: 4000,
          method: 'CASH',
        });
        const subResC = await paymentService.generateInvoiceFromPayment(
          subCashC.id,
          [facC.id],
          { [facC.id]: 4000 },
          true,
        );
        assertEq(
          subResC.invoices.length,
          1,
          'no-identity facilitator → single invoice still issued',
        );
        assertEq(
          (subResC.invoices[0] as any).totalCents,
          4000,
          'pass-through invoice = full amount',
        );
        const balC = await balOf(facC.id);
        assertEq(
          balC.heldBySchoolCents,
          4000,
          'whole amount owed to a no-identity teacher',
        );

        // (c) Mode 1 (several invoices) still REQUIRES the facilitator identity.
        const subCashC2 = await paymentService.recordManual({
          clientId: client.id,
          amountCents: 4000,
          method: 'CASH',
        });
        await expectThrow(
          () =>
            paymentService.generateInvoiceFromPayment(
              subCashC2.id,
              [facC.id],
              { [facC.id]: 4000 },
              false,
            ),
          'multi-invoice mode still rejects a facilitator with no identity',
        );

        // ── 15. Direct allocation: "encaissé pour le compte de" with NO invoice.
        //     Any tender can carry a facilitator share straight on the payment;
        //     it lands as money the org holds (held/owed) without any invoice. ──
        console.log('\n15. Direct allocation on a payment (no invoice)');
        {
          const before = await balOf(facA.id);
          // 90€ cash: 40€ recorded on behalf of facA, org keeps 50€. No invoice.
          const directPay = await paymentService.recordManual({
            clientId: client.id,
            amountCents: 9000,
            method: 'CASH',
            allocations: [{ facilitatorId: facA.id, amountCents: 4000 }],
          });
          assertEq(directPay.invoiceId, null, 'direct-allocation payment has no invoice');
          assertEq(directPay.status, 'SUCCEEDED', 'cash direct payment → SUCCEEDED');
          const allocRows = await raw.paymentAllocation.findMany({
            where: { paymentId: directPay.id },
            select: { invoiceId: true, facilitatorId: true, amountCents: true },
          });
          assertEq(allocRows.length, 1, 'one direct allocation row created');
          assertEq(allocRows[0]?.invoiceId, null, 'direct allocation has null invoiceId');
          const after = await balOf(facA.id);
          assertEq(
            after.heldBySchoolCents - before.heldBySchoolCents,
            4000,
            'invoice-less allocation → held by org += 4000',
          );
          assertEq(
            after.owedCents - before.owedCents,
            4000,
            'invoice-less allocation → reste dû += 4000',
          );

          // A virement (bank transfer) works the same way.
          const beforeVir = await balOf(facA.id);
          await paymentService.recordManual({
            clientId: client.id,
            amountCents: 3000,
            method: 'BANK_TRANSFER',
            allocations: [{ facilitatorId: facA.id, amountCents: 1000 }],
          });
          const afterVir = await balOf(facA.id);
          assertEq(
            afterVir.owedCents - beforeVir.owedCents,
            1000,
            'virement on behalf of a teacher → owed += 1000',
          );

          // Generating a real invoice supersedes the direct allocations.
          const supersede = await paymentService.recordManual({
            clientId: client.id,
            amountCents: 5000,
            method: 'CASH',
            allocations: [{ facilitatorId: facA.id, amountCents: 2000 }],
          });
          assertEq(
            await raw.paymentAllocation.count({
              where: { paymentId: supersede.id, invoiceId: null },
            }),
            1,
            'direct allocation present before invoice',
          );
          await paymentService.generateInvoiceFromPayment(supersede.id);
          assertEq(
            await raw.paymentAllocation.count({
              where: { paymentId: supersede.id, invoiceId: null },
            }),
            0,
            'generating an invoice clears the direct allocations',
          );

          // Over-allocation is refused — and leaves NO payment behind.
          const paymentsBefore = await raw.payment.count({
            where: { clientId: client.id },
          });
          await expectThrow(
            () =>
              paymentService.recordManual({
                clientId: client.id,
                amountCents: 3000,
                method: 'CASH',
                allocations: [{ facilitatorId: facA.id, amountCents: 4000 }],
              }),
            'over-allocated direct split is rejected',
          );
          assertEq(
            await raw.payment.count({ where: { clientId: client.id } }),
            paymentsBefore,
            'rejected direct split leaves no payment behind',
          );
        }

        // ── 16. Cheque "en cours d'encaissement": DEPOSITED is a VISIBLE
        //     intermediate (pending clearance) before the cheque clears; CASHED
        //     then settles to held/owed and flips the invoice to PAID. ─────────
        console.log('\n16. Cheque deposited → en cours, cashed → settled');
        {
          const before = await balOf(facA.id);
          // Sous-traitance invoice (org issues, facA owed 50€) settled by an 80€
          // CHEQUE — walk it through the clearance lifecycle.
          const chq = await paymentService.recordManual({
            clientId: client.id,
            amountCents: 8000,
            method: 'CHECK',
            chequeNumber: '0009999',
            chequeBank: 'Société Générale',
          });
          const genRes = await paymentService.generateInvoiceFromPayment(
            chq.id,
            ['SCHOOL', facA.id],
            { [facA.id]: 5000 },
            true, // single-invoice (sous-traitance)
          );
          const chqInv = genRes.invoices[0] as any;
          assertEq(chqInv.status, 'SENT', 'uncashed cheque → invoice SENT');

          // While only deposited: en cours d'encaissement, NOT yet held/owed.
          const dep = await paymentService.setChequeStatus(chq.id, 'DEPOSITED');
          assertEq(dep.status, 'PENDING', 'deposited cheque is still PENDING');
          const mid = await balOf(facA.id);
          assertEq(
            mid.pendingClearanceCents - before.pendingClearanceCents,
            5000,
            'deposited cheque → en cours d’encaissement += 5000',
          );
          assertEq(
            mid.heldBySchoolCents - before.heldBySchoolCents,
            0,
            'deposited cheque is not yet held',
          );
          assertEq(
            mid.owedCents - before.owedCents,
            0,
            'deposited cheque is not yet owed',
          );
          {
            const v = await invoiceService.get(chqInv.id);
            assertEq(v.status, 'SENT', 'deposited (not cashed) → invoice still SENT');
            assertEq(v.paidCents, 0, 'deposited cheque is not income yet');
          }

          // Cashed: clears the en-cours bucket → held/owed, and settles invoice.
          const cashed = await paymentService.setChequeStatus(chq.id, 'CASHED');
          assertEq(cashed.status, 'SUCCEEDED', 'cashed cheque → SUCCEEDED');
          const done = await balOf(facA.id);
          assertEq(
            done.pendingClearanceCents - before.pendingClearanceCents,
            0,
            'cashed cheque clears the en-cours bucket',
          );
          assertEq(
            done.heldBySchoolCents - before.heldBySchoolCents,
            5000,
            'cashed cheque → held by org += 5000',
          );
          assertEq(
            done.owedCents - before.owedCents,
            5000,
            'cashed cheque → reste dû += 5000',
          );
          {
            const v = await invoiceService.get(chqInv.id);
            assertEq(v.status, 'PAID', 'cashed cheque → invoice PAID');
            assertEq(v.balanceCents, 0, 'cashed cheque clears the balance');
          }
        }
      }
    });
  } finally {
    await purge(organizationId);
    // Drop the SCHOOL identity only if THIS run created it (after purge, so no
    // invoice still references it as issuer).
    if (createdSchoolIdentityId) {
      await raw.billingIdentity
        .delete({ where: { id: createdSchoolIdentityId } })
        .catch(() => undefined);
    }
    console.log('\nTest data purged.');
  }

  console.log(`\n${assertionCount} assertions, ${failureCount} failures\n`);
  process.exit(failureCount === 0 ? 0 : 1);
}

main()
  .catch((err) => {
    console.error('\n💥 Smoke crashed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await raw.$disconnect();
    await enginePrisma.$disconnect();
  });
