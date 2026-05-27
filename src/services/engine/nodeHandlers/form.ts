// v2-native FORM handler (Phase 3.4).
//
// Supersedes the legacy `stepHandlers/form.ts` wrapper that v1
// surfaced. The v2 handler keeps the same per-field-kind validation
// semantics but:
//   - is async so it can resolve ENTITY_REF fields against the org-
//     scoped entity registry during validate/apply,
//   - widens field.kind to plain string so adding a new kind is just a
//     switch-case (no Prisma enum edit),
//   - lives in nodeHandlers/ to keep the v2 + v1 paths separate. The
//     v1 handler stays around until Phase 3.5 deletes the legacy
//     WidgetField table.

import {
  isValidEntityType,
  resolveEntity,
  type ResolvedEntity,
} from '../entityRegistry';
import type { StepSubmission, ValidationError } from '../types';
import type { NodeHandler, SubmissionContext } from './index';

// Same loose-but-defensible email check as the legacy handler.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FormFieldRaw = {
  order?: number;
  kind: string;
  label: string;
  placeholder?: string | null;
  required?: boolean;
  binding?: string;
  bindingTarget: string;
  config?: Record<string, unknown>;
};

function readFields(node: { config: unknown }): FormFieldRaw[] {
  const cfg = (node.config ?? {}) as { fields?: unknown };
  if (!Array.isArray(cfg.fields)) return [];
  return cfg.fields as FormFieldRaw[];
}

/**
 * Synchronous primitive-shape checks. ENTITY_REF + SELECT defer their
 * deeper validation (entity lookup / option-set membership) to the
 * async path below.
 */
function shallowKindCheck(kind: string, raw: unknown): string | null {
  switch (kind) {
    case 'TEXT':
    case 'TEXTAREA':
      return typeof raw === 'string' ? null : 'doit être du texte';
    case 'EMAIL':
      return typeof raw === 'string' && EMAIL_RE.test(raw)
        ? null
        : "n'est pas une adresse email valide";
    case 'PHONE':
      return typeof raw === 'string' && (raw.match(/\d/g)?.length ?? 0) >= 6
        ? null
        : "n'est pas un numéro de téléphone valide";
    case 'NUMBER':
      return typeof raw === 'number' && Number.isFinite(raw)
        ? null
        : 'doit être un nombre';
    case 'DATE':
      if (typeof raw !== 'string') return 'doit être une date (chaîne ISO)';
      return Number.isNaN(new Date(raw).getTime())
        ? "n'est pas une date valide"
        : null;
    case 'BOOLEAN':
      return typeof raw === 'boolean' ? null : 'doit être vrai ou faux';
    case 'SELECT':
      return typeof raw === 'string' ? null : 'doit être une chaîne';
    case 'MULTI_SELECT':
      return Array.isArray(raw) && raw.every((v) => typeof v === 'string')
        ? null
        : 'doit être un tableau de chaînes';
    case 'ENTITY_REF':
      // Submission carries the picked entity's id (a string). Deeper
      // resolution against the registry happens in the async pass.
      return typeof raw === 'string' && raw.length > 0
        ? null
        : "n'est pas un identifiant valide";
    default:
      return `type de champ inconnu: ${kind}`;
  }
}

/**
 * SELECT / MULTI_SELECT membership check. Pulled out so the async path
 * can call it inline.
 */
function checkSelectMembership(
  field: FormFieldRaw,
  raw: unknown,
): ValidationError | null {
  const cfg = field.config as { options?: { value: string }[] } | undefined;
  const options = Array.isArray(cfg?.options) ? cfg.options : [];
  if (options.length === 0) {
    return {
      field: field.bindingTarget,
      message: `${field.label} : configuration manquante (aucune option définie).`,
    };
  }
  const validValues = new Set(options.map((o) => o.value));
  const submitted =
    field.kind === 'SELECT' ? [raw as string] : (raw as string[]);
  const invalid = submitted.filter((v) => !validValues.has(v));
  if (invalid.length > 0) {
    return {
      field: field.bindingTarget,
      message: `${field.label} : valeur(s) invalide(s) ${invalid.join(', ')}.`,
    };
  }
  return null;
}

type EntityRefConfig = {
  entityType?: string;
  extractFields?: unknown;
};

function readEntityRefConfig(field: FormFieldRaw): {
  entityType: string | null;
  extractFields: string[];
} {
  const cfg = (field.config ?? {}) as EntityRefConfig;
  const extract = Array.isArray(cfg.extractFields)
    ? (cfg.extractFields as unknown[]).filter(
        (f): f is string => typeof f === 'string',
      )
    : [];
  return {
    entityType: typeof cfg.entityType === 'string' ? cfg.entityType : null,
    extractFields: extract,
  };
}

/**
 * Resolve every ENTITY_REF field's value into a ResolvedEntity, keyed
 * by bindingTarget. Used by validate (to surface "not found" errors)
 * and apply (to project the resolved object into vars).
 *
 * Idempotent — apply runs the same lookups validate did. Two DB calls
 * per ENTITY_REF per submit is acceptable; the surface is per-submit
 * (low frequency) and the resolves are point lookups (cheap).
 */
async function resolveEntityRefs(
  fields: FormFieldRaw[],
  submission: StepSubmission,
  context: SubmissionContext,
): Promise<Map<string, ResolvedEntity>> {
  const resolved = new Map<string, ResolvedEntity>();
  for (const field of fields) {
    if (field.kind !== 'ENTITY_REF') continue;
    const raw = submission.values?.[field.bindingTarget];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const { entityType, extractFields } = readEntityRefConfig(field);
    if (!entityType || !isValidEntityType(entityType)) continue;
    const entity = await resolveEntity({
      organizationId: context.organizationId,
      type: entityType,
      id: raw,
      extractFields,
    });
    if (entity) resolved.set(field.bindingTarget, entity);
  }
  return resolved;
}

export const formNodeHandler: NodeHandler = {
  kind: 'FORM',
  category: 'UI',

  validateConfig(config) {
    if (config == null) return null; // empty config is ok during drafting
    if (typeof config !== 'object' || Array.isArray(config)) {
      return 'FORM config must be an object';
    }
    const cfg = config as { fields?: unknown };
    if (cfg.fields !== undefined && !Array.isArray(cfg.fields)) {
      return 'FORM config.fields must be an array';
    }
    return null;
  },

  async validateSubmission(submission, node, context) {
    const fields = readFields(node);
    const errors: ValidationError[] = [];

    // First pass — shallow type checks + required-presence.
    for (const field of fields) {
      const raw = submission.values?.[field.bindingTarget];
      const present = raw !== undefined && raw !== null && raw !== '';

      if (field.required && !present) {
        errors.push({
          field: field.bindingTarget,
          message: `${field.label} est requis.`,
        });
        continue;
      }
      if (!present) continue; // optional + empty is fine

      const shallow = shallowKindCheck(field.kind, raw);
      if (shallow) {
        errors.push({
          field: field.bindingTarget,
          message: `${field.label} ${shallow}.`,
        });
        continue;
      }

      if (field.kind === 'SELECT' || field.kind === 'MULTI_SELECT') {
        const err = checkSelectMembership(field, raw);
        if (err) errors.push(err);
      }
    }

    // Second pass — ENTITY_REF resolution. Skipped when the field
    // already errored above (we don't double-report).
    const erroredFields = new Set(errors.map((e) => e.field));
    const entityRefFields = fields.filter(
      (f) =>
        f.kind === 'ENTITY_REF' && !erroredFields.has(f.bindingTarget),
    );
    for (const field of entityRefFields) {
      const raw = submission.values?.[field.bindingTarget];
      const present = raw !== undefined && raw !== null && raw !== '';
      if (!present) continue;
      const { entityType } = readEntityRefConfig(field);
      if (!entityType || !isValidEntityType(entityType)) {
        errors.push({
          field: field.bindingTarget,
          message: `${field.label} : type d’entité inconnu (${
            entityType ?? 'non spécifié'
          }).`,
        });
        continue;
      }
      const { extractFields } = readEntityRefConfig(field);
      const entity = await resolveEntity({
        organizationId: context.organizationId,
        type: entityType,
        id: raw as string,
        extractFields,
      });
      if (!entity) {
        errors.push({
          field: field.bindingTarget,
          message: `${field.label} : sélection introuvable.`,
        });
      }
    }

    return errors;
  },

  async applySubmission(submission, node, currentVars, context) {
    const fields = readFields(node);
    const next: Record<string, unknown> = { ...currentVars };

    // Resolve all ENTITY_REF picks once so apply can project them.
    const resolved = await resolveEntityRefs(fields, submission, context);

    for (const field of fields) {
      // VAR is the only binding wired in v2 — DB_COLUMN + CUSTOM_FIELD
      // remain deferred (same gap as the legacy handler).
      const binding = field.binding ?? 'VAR';
      if (binding !== 'VAR') continue;

      const raw = submission.values?.[field.bindingTarget];

      if (field.kind === 'ENTITY_REF') {
        const entity = resolved.get(field.bindingTarget);
        if (entity) {
          // Write the WHOLE entity object — id + label + extracted
          // fields — so downstream interpolation can do
          // {vars.<bindingTarget>.email}.
          next[field.bindingTarget] = {
            id: entity.id,
            label: entity.label,
            ...entity.fields,
          };
        }
        // No entity (e.g. optional + unfilled): don't write the var.
        continue;
      }

      if (raw !== undefined) {
        next[field.bindingTarget] = raw;
      }
    }
    return next;
  },
};
