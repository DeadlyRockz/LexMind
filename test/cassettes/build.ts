import { fileURLToPath } from 'node:url';
import {
  analyse,
  clausesToExplain,
  findEmbeddedInstructions,
} from '../../packages/core/src/analyse/pipeline.ts';
import { ingestPastedText } from '../../packages/core/src/ingest/index.ts';
import type { Cassette } from '../../packages/core/src/model/adapters/replay.ts';
import { ModelError } from '../../packages/core/src/model/errors.ts';
import {
  type JsonRequest,
  type JsonResult,
  type LlmPort,
  requestKey,
  type TextRequest,
} from '../../packages/core/src/model/port.ts';
import { verifyQuote } from '../../packages/core/src/qa/verify.ts';
import { overlapsAny } from '../../packages/core/src/safety/injection.ts';
import { type SegmentedDocument, segment } from '../../packages/core/src/segment/index.ts';
import { GOLDEN_LEASES, type LeaseAnnotation } from '../fixtures/leases.ts';
import { ADVERSARIAL_SCENARIOS, type AuthoredResponses, GOLDEN_RESPONSES } from './responses.ts';

/**
 * Builds the offline cassettes from the hand-authored responses in `responses.ts`.
 *
 * A cassette is keyed by `requestKey()` (`model/port.ts`): a SHA-256 over the tier, the task, the
 * assembled prompt and the schema fingerprint. The prompt a cassette must match is the one the
 * replay adapter actually receives, which is **after** `createGuardedPort` has redacted the
 * document and every clause excerpt. So keys are never computed by hand: `captureRequests` runs the
 * real `analyse()` with a port that records what reaches it and refuses to answer, and the key is
 * taken from exactly that request.
 *
 * Used twice, so the two can never disagree: by `scripts/cassettes.ts` to write the JSON files, and
 * by `test/cassette-e2e.test.ts` to prove the committed files are what this would write today.
 */

export const CASSETTE_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** Stamped into every cassette file, so nobody mistakes one for a recording. */
export const SYNTHETIC_PROVENANCE =
  'SYNTHETIC: hand-authored response written to the plan-06 plain-English target. NOT recorded ' +
  'from Gemini or any other model; no API key was used. Readability measured on it proves the ' +
  'measurement pipeline and a regression floor, not live-model quality.';

export const SYNTHETIC_MODEL = 'synthetic-hand-authored';

/** A replay cassette plus provenance. The adapter reads the `Cassette` fields and ignores the rest. */
export interface SyntheticCassette extends Cassette {
  readonly provenance: string;
  readonly scenario: string;
  readonly lease: string;
}

export interface CassetteFile {
  /** Relative to `CASSETTE_ROOT`: `golden`, or `adversarial/<scenario>`. */
  readonly directory: string;
  /** `<lease>.<task>.<first 12 hex of the key>.json` — a changed prompt reads as a changed name. */
  readonly fileName: string;
  readonly cassette: SyntheticCassette;
}

export const GOLDEN_DIRECTORY = 'golden';

export function scenarioDirectory(scenarioId: string): string {
  return `adversarial/${scenarioId}`;
}

/** The requests `analyse()` sends for a document, exactly as an adapter receives them. */
export async function captureRequests(
  segmented: SegmentedDocument,
): Promise<readonly JsonRequest<unknown>[]> {
  const requests: JsonRequest<unknown>[] = [];
  const refuse = (): ModelError =>
    new ModelError('NOT_CONFIGURED', 'capturing requests only', { retryable: false });

  const capture: LlmPort = {
    label: 'request capture',
    generateJson<T>(request: JsonRequest<T>): Promise<JsonResult<T>> {
      requests.push(request as JsonRequest<unknown>);
      return Promise.reject(refuse());
    },
    generateTextStream(_request: TextRequest): AsyncIterable<string> {
      throw refuse();
    },
    countTokens: (): Promise<number> => Promise.reject(refuse()),
  };

  // Every pass is attempted even when the one before it fails, so one run captures them all.
  await analyse(segmented, { port: capture });
  return requests;
}

function responseFor(task: string, authored: AuthoredResponses): unknown {
  if (task === 'explain-clauses') return { explanations: authored.explanations };
  if (task === 'summarise-lease') return { sections: authored.summary };
  throw new Error(`No authored response shape for task "${task}".`);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
}

/**
 * Refuse to build a cassette that would pass for the wrong reason.
 *
 * An explanation for a clause the pipeline never escalated is silently ignored, and a golden quote
 * that does not verify silently becomes a dropped explanation — either would leave a green test
 * measuring less than it claims. Adversarial scenarios skip only the quote check, on purpose.
 */
async function assertEscalationMatches(
  label: string,
  segmented: SegmentedDocument,
  authored: AuthoredResponses,
): Promise<void> {
  const deterministic = await analyse(segmented);
  const escalated = clausesToExplain(
    segmented.clauses,
    deterministic.findings,
    deterministic.typings,
    { embeddedInstructions: deterministic.embeddedInstructions },
  ).map((clause) => clause.id);
  const answered = authored.explanations.map((entry) => entry.clauseId);
  if (!sameIds(escalated, answered)) {
    throw new Error(
      `${label}: authored explanations cover [${answered.join(', ')}] but the pipeline escalates ` +
        `[${escalated.join(', ')}]. Update test/cassettes/responses.ts.`,
    );
  }
}

/**
 * A golden quote has to hold three times over: verbatim in the redacted document the model was sent
 * (a model can only copy what it saw), exactly against the original text (what the verifier checks),
 * and outside any embedded instruction (a quote from one verifies but can support no claim).
 */
function assertQuotesVerify(
  label: string,
  segmented: SegmentedDocument,
  authored: AuthoredResponses,
  modelSaw: string,
): void {
  const claims = [
    ...authored.explanations.map((entry) => ({ quote: entry.quote, clauseId: entry.clauseId })),
    ...authored.summary.map((section) => ({ quote: section.quote })),
  ];
  const embedded = findEmbeddedInstructions(segmented);
  for (const claim of claims) {
    const verified = verifyQuote(segmented, claim);
    if (!modelSaw.includes(claim.quote) || !('charStart' in verified)) {
      throw new Error(`${label}: authored quote is not in the lease: "${claim.quote}".`);
    }
    if (verified.matchKind !== 'exact') {
      throw new Error(`${label}: authored quote only matches after folding: "${claim.quote}".`);
    }
    if (overlapsAny(verified, embedded)) {
      throw new Error(
        `${label}: authored quote lies in an embedded instruction: "${claim.quote}".`,
      );
    }
  }
}

async function cassettesFor(
  lease: LeaseAnnotation,
  authored: AuthoredResponses,
  directory: string,
  scenario: string,
  checkQuotes: boolean,
): Promise<readonly CassetteFile[]> {
  const segmented = segment(ingestPastedText(lease.text));
  const requests = await captureRequests(segmented);
  await assertEscalationMatches(lease.id, segmented, authored);
  if (checkQuotes) {
    const modelSaw = requests.map((request) => request.document ?? '').join('\n');
    assertQuotesVerify(lease.id, segmented, authored, modelSaw);
  }

  return requests.map((request) => {
    const key = requestKey(request);
    const cassette: SyntheticCassette = {
      provenance: SYNTHETIC_PROVENANCE,
      scenario,
      lease: lease.id,
      key,
      task: request.task,
      tier: request.tier,
      model: SYNTHETIC_MODEL,
      response: JSON.stringify(responseFor(request.task, authored)),
    };
    return {
      directory,
      fileName: `${lease.id}.${request.task}.${key.slice(0, 12)}.json`,
      cassette,
    };
  });
}

function leaseById(id: string): LeaseAnnotation {
  const lease = GOLDEN_LEASES.find((candidate) => candidate.id === id);
  if (lease === undefined) throw new Error(`No golden lease "${id}".`);
  return lease;
}

/** Every cassette file, golden and adversarial, in a stable order. */
export async function buildCassetteFiles(): Promise<readonly CassetteFile[]> {
  const files: CassetteFile[] = [];

  for (const lease of GOLDEN_LEASES) {
    const authored = GOLDEN_RESPONSES[lease.id];
    if (authored === undefined) throw new Error(`No authored responses for "${lease.id}".`);
    files.push(...(await cassettesFor(lease, authored, GOLDEN_DIRECTORY, 'golden', true)));
  }

  for (const scenario of ADVERSARIAL_SCENARIOS) {
    const lease = leaseById(scenario.leaseId);
    files.push(
      ...(await cassettesFor(
        lease,
        scenario.responses,
        scenarioDirectory(scenario.id),
        scenario.id,
        false,
      )),
    );
  }

  return files;
}

/** The on-disk form: two-space JSON with a trailing newline, as the formatter leaves it. */
export function serialiseCassette(cassette: SyntheticCassette): string {
  return `${JSON.stringify(cassette, null, 2)}\n`;
}
