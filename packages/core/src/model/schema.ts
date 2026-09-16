import { type ZodType, toJSONSchema } from 'zod';

/**
 * Zod to Gemini-safe JSON Schema.
 *
 * This is the subtle file in the model layer, because the failure mode is *silence*.
 * `responseJsonSchema` supports only a documented subset of JSON Schema, and anything outside it
 * is **ignored without warning** — so a schema that says `minLength: 3` reads as a constraint the
 * model will honour, and is in fact decoration.
 *
 * Two consequences are encoded here:
 *
 *  1. Unsupported keywords are stripped deliberately, and the stripping is reported, so the
 *     request reflects what the provider will actually enforce.
 *  2. **Those constraints are therefore validated in Zod after parsing, never relied upon in the
 *     schema we send.** `parseWithSchema` in `port.ts` is where that happens.
 *
 * A top-level `$schema` key is also removed on purpose: its presence makes the SDK silently
 * re-route `responseSchema` to `responseJsonSchema`, which is a behaviour change nobody would
 * connect to a stray metadata key. Zod 4's `toJSONSchema()` emits one by default.
 */

/** Keywords `responseJsonSchema` honours. */
export const GEMINI_SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  '$id',
  '$defs',
  '$ref',
  '$anchor',
  'type',
  'format',
  'title',
  'description',
  'enum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'anyOf',
  'oneOf',
  'properties',
  'additionalProperties',
  'required',
  'propertyOrdering',
]);

/** Keywords that are accepted, ignored, and therefore dangerous to trust. */
export const GEMINI_IGNORED_KEYWORDS: ReadonlySet<string> = new Set([
  'pattern',
  'const',
  'minLength',
  'maxLength',
  'multipleOf',
  'allOf',
  'not',
  'uniqueItems',
  'if',
  'then',
  'else',
  'patternProperties',
  'dependentSchemas',
  'contains',
  'exclusiveMinimum',
  'exclusiveMaximum',
  '$schema',
]);

export interface SanitisedSchema {
  readonly schema: Record<string, unknown>;
  /** Every keyword removed, with its JSON path. Surfaced so nothing is dropped invisibly. */
  readonly stripped: readonly string[];
}

/**
 * Throw if a schema carries a keyword Gemini will ignore.
 *
 * Used in tests over every schema the application actually sends, which is what turns "we were
 * careful" into a property the build enforces.
 */
export function assertGeminiSafeSchema(schema: unknown, path = '$'): void {
  if (schema === null || typeof schema !== 'object') return;

  if (Array.isArray(schema)) {
    schema.forEach((entry, i) => assertGeminiSafeSchema(entry, `${path}[${i}]`));
    return;
  }

  for (const [key, value] of Object.entries(schema)) {
    if (GEMINI_IGNORED_KEYWORDS.has(key)) {
      throw new Error(
        `Schema at ${path} uses "${key}", which Gemini accepts and silently ignores. ` +
          'Strip it with toGeminiSchema() and enforce the constraint in Zod after parsing.',
      );
    }
    if (key === 'properties' || key === '$defs') {
      if (value !== null && typeof value === 'object') {
        for (const [name, child] of Object.entries(value)) {
          assertGeminiSafeSchema(child, `${path}.${key}.${name}`);
        }
      }
      continue;
    }
    if (!GEMINI_SUPPORTED_KEYWORDS.has(key)) continue;
    assertGeminiSafeSchema(value, `${path}.${key}`);
  }
}

function sanitise(node: unknown, path: string, stripped: string[]): unknown {
  if (Array.isArray(node)) return node.map((entry, i) => sanitise(entry, `${path}[${i}]`, stripped));
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (GEMINI_IGNORED_KEYWORDS.has(key)) {
      stripped.push(`${path}.${key}`);
      continue;
    }
    if (key === 'properties' || key === '$defs') {
      const children: Record<string, unknown> = {};
      if (value !== null && typeof value === 'object') {
        for (const [name, child] of Object.entries(value)) {
          children[name] = sanitise(child, `${path}.${key}.${name}`, stripped);
        }
      }
      out[key] = children;
      continue;
    }
    out[key] = sanitise(value, `${path}.${key}`, stripped);
  }
  return out;
}

export function toGeminiSchema(zodSchema: ZodType): SanitisedSchema {
  // `io: 'output'` describes what the model must produce, which is the direction we care about.
  const converted = toJSONSchema(zodSchema, { io: 'output', target: 'draft-2020-12' });
  const stripped: string[] = [];
  const schema = sanitise(converted, '$', stripped) as Record<string, unknown>;

  // Belt and braces: the sanitiser and the guard must agree, so a future keyword added to one
  // list and not the other fails loudly here rather than silently in production.
  assertGeminiSafeSchema(schema);
  return { schema, stripped };
}

/** A stable hash input for cassette keys: same schema shape, same key. */
export function schemaFingerprint(zodSchema: ZodType): string {
  return JSON.stringify(toGeminiSchema(zodSchema).schema);
}
