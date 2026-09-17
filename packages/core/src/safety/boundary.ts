import {
  ANSWERABLE_OVERRIDES,
  CROSSING_RULES,
  type CrossingKind,
} from '../domain/advice-boundary.ts';
import { collapseWhitespace, foldPunctuation } from '../util/text.ts';

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
 *
 * Scan the model's **own prose only**, never a quote it copied out of the document. A lease is
 * perfectly capable of containing "you should" or "demand that" in its own words, and dropping an
 * explanation because the *document* gives an instruction would be an over-refusal caused by the
 * very text we are trying to explain.
 *
 * The list is deliberately blunt, and that costs some precision: "the landlord may demand that you
 * vacate" is a faithful restatement that this scanner will nonetheless flag. That trade is made
 * knowingly. The cost of a false positive is one clause explained by the deterministic layer alone
 * — which is the product's floor and is still shown; the cost of a false negative is LexMind
 * telling a tenant what to do, which is the one thing the whole design exists to prevent. Fail
 * closed, and say so to the reader rather than dropping it silently.
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

const LEASE_SUBJECT = String.raw`(?:this|the|your)\s+(?:(?:rental|tenancy|lease)\s+)?(?:lease|agreement|contract|tenancy|document|deal)`;
const PROVISION_SUBJECT = String.raw`(?:this|that|the|each|every)\s+(?:[a-z-]+\s+)?(?:clause|term|provision|condition)s?`;
const INTENSIFIERS = String.raw`(?:(?:completely|totally|perfectly|entirely|fully|very|quite|really|generally|overall|legally|absolutely|reasonably|basically|pretty)\s+){0,2}`;
/** "Valid for twelve months" and "good until March" state a duration, not a verdict. */
const NOT_A_DURATION = String.raw`(?!\s+(?:for|until|till|from|through)\b)`;

/**
 * Verdicts, which are advice with the "you should" taken out.
 *
 * The Judicial Council of California's test (see `classifyRequest`) sorts *questions*: "Can I?"
 * and "How do I?" ask for information, "Should I?" asks for advice. A verdict is the answer to the
 * "Should I?" question, stated as a fact about the document — "this lease is safe to sign", "there
 * are no risks in this agreement" — so it crosses the same line while using none of the phrases
 * above. It is also exactly what an obeyed prompt injection produces: the planted instruction in
 * the adversarial cassette asks for "completely fair" and "no risks", not for "you should".
 *
 * Every pattern is anchored on a *judgement* of the whole agreement, the reader's decision, or a
 * provision's legal status. Describing a term stays untouched, however reassuring the term is:
 * "this clause says the deposit is refundable" reports the document, and "the lease does not list a
 * late fee" is the absence answer the system preamble asks for. The negative cases in
 * `output-guard.test.ts` pin that.
 *
 * Matched against lower-cased, punctuation-folded, whitespace-collapsed prose, so no pattern needs
 * the `i` flag, and none is global, so `exec` carries no state between calls.
 */
const VERDICT_PATTERNS: readonly RegExp[] = [
  // A verdict on the agreement: "this lease is completely fair", "your contract is not legal".
  new RegExp(
    String.raw`\b${LEASE_SUBJECT}\s+(?:is|looks|seems|appears|remains)\s+(?:to\s+be\s+)?(?:not\s+)?${INTENSIFIERS}(?:(?:safe|unsafe|fair|unfair|legal|illegal|lawful|unlawful|enforceable|unenforceable|invalid|void|risk-free|risky|harmless|acceptable|reasonable|unreasonable|fine|ok|okay|bad)\b|(?:valid|good)\b${NOT_A_DURATION})`,
  ),
  // The same verdict with the adjective first: "this is a fair lease", "looks like a good deal".
  new RegExp(
    String.raw`\b(?:is|looks\s+like|seems\s+like|appears\s+to\s+be)\s+(?:a|an)\s+${INTENSIFIERS}(?:safe|fair|good|great|legal|valid|balanced|reasonable|bad|unfair|risky)\s+(?:lease|agreement|contract|deal|tenancy)\b`,
  ),
  // The legal status of a provision, which the system preamble forbids the model to state.
  new RegExp(
    String.raw`\b${PROVISION_SUBJECT}\s+(?:is|are)\s+(?:not\s+)?${INTENSIFIERS}(?:(?:legal|illegal|lawful|unlawful|enforceable|unenforceable|invalid|void)\b|valid\b${NOT_A_DURATION})`,
  ),
  // An assurance of no risk: "there are no risks", "has no hidden traps", "risk-free".
  /\b(?:there\s+(?:are|is)|contains?|has|have|carr(?:y|ies)|poses?|with)\s+no\s+(?:[a-z-]+\s+)?(?:risks?|red\s+flags|dangers|downsides|hidden\s+(?:traps|catches))\b|\brisk[\s-]free\b/,
  // Reassurance: "nothing to worry about", "you are fully protected".
  /\bnothing\s+(?:here\s+)?to\s+(?:worry|be\s+(?:worried|concerned)|fear)\b|\bno\s+(?:need|reason)\s+to\s+(?:worry|be\s+(?:worried|concerned))\b|\byou\s+(?:are|will\s+be)\s+(?:fully\s+|completely\s+)?(?:protected|safe)\b/,
  // The decision itself: "safe to sign", "you can safely sign", "I wouldn't sign", "sign it now".
  /\b(?:safe|fine|ok|okay|good|wise|advisable)\s+to\s+sign\b|\b(?:go\s+ahead\s+and|can\s+safely|may\s+safely|should|shouldn't|i\s+would|i\s+wouldn't)\s+(?:not\s+)?sign\b|\bsign\s+(?:it|this|the\s+lease)\s+(?:immediately|now|right\s+away|without\s+worry)\b|\bworth\s+signing\b/,
];

/**
 * Every advice phrase or verdict in a piece of generated prose, as the words that matched.
 *
 * The prose is folded before matching — curly apostrophes to straight, dashes to hyphens, runs of
 * whitespace to one space — so "Don’t sign" and "risk‑free" are caught exactly as their ASCII
 * spellings are. A guard that a typographic apostrophe walks past is not a guard.
 */
export function findAdvicePhrases(text: string): readonly string[] {
  const folded = collapseWhitespace(foldPunctuation(text).toLowerCase());
  const phrases = ADVICE_PHRASES.filter((phrase) => folded.includes(phrase));
  const verdicts = VERDICT_PATTERNS.flatMap((pattern) => {
    const match = pattern.exec(folded);
    return match === null ? [] : [match[0]];
  });
  return [...phrases, ...verdicts];
}

/**
 * What the reader is told when generated prose was withheld for crossing the boundary.
 *
 * A bare "some content was removed" would be the output-side equivalent of a flat refusal, and
 * plan 05 is explicit that a refusal which leaves the reader stuck fails them as surely as
 * over-advising does. So the note says what happened, why, and what LexMind does instead — the
 * same redirect the request-side classifier gives, because it is the same boundary.
 */
export function adviceWithheldNote(count: number): string {
  if (count <= 0) return '';
  const subject = count === 1 ? 'One AI-written passage' : `${count} AI-written passages`;
  const verb = count === 1 ? 'was' : 'were';
  return [
    `${subject} drifted into telling you what to do or what to make of the agreement, so ${verb} withheld. LexMind gives legal information, not legal advice.`,
    'What it can do instead:',
    ...REDIRECTS['recommend-course-of-action'].map((line) => `  - ${line}`),
  ].join('\n');
}
