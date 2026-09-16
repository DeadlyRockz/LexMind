/**
 * The surrogate map.
 *
 * **It never leaves the process.** Not serialised, not logged, not persisted, and never sent to a
 * model. Reversal happens in memory immediately before rendering to the reader. The map is held
 * behind a class with no enumerable data and no `toJSON`, so an accidental
 * `JSON.stringify(result)` somewhere downstream cannot leak it — a guarantee a plain object
 * literal cannot offer.
 */

export type PiiKind =
  | 'person'
  | 'address'
  | 'email'
  | 'phone'
  | 'pan'
  | 'aadhaar'
  | 'nric'
  | 'nino'
  | 'account'
  | 'ifsc'
  | 'card';

export type PartyRole = 'landlord' | 'tenant' | 'other';

export interface Replacement {
  readonly kind: PiiKind;
  readonly original: string;
  readonly surrogate: string;
  readonly role?: PartyRole;
}

/**
 * Realistic, type-matched, role-distinct surrogates — and the reasoning matters, because this is
 * where naive redaction destroys the product.
 *
 * Replacing every name with `<PERSON>` collapses "Mr. Tan", "the Tenant" and "Mr. Tan's spouse"
 * into one token, which destroys coreference. Worse, **the landlord and the tenant both become
 * `<PERSON>`** — and a lease is precisely a two-party obligation matrix, so that failure is fatal
 * to the core feature: the asymmetry engine can no longer tell who owes what to whom.
 *
 * So: the landlord maps to one stable fake name, the tenant to a different one, the same surrogate
 * on every occurrence, reversed on the way out. Consistency preserves coreference; realism keeps
 * the text on-distribution for the model.
 */
const NAME_POOL: Readonly<Record<PartyRole, readonly string[]>> = {
  landlord: ['Alan Pryce', 'Martin Dalby', 'Howard Leng'],
  tenant: ['Dana Whitfield', 'Rosa Kemble', 'Nina Alder'],
  other: ['Chris Marlow', 'Sam Verity', 'Lee Ashford', 'Jo Barrow'],
};

const ADDRESS_POOL: readonly string[] = [
  '18 Gallows Lane, Flat 4, Northtown 100001',
  '7 Marsh Row, Unit 2, Eastfield 200002',
  '221 Quarry Street, Apartment 9, Westbury 300003',
];

export class SurrogateMap {
  /** Longest-first so "Rajesh Kumar Sharma" is replaced before "Sharma". */
  #forward = new Map<string, Replacement>();
  #reverse = new Map<string, string>();
  #counters = new Map<PiiKind, number>();
  #roleCounters = new Map<PartyRole, number>();

  /** Register a mapping, reusing any surrogate already assigned to this original. */
  assign(kind: PiiKind, original: string, role?: PartyRole): string {
    const existing = this.#forward.get(original);
    if (existing !== undefined) return existing.surrogate;

    const surrogate = this.#mint(kind, original, role);
    const replacement: Replacement = {
      kind,
      original,
      surrogate,
      ...(role === undefined ? {} : { role }),
    };
    this.#forward.set(original, replacement);
    this.#reverse.set(surrogate, original);
    return surrogate;
  }

  /** Bind a surrogate explicitly, used to map name parts consistently with the full name. */
  bind(kind: PiiKind, original: string, surrogate: string, role?: PartyRole): void {
    if (this.#forward.has(original)) return;
    this.#forward.set(original, {
      kind,
      original,
      surrogate,
      ...(role === undefined ? {} : { role }),
    });
    this.#reverse.set(surrogate, original);
  }

  surrogateFor(original: string): string | undefined {
    return this.#forward.get(original)?.surrogate;
  }

  /** Originals, longest first, for correct replacement order. */
  originals(): readonly string[] {
    return [...this.#forward.keys()].sort((a, b) => b.length - a.length);
  }

  replacements(): readonly Replacement[] {
    return [...this.#forward.values()];
  }

  /** Surrogates, longest first, for correct restoration order. */
  surrogates(): readonly string[] {
    return [...this.#reverse.keys()].sort((a, b) => b.length - a.length);
  }

  originalFor(surrogate: string): string | undefined {
    return this.#reverse.get(surrogate);
  }

  get size(): number {
    return this.#forward.size;
  }

  /** How many of each kind were replaced. Safe to show and to log: counts, never values. */
  summary(): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const replacement of this.#forward.values()) {
      counts[replacement.kind] = (counts[replacement.kind] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Refuse serialisation. If some future code path stringifies a result object that happens to
   * carry the map, this throws instead of quietly emitting every real name in the document.
   */
  toJSON(): never {
    throw new Error(
      'The surrogate map must never be serialised: it holds the real personal data from the document.',
    );
  }

  #mint(kind: PiiKind, original: string, role?: PartyRole): string {
    if (kind === 'person') {
      const resolved = role ?? 'other';
      const index = this.#roleCounters.get(resolved) ?? 0;
      this.#roleCounters.set(resolved, index + 1);
      const pool = NAME_POOL[resolved];
      return pool[index % pool.length] ?? `Person ${index + 1}`;
    }

    const index = this.#counters.get(kind) ?? 0;
    this.#counters.set(kind, index + 1);

    switch (kind) {
      case 'address':
        return ADDRESS_POOL[index % ADDRESS_POOL.length] ?? `Address ${index + 1}`;
      case 'email':
        return `party${index + 1}@example.invalid`;
      case 'phone':
        return `+44 20 7946 ${String(1000 + index).padStart(4, '0')}`;
      case 'pan':
        return `AAAPA${String(1000 + index).padStart(4, '0')}A`;
      case 'aadhaar':
        // Deliberately starts with 0, which a real Aadhaar never does, so a surrogate can never
        // be mistaken for a genuine number if it escapes into a log.
        return `0000 0000 ${String(1000 + index).padStart(4, '0')}`;
      case 'nric':
        return `S000000${index % 10}A`;
      case 'nino':
        return `AA0000${String(10 + index).slice(0, 2)}A`;
      case 'account':
        return `0000000000${String(index + 1).padStart(4, '0')}`;
      case 'ifsc':
        return `AAAA0${String(100000 + index)}`;
      case 'card':
        return `0000 0000 0000 ${String(1000 + index).padStart(4, '0')}`;
      default:
        return `REDACTED-${original.length}-${index}`;
    }
  }
}

export function nameParts(fullName: string): readonly string[] {
  return fullName
    .split(/\s+/)
    .map((part) => part.replace(/[^\p{L}'-]/gu, ''))
    .filter((part) => part.length > 2);
}
