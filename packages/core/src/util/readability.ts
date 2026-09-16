import { countWords, splitSentences } from './text.ts';

/**
 * Flesch-Kincaid, implemented here rather than pulled in as a dependency: the formulas are
 * published and fixed, and a local implementation can be tested against their reference values
 * instead of trusted.
 *
 * Why LexMind measures this at all. Consumer contracts measure around Flesch-Kincaid grade 14.7
 * with a Reading Ease of about 35, and 498 of 500 major sites' terms fail both thresholds.
 * Research in *Cognition* (2022) found legal difficulty comes largely from poor writing — centre-
 * embedded clauses and long-distance dependencies — rather than from specialised concepts, and
 * that it impairs recall even for experienced readers. Restructuring genuinely helps; it is not
 * dumbing down.
 *
 * Framed honestly in the docs: WCAG SC 3.1.5 Reading Level is **AAA**, not AA, and the working
 * group itself could not find a way to test it. LexMind asserts a threshold on its own generated
 * prose as voluntary rigour and labels it as such.
 */

/** Vowel-group heuristic with the standard silent-e correction. */
export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;

  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups === null ? 1 : groups.length);
}

export interface ReadabilityScore {
  readonly words: number;
  readonly sentences: number;
  readonly syllables: number;
  /** US grade level. Lower is easier. */
  readonly gradeLevel: number;
  /** 0-100. Higher is easier; 60 and above reads as plain English. */
  readonly readingEase: number;
}

export const EMPTY_READABILITY: ReadabilityScore = {
  words: 0,
  sentences: 0,
  syllables: 0,
  gradeLevel: 0,
  readingEase: 100,
};

export function readability(text: string): ReadabilityScore {
  const wordCount = countWords(text);
  if (wordCount === 0) return EMPTY_READABILITY;

  const sentenceCount = Math.max(1, splitSentences(text).length);
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const wordsPerSentence = wordCount / sentenceCount;
  const syllablesPerWord = syllables / wordCount;

  return {
    words: wordCount,
    sentences: sentenceCount,
    syllables,
    gradeLevel: round2(0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59),
    readingEase: round2(206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Above this, a lease clause is flagged as obscuring its own meaning. */
export const OBSCURE_GRADE_LEVEL = 18;

/** The target LexMind holds its own generated prose to. */
export const PLAIN_LANGUAGE_GRADE_LEVEL = 9;
