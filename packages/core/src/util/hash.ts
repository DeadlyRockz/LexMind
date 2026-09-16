import { createHash } from 'node:crypto';

/**
 * Content hashing. Two uses, both deliberate:
 *
 *  - Document identity. LexMind never echoes the user's filename and never writes the uploaded
 *    file to disk, so a document is identified by the hash of its normalized text.
 *  - Cache and cassette keys, so re-analysing the same lease costs nothing and the offline
 *    replay adapter is reproducible.
 */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function sha256Bytes(input: Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** A short, stable, non-reversible id. Safe to log: it is neither the filename nor the content. */
export function shortId(input: string): string {
  return sha256(input).slice(0, 12);
}
