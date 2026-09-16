import type { Clause } from '../domain/types.ts';

/**
 * BM25 retrieval over the clauses of one document.
 *
 * Lexical first, and quite possibly lexical only. It needs no API call, no network and no
 * embedding cost; it is deterministic, so tests are stable; and on a single document of twenty to
 * eighty clauses it is frequently just sufficient. Legal language is unusually keyword-dense —
 * "lock-in", "indemnify", "confession of judgment" — so the usual assumption that semantic search
 * wins does not hold here without measurement.
 *
 * Retrieval exists for *citation and targeting*, not to work around a context limit: a lease fits
 * comfortably in a modern context window, and building a RAG pipeline for a document that fits
 * would be complexity with no payoff.
 */

/** Words carrying no retrieval signal. Deliberately short: legal boilerplate *is* the content. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by', 'for', 'from',
  'has', 'have', 'he', 'her', 'hereby', 'herein', 'hereof', 'his', 'i', 'if', 'in', 'into', 'is',
  'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 's', 'said', 'she', 'so', 'such', 'that',
  'the', 'their', 'them', 'there', 'these', 'they', 'this', 'those', 'to', 'was', 'we', 'were',
  'what', 'when', 'which', 'who', 'will', 'with', 'you', 'your',
]);

const K1 = 1.5;
const B = 0.75;

/**
 * A bridge from how a tenant asks to how a lease is drafted.
 *
 * This is where pure lexical retrieval genuinely falls down, and it is worth being precise about
 * why rather than reaching for embeddings: nobody asks "what is the lock-in period", they ask
 * "can I leave early". The words in the question and the words in the clause do not overlap at
 * all, so BM25 scores zero however well tuned it is.
 *
 * Expansion is phrase-level and data-driven, so a new phrasing is a row here. It is *additive* —
 * the reader's own words are always scored too — and it is honestly not semantic search: it
 * bridges a listed set of everyday phrasings, and `reports/scorecard.md` records the retrieval
 * rate it achieves rather than claiming it solves paraphrase in general.
 */
export const QUERY_EXPANSIONS: readonly {
  readonly match: RegExp;
  readonly add: readonly string[];
}[] = [
  {
    match: /\bleave (?:early|before)|\bmove out early|\bbreak the (?:lease|agreement)|\bget out of/i,
    add: ['lock-in', 'vacate', 'terminate', 'notice', 'forfeited'],
  },
  {
    match: /\bkick me out|\bthrow me out|\bmake me leave|\bevict|\bthrow us out/i,
    add: ['terminate', 'eviction', 'possession', 'notice', 'default'],
  },
  {
    match: /\bdeposit back|\bget my (?:money|deposit)|\brefund|\bwithhold/i,
    add: ['deposit', 'refundable', 'deduct', 'forfeited'],
  },
  {
    match: /\bcome in|\benter my|\bwalk in|\bshow up|\bwithout asking|\bprivacy/i,
    add: ['entry', 'enter', 'inspect', 'access', 'notice'],
  },
  {
    match: /\bfix|\brepair|\bbroken|\bleak|\bmould|\bmold|\bboiler|\bgeyser/i,
    add: ['repairs', 'maintain', 'structural', 'habitable'],
  },
  { match: /\bpets?\b|\bdog\b|\bcat\b|\banimals?\b/i, add: ['pets', 'animals'] },
  {
    match: /\bguests?\b|\bvisitors?\b|\bfriends?\b|\bstay over|\bpartner move/i,
    add: ['guest', 'visitor', 'occupancy', 'occupants'],
  },
  {
    match: /\braise the rent|\brent (?:increase|go(?:es)? up)|\bput up the rent/i,
    add: ['escalation', 'increase', 'revision', 'enhanced'],
  },
  {
    match: /\blate\b|\bmiss(?:ed)? (?:a )?payment|\bcan't pay|\bcannot pay|\bbehind on/i,
    add: ['late', 'interest', 'penalty', 'arrears', 'default'],
  },
  {
    match: /\bsublet|\brent it out|\bshare the (?:flat|place|house)|\broommate|\bflatmate/i,
    add: ['sublet', 'assignment', 'occupancy'],
  },
  {
    match: /\bsue|\bcourt\b|\bcomplain|\bdispute|\btake them to/i,
    add: ['arbitration', 'jurisdiction', 'dispute', 'costs'],
  },
  {
    match: /\bhow long|\bwhen does (?:it|the lease) end|\bend date/i,
    add: ['term', 'period', 'commencing', 'expiry'],
  },
];

export function tokenize(text: string): readonly string[] {
  const matched = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  return matched.filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** The reader's own terms, plus any bridged lease terms. Additive, never a replacement. */
export function expandQuery(query: string): readonly string[] {
  const bridged = QUERY_EXPANSIONS.filter((rule) => rule.match.test(query)).flatMap(
    (rule) => rule.add,
  );
  return [...tokenize(query), ...bridged.flatMap((term) => tokenize(term))];
}

interface Posting {
  readonly clauseId: string;
  readonly termFrequency: number;
  readonly length: number;
}

export interface RetrievalIndex {
  readonly postings: ReadonlyMap<string, readonly Posting[]>;
  readonly clauseCount: number;
  readonly averageLength: number;
  readonly clauses: ReadonlyMap<string, Clause>;
}

export function buildRetrievalIndex(clauses: readonly Clause[]): RetrievalIndex {
  const postings = new Map<string, Posting[]>();
  const byId = new Map<string, Clause>();
  let totalLength = 0;

  for (const clause of clauses) {
    byId.set(clause.id, clause);
    // Index the heading trail with the body: "Deductions" only means something under
    // "ARTICLE 8 - SECURITY DEPOSIT", and a question about deposits must reach it.
    const tokens = tokenize([...clause.headingTrail, clause.heading ?? '', clause.text].join(' '));
    totalLength += tokens.length;

    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

    for (const [term, termFrequency] of counts) {
      const list = postings.get(term) ?? [];
      list.push({ clauseId: clause.id, termFrequency, length: tokens.length });
      postings.set(term, list);
    }
  }

  return {
    postings,
    clauseCount: clauses.length,
    averageLength: clauses.length === 0 ? 0 : totalLength / clauses.length,
    clauses: byId,
  };
}

export interface RetrievalHit {
  readonly clause: Clause;
  readonly score: number;
  /** Which query terms actually matched, so the UI can say why this clause was retrieved. */
  readonly matchedTerms: readonly string[];
}

/**
 * Retrieve whole clauses, with their heading path, never an arbitrary character window. Half a
 * sentence of a lease is worse than useless — it is misleading, and it cannot be cited.
 */
export function search(index: RetrievalIndex, query: string, topK = 5): readonly RetrievalHit[] {
  const terms = expandQuery(query);
  if (terms.length === 0 || index.clauseCount === 0) return [];

  const scores = new Map<string, number>();
  const matched = new Map<string, Set<string>>();

  for (const term of new Set(terms)) {
    const list = index.postings.get(term);
    if (list === undefined) continue;

    // BM25 inverse document frequency, with the standard +1 to keep it non-negative.
    const idf = Math.log(1 + (index.clauseCount - list.length + 0.5) / (list.length + 0.5));

    for (const posting of list) {
      const normalisation =
        index.averageLength === 0 ? 1 : 1 - B + B * (posting.length / index.averageLength);
      const contribution =
        idf * ((posting.termFrequency * (K1 + 1)) / (posting.termFrequency + K1 * normalisation));

      scores.set(posting.clauseId, (scores.get(posting.clauseId) ?? 0) + contribution);
      const terms = matched.get(posting.clauseId) ?? new Set<string>();
      terms.add(term);
      matched.set(posting.clauseId, terms);
    }
  }

  return [...scores.entries()]
    .map(([clauseId, score]) => ({ clauseId, score }))
    .sort((a, b) => b.score - a.score || a.clauseId.localeCompare(b.clauseId))
    .slice(0, topK)
    .flatMap(({ clauseId, score }) => {
      const clause = index.clauses.get(clauseId);
      if (clause === undefined) return [];
      return [
        {
          clause,
          score: Math.round(score * 1000) / 1000,
          matchedTerms: [...(matched.get(clauseId) ?? [])].sort(),
        },
      ];
    });
}
