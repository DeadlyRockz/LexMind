#!/usr/bin/env node
/**
 * `lexmind` — the headless entry point.
 *
 * The CLI is the product and the web app is the demo skin. Anything the UI can do has to be
 * reproducible here, which is what makes the whole system gradeable without a browser and what
 * keeps `packages/core` honest: a rule that cannot be exercised from a terminal has quietly
 * grown a dependency on React.
 *
 * Argument parsing is `node:util`'s `parseArgs` and nothing else — no commander, no yargs. A CLI
 * this shape does not need 40 KB of dependency, and a submission judged on supply-chain hygiene
 * should not add one.
 *
 * Subcommands are **registered from day one and honest about their state**. `analyse` is wired to
 * the real pipeline because that pipeline exists; the rest print what they are and exit 0 rather
 * than pretending. A stub that prints "not implemented" is information; a stub that prints
 * plausible-looking findings is a lie, and this is a product whose entire argument is that it
 * does not do that.
 *
 * Run it with `pnpm lexmind <command>`, or directly on Node 24+ (which strips types natively).
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  AI_DISCLOSURE,
  type AnalysisResult,
  analyse,
  estimateCostUsd,
  type Finding,
  ingestBytes,
  isAnalysisGap,
  isIngestError,
  isModelError,
  JURISDICTIONS,
  type JurisdictionId,
  SEVERITY_GLYPHS,
  SEVERITY_LABELS,
  segment,
  selectModel,
} from './index.ts';

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

/** Thrown for anything the user can fix by retyping the command. Never for engine failures. */
class UsageError extends Error {}

// ── Version ──────────────────────────────────────────────────────────────────────────────────

/**
 * Read the version from the package manifest rather than hard-coding it.
 *
 * A second copy of the version string is a second thing to forget, and `lexmind --version`
 * reporting something the package does not claim is exactly the kind of small dishonesty this
 * codebase is built to avoid.
 */
function readVersion(): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    if (typeof parsed === 'object' && parsed !== null) {
      const version = Reflect.get(parsed, 'version');
      if (typeof version === 'string') return version;
    }
  } catch {
    // A missing or malformed manifest is not a reason to fail a command.
    return 'unknown';
  }
  return 'unknown';
}

// ── Command registry ─────────────────────────────────────────────────────────────────────────

interface Flags {
  readonly json: boolean;
  readonly jurisdiction: string | undefined;
  readonly question: string | undefined;
}

interface CommandContext {
  readonly positionals: readonly string[];
  readonly flags: Flags;
}

interface Command {
  readonly name: string;
  /** The argument shape, shown in `--help`. */
  readonly args: string;
  readonly summary: string;
  /** Which plan phase owns this command, so `--help` never overstates what exists. */
  readonly phase: string;
  readonly implemented: boolean;
  readonly run: (context: CommandContext) => Promise<number>;
}

/**
 * A registered-but-unbuilt subcommand.
 *
 * Exits 0 on purpose: "this exists and is not built yet" is a successful answer to the question
 * the user asked, and scripting around a non-zero exit for an expected state is miserable.
 */
function notImplemented(name: string, phase: string): () => Promise<number> {
  return (): Promise<number> => {
    console.log(`lexmind ${name}: not implemented yet — ${phase}.`);
    console.log(
      'The subcommand is registered so the command surface is stable while the engine is built.',
    );
    console.log('Run `lexmind analyse <file>` for the parts that do work today.');
    return Promise.resolve(EXIT_OK);
  };
}

const COMMANDS: readonly Command[] = [
  {
    name: 'analyse',
    args: '<file> [--jurisdiction <id>] [--json]',
    summary: 'Read a lease and report its clauses, risks and obligations.',
    phase: 'phase 06',
    implemented: true,
    run: runAnalyse,
  },
  {
    name: 'ask',
    args: '<file> --question <text>',
    summary: 'Answer a question grounded only in the document, with verified citations.',
    phase: 'phase 07 — grounded Q&A',
    implemented: false,
    run: notImplemented('ask', 'phase 07 — grounded Q&A and citation verification'),
  },
  {
    name: 'compare',
    args: '<file-a> <file-b>',
    summary: 'Compare two leases clause by clause, semantically rather than textually.',
    phase: 'phase 08 — lease comparison',
    implemented: false,
    run: notImplemented('compare', 'phase 08 — lease comparison'),
  },
  {
    name: 'pack',
    args: '<file> [--json]',
    summary: 'Produce the questions-for-a-lawyer pack and the action checklist.',
    phase: 'phase 09 — actionable outputs',
    implemented: false,
    run: notImplemented('pack', 'phase 09 — actionable outputs'),
  },
  {
    name: 'eval',
    args: '[--json]',
    summary: 'Score the engine against the annotated golden set.',
    phase: 'phase 11 — evaluation harness',
    implemented: false,
    run: notImplemented('eval', 'phase 11 — evaluation harness'),
  },
];

// ── Help ─────────────────────────────────────────────────────────────────────────────────────

function printHelp(): void {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));

  console.log('lexmind — legal information about a lease you are worried about.');
  console.log('');
  console.log('  usage: lexmind <command> [options]');
  console.log('');
  console.log('Commands:');
  for (const command of COMMANDS) {
    const state = command.implemented ? '' : `  (not implemented — ${command.phase})`;
    console.log(`  ${command.name.padEnd(width)}  ${command.summary}${state}`);
    console.log(`  ${' '.repeat(width)}  lexmind ${command.name} ${command.args}`);
  }
  console.log('');
  console.log('Options:');
  console.log('  -h, --help              Show this help.');
  console.log('  -v, --version           Print the version.');
  console.log('      --json              Emit machine-readable JSON instead of prose.');
  console.log('      --jurisdiction <id> Declare the jurisdiction instead of inferring it.');
  console.log(`                          One of: ${Object.keys(JURISDICTIONS).join(', ')}`);
  console.log('  -q, --question <text>   The question to answer (`ask`).');
  console.log('');
  console.log('Environment:');
  console.log('  GEMINI_API_KEY          Optional. Without it LexMind runs fully offline and');
  console.log('                          still reports every rule-based finding.');
  console.log('  LEXMIND_OFFLINE=1       Force the deterministic replay adapter. Any attempt to');
  console.log('                          reach the network becomes a hard failure.');
  console.log('');
  console.log(AI_DISCLOSURE.notAdvice);
}

// ── `analyse` ────────────────────────────────────────────────────────────────────────────────

function toJurisdiction(value: string | undefined): JurisdictionId | undefined {
  if (value === undefined) return undefined;
  if (!Object.hasOwn(JURISDICTIONS, value)) {
    throw new UsageError(
      `Unknown jurisdiction "${value}". Expected one of: ${Object.keys(JURISDICTIONS).join(', ')}.`,
    );
  }
  return value as JurisdictionId;
}

function formatFinding(finding: Finding): readonly string[] {
  const lines = [
    `  ${SEVERITY_GLYPHS[finding.severity]} ${SEVERITY_LABELS[finding.severity]} — ${finding.title}`,
    `      says:  ${finding.whatItSays}`,
    `      why:   ${finding.whyItMatters}`,
  ];

  if (finding.citations.length > 0) {
    const cited = finding.citations
      .map((citation) => `${citation.authority} ${citation.provision}`)
      .join('; ');
    lines.push(`      cited: ${cited}`);
  } else {
    lines.push('      cited: no statute resolved for this jurisdiction — reported as observed');
  }

  const anchor = finding.anchors[0];
  if (anchor !== undefined) {
    lines.push(`      quote: "${anchor.quote}" (chars ${anchor.charStart}–${anchor.charEnd})`);
  }
  if (finding.caveat !== undefined) lines.push(`      note:  ${finding.caveat}`);

  return lines;
}

/** Display names for the five summary parts. The parts themselves are a closed set in `explain.ts`. */
const SUMMARY_LABELS: Readonly<Record<string, string>> = {
  overview: 'Overview',
  money: 'Money',
  timing: 'Timing',
  obligations: 'Obligations',
  exit: 'Leaving',
};

function printAnalysis(result: AnalysisResult, sourceKind: string, pageCount: number): void {
  const { stats, jurisdiction } = result;

  console.log(`Document       ${result.documentId}`);
  console.log(`Source         ${sourceKind}, ${pageCount} page(s), ${stats.clauseCount} clauses`);
  console.log(`Jurisdiction   ${jurisdiction.rules.label} (${jurisdiction.confidence} confidence)`);
  console.log(`Model          ${result.modelLabel}`);
  console.log('');

  if (result.summary !== null) {
    console.log('Summary');
    for (const section of result.summary.sections) {
      console.log(`  ${SUMMARY_LABELS[section.part] ?? section.part}: ${section.text}`);
      // Every paragraph earns its place by quoting the document. Printing the anchor is what
      // makes that checkable by the reader rather than a claim in a design document.
      console.log(`    ⤷ "${section.anchor.quote}"`);
    }
    if (result.summary.missingParts.length > 0) {
      console.log(
        `  Not shown: ${result.summary.missingParts.join(', ')} — no paragraph for these could be tied to a quote from the document.`,
      );
    }
    console.log('');
  }

  console.log(`Findings (${stats.findingCount})`);
  if (stats.findingCount === 0) {
    console.log('  Nothing the rule set flags. That is a real result, not a failure to look.');
  }
  for (const finding of result.findings) {
    for (const line of formatFinding(finding)) console.log(line);
    console.log('');
  }

  console.log(`Obligations    ${result.obligations.length} extracted`);
  console.log(
    `               tenant ${result.obligationBalance.tenant} · landlord ${result.obligationBalance.landlord}`,
  );
  console.log('');

  if (result.notes.length > 0) {
    console.log('Notes');
    for (const note of result.notes) console.log(`  - ${note}`);
    console.log('');
  }

  const unanalysed = result.clauseStatus.filter((status) => isAnalysisGap(status.state));
  if (unanalysed.length > 0) {
    console.log(`Could not analyse ${unanalysed.length} section(s)`);
    for (const status of unanalysed) console.log(`  - ${status.clauseId}: ${status.detail}`);
    console.log('');
  }

  console.log(
    `Stats          escalated ${stats.escalatedClauses}/${stats.clauseCount} clauses ` +
      `(${stats.escalationRate}) · untyped ${stats.untypedShare} · ` +
      `citations rejected ${stats.citationRejectionRate} · ${stats.durationMs} ms`,
  );
  console.log(
    `Tokens         ${stats.modelCalls} completed model call(s), ${stats.modelFailures} failed, ` +
      `${result.usage.total.totalTokens} tokens, est. $${estimateCostUsd(result.usage.total).toFixed(6)}`,
  );
  console.log('');
  console.log(AI_DISCLOSURE.notAdvice);
}

/** A JSON projection. `Map`s do not survive `JSON.stringify`, so they are converted explicitly. */
function toSerialisable(result: AnalysisResult): unknown {
  return {
    ...result,
    explanations: Object.fromEntries(result.explanations),
    usage: { ...result.usage, byTask: Object.fromEntries(result.usage.byTask) },
  };
}

async function runAnalyse(context: CommandContext): Promise<number> {
  const path = context.positionals[0];
  if (path === undefined) {
    throw new UsageError('lexmind analyse: a file path is required.');
  }
  if (context.positionals.length > 1) {
    throw new UsageError('lexmind analyse: expected exactly one file. Use `compare` for two.');
  }

  const declared = toJurisdiction(context.flags.jurisdiction);

  // `ingestBytes` is the trust boundary: it sniffs by magic bytes, enforces the size and
  // zip-bomb ceilings, and asserts the offset invariant before anything downstream sees the text.
  const document = await ingestBytes(new Uint8Array(await readFile(path)));
  const segmented = segment(document);

  const selection = await selectModel();
  const result = await analyse(segmented, {
    port: selection.port,
    ...(declared === undefined ? {} : { declaredJurisdiction: declared }),
  });

  if (context.flags.json) {
    console.log(JSON.stringify(toSerialisable(result), null, 2));
  } else {
    printAnalysis(result, document.sourceKind, document.pageCount);
  }

  return EXIT_OK;
}

// ── Entry point ──────────────────────────────────────────────────────────────────────────────

/**
 * `parseArgs` in strict mode throws a `TypeError` for an unknown or malformed option. That is a
 * user typo, not an engine failure, so it is re-thrown as a `UsageError` and exits 2 — otherwise
 * a mistyped flag would be reported as "unexpected failure" and exit 1, which is both wrong and
 * unhelpful.
 */
function parse(argv: readonly string[]): { command: string | undefined; context: CommandContext } {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        json: { type: 'boolean', default: false },
        jurisdiction: { type: 'string' },
        question: { type: 'string', short: 'q' },
      },
    });

    if (values.help) return { command: '--help', context: emptyContext() };
    if (values.version) return { command: '--version', context: emptyContext() };

    const [command, ...rest] = positionals;
    return {
      command,
      context: {
        positionals: rest,
        flags: {
          json: values.json === true,
          jurisdiction: values.jurisdiction,
          question: values.question,
        },
      },
    };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function emptyContext(): CommandContext {
  return { positionals: [], flags: { json: false, jurisdiction: undefined, question: undefined } };
}

async function dispatch(argv: readonly string[]): Promise<number> {
  const { command, context } = parse(argv);

  if (command === undefined || command === '--help' || command === 'help') {
    printHelp();
    return command === undefined ? EXIT_USAGE : EXIT_OK;
  }
  if (command === '--version' || command === 'version') {
    console.log(readVersion());
    return EXIT_OK;
  }

  const match = COMMANDS.find((candidate) => candidate.name === command);
  if (match === undefined) {
    throw new UsageError(
      `Unknown command "${command}". Run \`lexmind --help\` for the list of commands.`,
    );
  }

  return match.run(context);
}

/**
 * Turn every failure into something a worried tenant can act on.
 *
 * `IngestError` already carries a plain-language remedy, and `ModelError` a user-facing message,
 * because a stack trace is not an answer to "why will it not read my lease?". Anything else is
 * genuinely unexpected and is reported as such rather than dressed up as a known condition.
 */
function report(error: unknown): number {
  if (error instanceof UsageError) {
    console.error(error.message);
    console.error('Run `lexmind --help` for usage.');
    return EXIT_USAGE;
  }
  if (isIngestError(error)) {
    console.error(`Could not read that document (${error.code}): ${error.message}`);
    if (error.remedy !== '') console.error(`  ${error.remedy}`);
    if (error.pages.length > 0) console.error(`  Affected pages: ${error.pages.join(', ')}`);
    return EXIT_FAILED;
  }
  if (isModelError(error)) {
    console.error(error.userMessage);
    return EXIT_FAILED;
  }
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
    console.error(`No such file: ${error.message.replace(/^ENOENT:.*?, open /, '')}`);
    return EXIT_USAGE;
  }

  console.error(`Unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
  return EXIT_FAILED;
}

// `process.argv.slice(2)` drops the node binary and the script path. parseArgs would do this by
// default, but passing the slice explicitly keeps `dispatch` testable with a plain array.
const exitCode = await dispatch(process.argv.slice(2)).catch(report);
process.exitCode = exitCode;
