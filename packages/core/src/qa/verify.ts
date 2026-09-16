import type { ClaimedQuote, VerifiedQuote } from '../domain/types.ts';
import { clauseAtOffset } from '../segment/clauses.ts';
import type { SegmentedDocument } from '../segment/index.ts';
import { locateQuote, MIN_QUOTE_CHARS, pinQuote } from '../segment/locate.ts';
import { normalizeForMatch } from '../util/text.ts';

/**
 * The citation verifier.
 *
 * The model returns a claim and a quote; **TypeScript then asserts the quote exists in the source
 * document.** If it does not verify, the citation is dropped. If an answer has no surviving
 * citation, the answer is not shown. Fail closed, every time.
 *
 * Why verification rather than trust, stated in numbers because the numbers are the argument.
 * Purpose-built legal AI over curated proprietary corpora — Lexis+ AI, Westlaw AI-Assisted
 * Research — hallucinates 17 to 33 per cent of the time; general models answering legal questions
 * do far worse, and they are worse still on lower courts, which are exactly the courts ordinary
 * people meet. The ALCE benchmark found that even the best models lack complete citation support
 * around half the time on long-form answers. A tool reading one uploaded PDF has no basis for
 * assuming it does better, so the design assumes worse and checks.
 *
 * The architectural luck worth exploiting: because LexMind's entire corpus is one uploaded
 * document, citation verification is a **substring check** rather than a retrieval problem. That
 * is a genuine advantage over a legal-research tool, and this file is where it is spent.
 *
 * Grounding is also an injection control. Requiring a verbatim quote that exists in the document
 * bounds what an injected instruction can achieve: it can try to change the narration, but it
 * cannot manufacture a quotation that passes a substring check against the original text.
 */

export type RejectionReason = 'not-found' | 'ambiguous' | 'too-short' | 'empty';

export interface RejectedQuote {
  readonly quote: string;
  readonly reason: RejectionReason;
  readonly claimedClauseId?: string;
}

export interface VerificationResult {
  readonly verified: readonly VerifiedQuote[];
  readonly rejected: readonly RejectedQuote[];
}

export const EMPTY_VERIFICATION: VerificationResult = { verified: [], rejected: [] };

/**
 * Verify one claimed quote.
 *
 * Deliberately *not* implemented with an edit-distance threshold. A fuzzy match manufactures
 * citations that look verified and are not, which is strictly worse than no citation: the reader
 * sees a quotation mark and a clause reference and reasonably concludes the document says
 * something it does not.
 */
export function verifyQuote(
  segmented: SegmentedDocument,
  claim: ClaimedQuote,
): VerifiedQuote | RejectedQuote {
  const quote = claim.quote.trim();
  if (quote.length === 0) return { quote, reason: 'empty' };
  if (normalizeForMatch(quote).length < MIN_QUOTE_CHARS) {
    return { quote, reason: 'too-short' };
  }

  const { document, clauses, matchIndex } = segmented;

  // The clause the model claimed, used to disambiguate a repeated phrase. "thirty (30) days"
  // appears many times in a lease, and pinning it to the wrong occurrence is a wrong answer with
  // a footnote on it.
  const claimedClause =
    claim.clauseId === undefined
      ? undefined
      : clauses.find((clause) => clause.id === claim.clauseId);

  const pinned = pinQuote(document.text, quote, {
    index: matchIndex,
    ...(claimedClause === undefined
      ? {}
      : { within: { charStart: claimedClause.charStart, charEnd: claimedClause.charEnd } }),
  });

  if (pinned === null) {
    const hits = locateQuote(document.text, quote, matchIndex);
    return {
      quote,
      reason: hits.length === 0 ? 'not-found' : 'ambiguous',
      ...(claim.clauseId === undefined ? {} : { claimedClauseId: claim.clauseId }),
    };
  }

  const clause = clauseAtOffset(clauses, pinned.charStart);
  return {
    quote: document.text.slice(pinned.charStart, pinned.charEnd),
    charStart: pinned.charStart,
    charEnd: pinned.charEnd,
    clauseId: clause?.id ?? claim.clauseId ?? 'unknown',
    matchKind: pinned.matchKind,
  };
}

function isVerified(value: VerifiedQuote | RejectedQuote): value is VerifiedQuote {
  return 'charStart' in value;
}

export function verifyQuotes(
  segmented: SegmentedDocument,
  claims: readonly ClaimedQuote[],
): VerificationResult {
  const verified: VerifiedQuote[] = [];
  const rejected: RejectedQuote[] = [];

  for (const claim of claims) {
    const result = verifyQuote(segmented, claim);
    if (isVerified(result)) verified.push(result);
    else rejected.push(result);
  }

  return { verified, rejected };
}

/**
 * The citation rejection rate.
 *
 * Reported as a product metric in `reports/scorecard.md`, not hidden. It is the honest measure of
 * model reliability on this document class, and it is a checkable post-deployment monitoring
 * control for confabulation. It is also diagnostic: measuring it on *clean* fixtures separates
 * PDF extraction drift from genuine hallucination, because the first should be near zero.
 */
export function rejectionRate(result: VerificationResult): number {
  const total = result.verified.length + result.rejected.length;
  if (total === 0) return 0;
  return Math.round((result.rejected.length / total) * 1000) / 1000;
}
