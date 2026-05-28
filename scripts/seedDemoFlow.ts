/**
 * Seed a demo workflow-engine flow for an organization
 * (Phase 3.1 — graph engine v2).
 *
 * Creates a working 3-node VISITOR flow that proves the engine end-
 * to-end without depending on Stripe / post-submit actions:
 *
 *   Node 1: SINGLE_SELECT — "Choisissez un service" (3 hardcoded options)
 *   Node 2: FORM          — "Vos coordonnées" (firstname / lastname /
 *                                              email / phone)
 *   Node 3: RECAP         — "Confirmation"
 *
 * Wired with a 'visitor' entry point at node 1 + edges connecting
 * each node in order. No actions in the demo — admins layer
 * SEND_EMAIL etc. through the editor's Actions tab.
 *
 * Idempotent on re-run: any existing demo flow for the org (matched
 * by the "[demo]" name prefix) is deleted along with its runs +
 * metering rows, then a fresh copy is created and published.
 *
 * Usage:
 *   npx ts-node scripts/seedDemoFlow.ts [organizationId]
 *   npx ts-node scripts/seedDemoFlow.ts            # uses DEV_DEFAULT_ORG_ID
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
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
  'Trois nœuds : choix de service → coordonnées → récapitulatif. ' +
  'Aucune action post-submit n’est encore branchée (Phase 2.2/3.x).';

const ADMIN_URL_BASE =
  process.env.ADMIN_ORIGINS?.split(',')[0]?.trim() || 'http://localhost:3000';
const API_URL_BASE = `http://localhost:${process.env.PORT || 3001}/api`;

// ─── Fixture payload (v2) ─────────────────────────────────────────

function buildDemoPayload(): FlowPayload {
  // Stable node ids — generated here so the entry point + edges can
  // reference them. In the canvas editor these would come from
  // crypto.randomUUID() on node creation.
  const serviceNodeId = randomUUID();
  const formNodeId = randomUUID();
  const recapNodeId = randomUUID();

  return {
    name: DEMO_NAME,
    description: DEMO_DESCRIPTION,
    kind: 'VISITOR',
    nodes: [
      {
        id: serviceNodeId,
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
        position: { x: 100, y: 100 },
      },
      {
        id: formNodeId,
        kind: 'FORM',
        label: 'Vos coordonnées',
        description: 'Nous utiliserons ces informations pour vous recontacter.',
        config: {
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
        position: { x: 100, y: 350 },
      },
      {
        id: recapNodeId,
        kind: 'RECAP',
        label: 'Confirmation',
        description:
          'Récapitulatif des données saisies avant validation finale.',
        config: {},
        position: { x: 100, y: 600 },
      },
    ],
    edges: [
      { fromNodeId: serviceNodeId, toNodeId: formNodeId, order: 0 },
      { fromNodeId: formNodeId, toNodeId: recapNodeId, order: 0 },
    ],
    entryPoints: [
      {
        kind: 'visitor',
        config: {},
        entryNodeId: serviceNodeId,
      },
    ],
  };
}

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
    // WidgetRun has onDelete:Restrict — wipe runs + metering first.
    // v2 cascade-deletes nodes / edges / entry points on flow delete.
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
    console.error('Pass the org id as the first arg, or set DEV_DEFAULT_ORG_ID.\n');
    process.exit(1);
  }

  console.log(`\nSeeding demo flow for "${org.name}" (${org.id})\n`);

  const removedCount = await purgeExistingDemo(organizationId);
  if (removedCount > 0) console.log('');

  // 1. Create the flow shell.
  const flow = await createFlow({
    organizationId,
    name: DEMO_NAME,
    description: DEMO_DESCRIPTION,
    kind: 'VISITOR',
  });
  console.log(`  • created flow: ${flow.id}`);

  // 2. Save the draft with the v2 payload.
  const payload = buildDemoPayload();
  await patchDraft(organizationId, flow.id, payload);
  console.log(
    `  • wrote draft (${payload.nodes.length} nodes, ${payload.edges.length} edges, ${payload.entryPoints.length} entry points)`,
  );

  // 3. Publish — validates the draft + writes v2 tables + assigns
  // publishableKey + bumps version + snapshots.
  const published = await publishFlow(organizationId, flow.id);
  console.log(`  • published v${published.version}`);

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
