import { ANSWERABLE_OVERRIDES, CROSSING_RULES, type CrossingKind } from '../domain/advice-boundary.ts';
import { collapseWhitespace } from '../util/text.ts';

/**
 * The information / advice boundary, enforced on the *request* rather than only on the output.
 *
 * Two failure modes matter equally here, and only one of them is obvious.
 *
 * Over-advising is the obvious one. The regulated act is applying law to a particular person's
 * facts and recommending a course of action, and a tool that does it is practising law.
 *
 * **Over-refusing is the other, and it is just as much a failure.** A classifier tuned tight
 * enough to refuse "what does this clause mean?" has destroyed the product it was protecting. So
 * the answerable overrides are checked *first*, the refusal fixture set carries both positive and
 * negative cases, and a false refusal is a failing test rather than a safe default.
 *
 * A refusal always redirects. Phase 09's lawyer-prep pack exists precisely so that "should I sign
 * this?" has a genuinely useful answer that is not advice — a pack of the clauses that need
 * professional review, the questions to ask, and the facts a lawyer would otherwise charge to
 * extract. A refusal that leaves the reader stuck fails them as surely as over-advising does.
 */

export interface AnswerableDecision {
  readonly kind: 'answerable';
}

export interface RefusedDecision {
  readonly kind: 'refused';
  readonly crossing: CrossingKind;
  readonly label: string;
  /** Why, in the words shown to the reader. */
  readonly because: string;
  /** What LexMind offers instead. Never a bare "I can't help with that". */
  readonly redirect: readonly string[];
  /** The phrase that triggered it, so the UI can be specific and the behaviour is debuggable. */
  readonly matched: string;
}

export type BoundaryDecision = AnswerableDecision | RefusedDecision;

const REDIRECTS: Readonly<Record<CrossingKind, readonly string[]>> = {
  'recommend-course-of-action': [
    'LexMind can list every clause that a professional should look at, with the exact words and where they appear.',
    'It can build a lawyer-prep pack: the questions to ask, the facts a lawyer would otherwise charge to extract, and what to bring.',
    'It can tell you what each clause says and where it is one-sided, so the decision is yours to make with better information.',
  ],
  'apply-law-to-facts': [
    'LexMind can tell you what your document says on this point, word for word.',
    'It can show the general rule for the jurisdiction it detected, with the provision it comes from and a note on how confident that detection is.',
    'Whether it binds you, on your facts, is a question for a lawyer — and the lawyer-prep pack is built to make that conversation short.',
  ],
  'predict-outcome': [
    'No tool can tell you what a court, tribunal or landlord will decide, and a confident guess would be worse than no answer.',
    'LexMind can set out what the document provides, and which clauses commonly need professional review.',
    'The resources list for your jurisdiction includes free legal-aid services that can assess your position.',
  ],
  'draft-or-select-document': [
    'LexMind does not draft binding documents. What it can do is tell you exactly what yours says.',
    'It can generate a lawyer-prep pack and a list of questions, which is often what a drafting request is really for.',
    'Your jurisdiction resources include legal-aid services that draft documents at no cost.',
  ],
};

function normalise(question: string): string {
  return collapseWhitespace(question.toLowerCase()).replace(/[?!.]+$/g, '');
}

/**
 * Classify a request.
 *
 * The Judicial Council of California's "May I Help You?" guidance for court staff is the test
 * encoded here, because it is court-published and literally string-level: *"Can I?"* and
 * *"How do I?"* are answerable — telling someone how to do something is almost always
 * appropriate — while *"Should I?"* signals a request for advice.
 */
export function classifyRequest(question: string): BoundaryDecision {
  const text = normalise(question);
  if (text.length === 0) return { kind: 'answerable' };

  // Comprehension questions win outright. This ordering is the whole over-refusal defence.
  const override = ANSWERABLE_OVERRIDES.find((phrase) => text.startsWith(phrase));
  if (override !== undefined) return { kind: 'answerable' };

  for (const rule of CROSSING_RULES) {
    const matched =
      rule.cues.find((cue) => text.includes(cue)) ??
      rule.patterns?.find((pattern) => pattern.test(text))?.source;
    if (matched === undefined) continue;
    return {
      kind: 'refused',
      crossing: rule.kind,
      label: rule.label,
      because: rule.because,
      redirect: REDIRECTS[rule.kind],
      matched,
    };
  }

  return { kind: 'answerable' };
}

/** The refusal as prose, for the CLI and for the exported outputs. */
export function refusalText(decision: RefusedDecision): string {
  return [
    `LexMind does not answer this one: ${decision.label.toLowerCase()}.`,
    decision.because,
    '',
    'What it can do instead:',
    ...decision.redirect.map((line) => `  - ${line}`),
  ].join('\n');
}

/**
 * A guard on generated output, for the case where the model drifts into advice despite the system
 * instruction. Output-side only — the request-side classifier above is the primary control.
 */
const ADVICE_PHRASES: readonly string[] = [
  'you should',
  'i recommend',
  'we recommend',
  'my advice',
  'you must refuse',
  'do not sign',
  "don't sign",
  'you ought to',
  'i would advise',
  'refuse to sign',
  'demand that',
  'you will win',
  'you will lose',
  'the court will',
  'is unenforceable against you',
];

export function findAdvicePhrases(text: string): readonly string[] {
  const lower = text.toLowerCase();
  return ADVICE_PHRASES.filter((phrase) => lower.includes(phrase));
}
