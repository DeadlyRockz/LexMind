/**
 * The information / advice line, encoded as data.
 *
 * The regulated act is *applying law to a particular person's facts and recommending a course of
 * action*. The Judicial Council of California's "May I Help You?" guidance for court staff reduces
 * that to a string-level heuristic, which is why it is usable in code:
 *
 *   "Most of these questions contain the words 'Can I?' or 'How do I?' Telling someone how to do
 *    something is almost always appropriate."
 *   "Most of the questions that ask whether to take a particular course of action contain the
 *    words 'Should I?' So whenever you hear the word 'should,' the court user may be asking for
 *    advice that you cannot provide."
 *
 * `safety/boundary.ts` consumes these tables. Keeping them here, as data, is what lets the
 * classifier be unit-tested against both positive and negative cases — over-refusal is a test
 * failure, not a safe default.
 */

export type CrossingKind =
  | 'apply-law-to-facts'
  | 'recommend-course-of-action'
  | 'draft-or-select-document'
  | 'predict-outcome';

export interface CrossingRule {
  readonly kind: CrossingKind;
  readonly label: string;
  /** Why this is over the line, in the words shown to the reader. */
  readonly because: string;
  /** Phrases that indicate the request is asking for this. */
  readonly cues: readonly string[];
  /**
   * Patterns, for the cases a fixed phrase cannot reach. "Is this clause enforceable against me?"
   * and "is clause 4 enforceable in my state?" are the same request with different words in the
   * middle, and enumerating every middle is how a cue list becomes unmaintainable.
   */
  readonly patterns?: readonly RegExp[];
}

/** The four behaviours that cross from legal information into legal advice. */
export const CROSSING_RULES: readonly CrossingRule[] = [
  {
    kind: 'recommend-course-of-action',
    label: 'Recommending what to do',
    because:
      'Choosing between courses of action for your situation is advice, which a lawyer gives and LexMind does not.',
    cues: [
      'should i',
      'should we',
      'shall i',
      'do you recommend',
      'what would you do',
      'is it a good idea',
      'is it wise',
      'ought i',
      'must i sign',
      'advise me',
      'your advice',
      'what should',
      'better to sign',
      'am i better off',
    ],
  },
  {
    kind: 'apply-law-to-facts',
    label: 'Applying the law to your particular facts',
    because:
      'Whether a clause binds you, on your facts, depends on evidence and local law that LexMind has not seen and cannot weigh.',
    cues: [
      'is this enforceable',
      'is this legal in my',
      'is it enforceable against me',
      'can they enforce this against me',
      'do i have to pay',
      'am i liable',
      'am i obligated',
      'in my case',
      'in my situation',
      'my landlord did',
      'can they legally',
      'is this binding on me',
    ],
    patterns: [
      // "enforceable" asked *about the reader* rather than as a definition. A definition question
      // starts "what does", which the answerable overrides catch first.
      /\benforceable\b.*\b(?:against|for|on)\s+(?:me|us|my|our)\b/,
      /\b(?:is|are|was|would)\b[^?]*\bclause\b[^?]*\benforceable\b/,
      /\benforceable\b[^?]*\b(?:in|under)\s+my\b/,
      /\bdo\s+i\s+(?:have\s+to|need\s+to|owe)\b/,
    ],
  },
  {
    kind: 'predict-outcome',
    label: 'Predicting an outcome',
    because:
      'LexMind never predicts what a court, tribunal or landlord will do. No tool can, and a confident guess here is worse than no answer.',
    cues: [
      'will i win',
      'will i lose',
      'would i win',
      'chances of winning',
      'my odds',
      'will the court',
      'will a judge',
      'will the tribunal',
      'how much will i get',
      'will they evict me',
      'can i be evicted',
      'will i be evicted',
    ],
  },
  {
    kind: 'draft-or-select-document',
    label: 'Drafting a document for you',
    because:
      'Drafting or selecting a binding document for your circumstances is legal work. LexMind can tell you what yours says, and help you prepare questions for a professional.',
    cues: [
      'draft a',
      'draft me',
      'write a notice',
      'write me a letter',
      'write a legal notice',
      'prepare a notice',
      'prepare a legal',
      'file a case',
      'file a suit',
      'draft an agreement',
      'write the termination',
      'generate a notice',
    ],
    patterns: [
      // "write me a legal notice" and "draft a termination notice" are the same request with a
      // different word in between, which is exactly what a fixed phrase list cannot cover.
      /\b(?:write|draft|prepare|generate|compose)\b[^?]{0,24}\b(?:notice|letter|agreement|lease|complaint|petition|application|affidavit|contract)\b/,
    ],
  },
];

/**
 * Phrases that look like a crossing but are ordinary comprehension questions. Checked first: a
 * classifier that refuses "what does this clause mean?" has destroyed the product.
 */
export const ANSWERABLE_OVERRIDES: readonly string[] = [
  'what does',
  'what do',
  'what is',
  'what are',
  'what happens',
  'how do i',
  'how can i',
  'how does',
  'how much does this',
  'can i ask',
  'where does',
  'which clause',
  'does the lease',
  'does my lease',
  'does this lease',
  'does the agreement',
  'explain',
  'summarise',
  'summarize',
  'list the',
  'show me the',
  'when is',
  'when does',
  'who is responsible',
  'who pays',
];

/** Things LexMind never does, stated positively for the README and the UI. */
export const NEVER_RULES: readonly string[] = [
  'Never predicts what a court, tribunal or landlord will decide.',
  'Never states whether a clause is enforceable against you on your facts.',
  'Never drafts or selects a binding document for you.',
  'Never recommends a course of action.',
  'Never names a private lawyer or firm. Bar association and legal-aid directories only.',
  'Never presents a model act as the law where you live.',
];
