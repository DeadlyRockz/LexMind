import type { ZodType } from 'zod';
import { ModelError, isModelError } from './errors.ts';
import { parseWithSchema } from './port.ts';

/**
 * Parse, and on failure repair exactly once — then fail closed.
 *
 * "Fail closed" is the important half. If a clause's analysis cannot be validated after one
 * repair attempt, LexMind shows "could not analyse this section" rather than a partially parsed
 * result. Someone is reading this as legal information about their home; a half-formed finding is
 * worse than an acknowledged gap.
 */
export interface RepairOutcome<T> {
  readonly value: T;
  readonly repaired: boolean;
}

export async function parseWithRepair<T>(
  schema: ZodType<T>,
  first: string,
  repair: (validationError: string) => Promise<string>,
): Promise<RepairOutcome<T>> {
  try {
    return { value: parseWithSchema(first, schema), repaired: false };
  } catch (error) {
    if (!isModelError(error) || error.code !== 'MALFORMED') throw error;

    let second: string;
    try {
      second = await repair(error.message);
    } catch (repairError) {
      throw isModelError(repairError)
        ? repairError
        : new ModelError('MALFORMED', 'The repair attempt failed.', { cause: repairError });
    }

    try {
      return { value: parseWithSchema(second, schema), repaired: true };
    } catch (secondError) {
      throw new ModelError(
        'MALFORMED',
        `The model returned unusable output twice: ${isModelError(secondError) ? secondError.message : String(secondError)}`,
        {
          retryable: false,
          userMessage:
            'LexMind could not analyse part of this document reliably, so it has left that section out rather than guess. The rule-based findings are unaffected.',
          cause: secondError,
        },
      );
    }
  }
}

/** The repair instruction. Feeds the validation error back rather than just asking again. */
export function repairInstruction(validationError: string): string {
  return [
    'Your previous response could not be used. The validation error was:',
    validationError,
    'Return only JSON matching the required schema. No prose, no markdown fences.',
  ].join('\n\n');
}
