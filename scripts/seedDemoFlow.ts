/**
 * Seed a demo workflow-engine flow for an organization
 * (Phase 2.0 Commit 5).
 *
 * Creates a working 3-step BOOKING flow that proves the engine end-
 * to-end without depending on Stripe / post-submit actions:
 *
 *   1. SINGLE_SELECT — "Choisissez un service" (3 hardcoded options)
 *   2. FORM          — "Vos coordonnées" (firstname / lastname /
 *                                          email / phone)
 *   3. RECAP         — "Confirmation"
 *
 * Idempotent on re-run: any existing demo flow for the org (matched
 * by the "[demo]" name prefix) is deleted along with its runs +
 * metering rows, then a fresh copy is created and published. Safe to
 * re-run as many times as you like — no other data is touched.
 *
 * On success the script prints:
 *   - The flow id (use in /admin/widget-flows/:id)
 *   - The publishable key (assigned by the first Publish)
 *   - The public + admin URLs
 *   - A curl command the dev can paste into a terminal
 *
 * Usage:
 *   npx ts-node scripts/seedDemoFlow.ts [organizationId]
 *   npx ts-node scripts/seedDemoFlow.ts                    # uses DEV_DEFAULT_ORG_ID
 *
 * NOT a route swap for the existing booking widget — that lands in
 * Phase 2.2 once Stripe + post-submit actions exist (see design doc
 * §15 Commit 5 note).
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

import enginePrisma from '../src/prisma';
import {
  createFlow,
  patchDraft,
  publishFlow,
} from '../src/services/engine/flowAdminService';
import type { FlowPayload } from '../src/validations/widgetFlow.validation';

const prisma = new PrismaClient();

const DEMO_NAME = '[demo] Réservation cours d’essai';
const DEMO_DESCRIPTION =
  'Flow de démonstration créé par scripts/seedDemoFlow.ts. ' +
  'Trois étapes : choix de service → coordonnées → récapitulatif. ' +
  'Aucune action post-submit n’est encore branchée (Phase 2.2).';

const ADMIN_URL_BASE =
  process.env.ADMIN_ORIGINS?.split(',')[0]?.trim() || 'http://localhost:3000';
const API_URL_BASE = `http://localhost:${process.env.PORT || 3001}/api`;

// ─── Fixture payload ──────────────────────────────────────────────

const DEMO_PAYLOAD: FlowPayload = {
  name: DEMO_NAME,
  description: DEMO_DESCRIPTION,
  kind: 'BOOKING',
  steps: [
    {
      order: 0,
      kind: 'SINGLE_SELECT',
      label: 'Choisissez un service',
      description:
        'Cette étape sera bientôt alimentée par vos Services existants.',
      config: {
        varName: 'service',
        options: [
          { value: 'piano', label: 'Cours de piano' },
          { value: 'guitar', label: 'Cours de guitare' },
          { value: 'violin', label: 'Cours de violon' },
        ],
      },
      visibleWhen: null,
      fields: [],
    },
    {
      order: 1,
      kind: 'FORM',
      label: 'Vos coordonnées',
      description: 'Nous utiliserons ces informations pour vous recontacter.',
      config: {},
      visibleWhen: null,
      fields: [
        {
          order: 0,
          kind: 'TEXT',
          label: 'Prénom',
          placeholder: 'Ex: Alice',
          required: true,
          binding: 'VAR',
          bindingTarget: 'firstname',
          config: {},
        },
        {
          order: 1,
          kind: 'TEXT',
          label: 'Nom',
          placeholder: 'Ex: Dupont',
          required: true,
          binding: 'VAR',
          bindingTarget: 'lastname',
          config: {},
        },
        {
          order: 2,
          kind: 'EMAIL',
          label: 'Email',
          placeholder: 'alice@example.com',
          required: true,
          binding: 'VAR',
          bindingTarget: 'email',
          config: {},
        },
        {
          order: 3,
          kind: 'PHONE',
          label: 'Téléphone (optionnel)',
          placeholder: '06 12 34 56 78',
          required: false,
          binding: 'VAR',
          bindingTarget: 'phone',
          config: {},
        },
      ],
    },
    {
      order: 2,
      kind: 'RECAP',
      label: 'Confirmation',
      description:
        'Récapitulatif des données saisies avant validation finale.',
      config: {},
      visibleWhen: null,
      fields: [],
    },
  ],
};

// ─── Cleanup ──────────────────────────────────────────────────────

async function purgeExistingDemo(organizationId: string) {
  const existing = await prisma.widgetFlow.findMany({
    where: {
      organizationId,
      name: { startsWith: '[demo]' },
    },
    select: { id: true, name: true },
  });
  for (const flow of existing) {
    // Mirror the teardown order from flowAdminService.deleteFlow:
    // metering + runs first (WidgetRun.flow has onDelete: Restrict),
    // then the flow itself cascades into Step / Field / Draft /
    // Snapshot / Submit.
    await prisma.engineActionEvent.deleteMany({ where: { flowId: flow.id } });
    await prisma.widgetRun.deleteMany({ where: { flowId: flow.id } });
    await prisma.widgetFlow.delete({ where: { id: flow.id } });
    console.log(`  • removed existing demo: ${flow.name} (${flow.id})`);
  }
  return existing.length;
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  const organizationId =
    process.argv[2] ??
    process.env.DEV_DEFAULT_ORG_ID ??
    'clxorg000000000000000001';

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, slug: true },
  });
  if (!org) {
    console.error(`\n❌  Organization ${organizationId} not found.\n`);
    console.error(
      'Pass the org id as the first arg, or set DEV_DEFAULT_ORG_ID.\n',
    );
    process.exit(1);
  }

  console.log(`\nSeeding demo flow for "${org.name}" (${org.id})\n`);

  // 1. Wipe any existing demo flows.
  const removedCount = await purgeExistingDemo(organizationId);
  if (removedCount > 0) console.log('');

  // 2. Create the flow shell.
  const flow = await createFlow({
    organizationId,
    name: DEMO_NAME,
    description: DEMO_DESCRIPTION,
    kind: 'BOOKING',
  });
  console.log(`  • created flow: ${flow.id}`);

  // 3. Save the draft (3 steps + 4 fields on step 2).
  await patchDraft(organizationId, flow.id, DEMO_PAYLOAD);
  console.log('  • wrote draft (3 steps)');

  // 4. Publish — validates the draft + assigns publishableKey + bumps
  // version + snapshots.
  const published = await publishFlow(organizationId, flow.id);
  console.log(`  • published v${published.version}`);

  // 5. Print URLs.
  const adminUrl = `${ADMIN_URL_BASE}/admin/widget-flows/${published.id}`;
  const startRunUrl = `${API_URL_BASE}/public/widget-flows/by-key/${published.publishableKey}/runs`;

  console.log('\n✓ Demo flow ready.\n');
  console.log(`  Flow id          : ${published.id}`);
  console.log(`  Publishable key  : ${published.publishableKey}`);
  console.log(`  Admin URL        : ${adminUrl}`);
  console.log(`  Public start URL : POST ${startRunUrl}`);
  console.log('\nQuick smoke test from a terminal:\n');
  console.log(`  curl -X POST ${startRunUrl} \\`);
  console.log(`       -H 'Content-Type: application/json' \\`);
  console.log(`       -d '{}'`);
  console.log('');
}

main()
  .catch((err) => {
    console.error('\n💥 Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await enginePrisma.$disconnect();
  });
