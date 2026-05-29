// Central registry of every importable entity type.
//
// Add a new entity = drop a new spec file in specs/ and register
// it here. Everything else (CSV parsing, validation, preview,
// commit, template download, admin UI rendering) follows from the
// registry automatically.

import type { ImportEntitySpec } from './types';
import { clientSpec } from './specs/client';
import { closureSpec } from './specs/closure';
import { facilitatorSpec } from './specs/facilitator';
import { locationSpec } from './specs/location';
import { roomSpec } from './specs/room';
import { serviceSpec } from './specs/service';
import { serviceCategorySpec } from './specs/serviceCategory';
import { tagSpec } from './specs/tag';
import { termSpec } from './specs/term';

const IMPORTABLE_ENTITIES: ImportEntitySpec[] = [
  // Order = display order in the admin picker. Tier 1 first
  // (no/few dependencies) so admins import in the right sequence
  // when bootstrapping from scratch.
  locationSpec,
  tagSpec,
  serviceCategorySpec,
  termSpec,
  closureSpec,
  clientSpec,
  facilitatorSpec,
  roomSpec,
  serviceSpec,
];

export const IMPORT_REGISTRY: Record<string, ImportEntitySpec> =
  IMPORTABLE_ENTITIES.reduce(
    (acc, spec) => {
      acc[spec.type] = spec;
      return acc;
    },
    {} as Record<string, ImportEntitySpec>,
  );

export function getImportSpec(type: string): ImportEntitySpec | null {
  return IMPORT_REGISTRY[type] ?? null;
}

/** Public summary surfaced to the admin UI's entity picker + column hints. */
export function listImportSpecs(): Array<{
  type: string;
  label: string;
  description: string;
  uniqueBy: string;
  columns: ImportEntitySpec['columns'];
}> {
  return IMPORTABLE_ENTITIES.map((s) => ({
    type: s.type,
    label: s.label,
    description: s.description,
    uniqueBy: s.uniqueBy,
    columns: s.columns,
  }));
}
