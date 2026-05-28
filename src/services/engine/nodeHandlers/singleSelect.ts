// v2-native SINGLE_SELECT handler.
//
// Migrated from the legacy stepHandlers/singleSelect.ts when the v1
// engine was retired. Same baseline contract as v1 + a new entity-
// source mode added in May 2026.
//
// Config shape (WidgetNode.config):
//   {
//     "varName": "<vars.X to write into>",
//
//     // Source A — static option list (the original mode):
//     "optionsSource": "static",  // optional; defaults to "static"
//     "options": [{ "value": "string", "label": "string" }, ...]
//
//     // Source B — pull from an org-scoped entity (entityRegistry):
//     "optionsSource": "entity",
//     "entityType":   "facilitator" | "room" | "client" | "service",
//     "extractFields": ["email", "firstname", ...]
//   }
//
// Submission shape (both modes): { selected: "<id>" }
//
// Apply behavior:
//   static → vars[varName] = the picked option's value string.
//   entity → vars[varName] = { id, label, ...extractedFields } object,
//            same projection ENTITY_REF uses in FORM fields.
//
// The naming mirrors FORM field ENTITY_REF semantics on purpose so
// downstream interpolation works the same way:
//   {vars.X.email} when entity mode, {vars.X} when static.

import {
  isValidEntityType,
  resolveEntity,
  type ResolvedEntity,
} from '../entityRegistry';
import type { StepSubmission, ValidationError } from '../types';
import type { NodeHandler } from './index';

type StaticOption = { value: string; label: string };

type SingleSelectConfig = {
  varName: string;
  optionsSource: 'static' | 'entity';
  // Static-mode fields.
  options?: StaticOption[];
  // Entity-mode fields.
  entityType?: string;
  extractFields?: string[];
};

function readConfig(node: { id: string; config: unknown }): SingleSelectConfig {
  const raw = (node.config ?? {}) as Record<string, unknown>;
  const varName = typeof raw.varName === 'string' ? raw.varName : '';
  const optionsSource =
    raw.optionsSource === 'entity' ? 'entity' : 'static';

  if (varName.length === 0) {
    throw new Error(
      `[engine] SINGLE_SELECT node ${node.id} is missing config.varName`,
    );
  }

  if (optionsSource === 'entity') {
    const entityType =
      typeof raw.entityType === 'string' ? raw.entityType : undefined;
    const extractFields = Array.isArray(raw.extractFields)
      ? (raw.extractFields as unknown[]).filter(
          (f): f is string => typeof f === 'string',
        )
      : [];
    return { varName, optionsSource, entityType, extractFields };
  }

  const options = Array.isArray(raw.options)
    ? (raw.options as unknown[]).map((o) => {
        const opt = (o ?? {}) as { value?: unknown; label?: unknown };
        return {
          value: typeof opt.value === 'string' ? opt.value : '',
          label: typeof opt.label === 'string' ? opt.label : '',
        };
      })
    : [];
  return { varName, optionsSource, options };
}

export const singleSelectNodeHandler: NodeHandler = {
  kind: 'SINGLE_SELECT',
  category: 'UI',

  validateConfig(config) {
    if (config == null) return null; // empty config tolerated during drafting
    if (typeof config !== 'object' || Array.isArray(config)) {
      return 'SINGLE_SELECT config must be an object';
    }
    const c = config as Record<string, unknown>;
    if (c.varName !== undefined && typeof c.varName !== 'string') {
      return 'SINGLE_SELECT config.varName must be a string';
    }
    const source = c.optionsSource;
    if (source !== undefined && source !== 'static' && source !== 'entity') {
      return 'SINGLE_SELECT config.optionsSource must be "static" or "entity"';
    }
    if (source === 'entity') {
      if (typeof c.entityType !== 'string') {
        return 'SINGLE_SELECT config.entityType is required when optionsSource = "entity"';
      }
      if (!isValidEntityType(c.entityType)) {
        return `SINGLE_SELECT config.entityType "${c.entityType}" is not a known entity type`;
      }
      if (c.extractFields !== undefined && !Array.isArray(c.extractFields)) {
        return 'SINGLE_SELECT config.extractFields must be an array of strings';
      }
    } else if (c.options !== undefined && !Array.isArray(c.options)) {
      return 'SINGLE_SELECT config.options must be an array';
    }
    return null;
  },

  async validateSubmission(
    submission: StepSubmission,
    node,
    context,
  ): Promise<ValidationError[]> {
    const config = readConfig(node);
    const selected = submission.values?.selected;

    if (typeof selected !== 'string' || selected.length === 0) {
      return [
        { field: 'selected', message: 'Veuillez sélectionner une option.' },
      ];
    }

    if (config.optionsSource === 'entity') {
      if (!config.entityType || !isValidEntityType(config.entityType)) {
        return [
          {
            field: 'selected',
            message:
              'Configuration invalide : type d’entité inconnu pour cette étape.',
          },
        ];
      }
      const entity = await resolveEntity({
        organizationId: context.organizationId,
        type: config.entityType,
        id: selected,
        extractFields: config.extractFields,
      });
      if (!entity) {
        return [
          { field: 'selected', message: 'Cette sélection n’est plus disponible.' },
        ];
      }
      return [];
    }

    // static mode — verify against the configured option list.
    const known = (config.options ?? []).some((o) => o.value === selected);
    if (!known) {
      return [
        {
          field: 'selected',
          message: `La valeur "${selected}" n'est pas une option valide.`,
        },
      ];
    }
    return [];
  },

  async applySubmission(submission, node, currentVars, context) {
    const config = readConfig(node);
    const selected = submission.values.selected as string;

    if (config.optionsSource === 'entity' && config.entityType) {
      // Re-resolve to project the picked entity into vars as an object,
      // matching the ENTITY_REF FORM-field behavior. Two DB calls per
      // submit (validate + apply) is acceptable on a per-submit-frequency
      // path; entity rows are cheap point lookups.
      const entity: ResolvedEntity | null = await resolveEntity({
        organizationId: context.organizationId,
        type: config.entityType,
        id: selected,
        extractFields: config.extractFields,
      });
      if (!entity) {
        // Defensive — validate already caught this, but apply is
        // separate. Leave the existing var untouched rather than
        // overwriting with a half-resolved value.
        return currentVars;
      }
      return {
        ...currentVars,
        [config.varName]: {
          id: entity.id,
          label: entity.label,
          ...entity.fields,
        },
      };
    }

    return { ...currentVars, [config.varName]: selected };
  },
};
