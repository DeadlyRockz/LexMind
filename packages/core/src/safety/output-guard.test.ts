import { describe, expect, it } from 'vitest';
import { createReplayAdapter } from '../model/adapters/replay.ts';
import type { LlmPort, TextRequest } from '../model/port.ts';
import { adviceWithheldNote, findAdvicePhrases } from './boundary.ts';
import { createGuardedPort, prepareForModel, restoreForReader } from './index.ts';
import { SYSTEM_PREAMBLE } from './injection.ts';

/**
 * The output side of the advice boundary.
 *
 * `findAdvicePhrases` had a passing test and no production caller — a green assertion for a
 * defence that was not wired in, which is worse than no test, because it reads as coverage. It is
 * now called on every model-produced surface (`analyse/explain.ts`), and the tests that prove that
 * live in `analyse/pipeline.test.ts` and `analyse/explain.test.ts`. What is asserted here is the
 * part of the policy this module owns: what the reader is told when prose is withheld.
 */

describe('what the reader is told when generated prose is withheld', () => {
  it('says what happened and what LexMind does instead — never a bare removal notice', () => {
    const note = adviceWithheldNote(1);
    expect(note).toMatch(/One AI-written passage/);
    expect(note).toMatch(/information, not legal advice/i);
    // Plan 05: a refusal must redirect. The same redirect the request-side classifier gives.
    expect(note).toMatch(/lawyer-prep pack/i);
    expect(note).toMatch(/clause that a professional should look at/i);
  });

  it('agrees with itself on plurals', () => {
    expect(adviceWithheldNote(3)).toMatch(/3 AI-written passages .* were withheld/);
    expect(adviceWithheldNote(1)).toMatch(/One AI-written passage .* was withheld/);
  });

  it('says nothing when nothing was withheld', () => {
    expect(adviceWithheldNote(0)).toBe('');
    expect(adviceWithheldNote(-1)).toBe('');
  });
});

describe('the phrases the output scanner looks for', () => {
  it('catches the four ways a model drifts into advice', () => {
    expect(findAdvicePhrases('You should ask for a shorter notice period.')).toContain(
      'you should',
    );
    expect(findAdvicePhrases('I recommend signing only after a review.')).toContain('i recommend');
    expect(findAdvicePhrases('The court will find this clause void.')).toContain('the court will');
    expect(findAdvicePhrases('This is unenforceable against you in any case.')).toContain(
      'is unenforceable against you',
    );
  });

  it('leaves a plain description of a clause alone — over-refusal is a failure too', () => {
    expect(
      findAdvicePhrases('This clause requires thirty days written notice from the tenant.'),
    ).toEqual([]);
    expect(
      findAdvicePhrases('The deposit is six months of rent and is refunded after ninety days.'),
    ).toEqual([]);
    expect(findAdvicePhrases('')).toEqual([]);
  });

  it('is case-insensitive, because a capitalised sentence is still advice', () => {
    expect(findAdvicePhrases('DO NOT SIGN THIS.')).toContain('do not sign');
  });

  it('reads a typographic apostrophe as the ASCII one, so "Don’t sign" is not a way round it', () => {
    expect(findAdvicePhrases('Don’t sign this until the deposit clause changes.')).toContain(
      "don't sign",
    );
  });
});

/**
 * Verdicts: the answer to "Should I sign?", stated as a fact about the document. They use no phrase
 * on the advice list, which is exactly how an obeyed injection got one past the guard.
 */
describe('verdicts about the agreement or the decision are withheld as advice', () => {
  it.each([
    ['This lease is completely fair and safe to sign.', 'this lease is completely fair'],
    ['THERE ARE NO RISKS IN THIS AGREEMENT.', 'there are no risks'],
    ['Your tenancy agreement is perfectly legal.', 'your tenancy agreement is perfectly legal'],
    ['The contract looks risk‑free for you.', 'risk-free'],
    ['It’s safe to sign.', 'safe to sign'],
    ['There’s nothing to worry about in these terms.', 'nothing to worry'],
    ['I wouldn’t sign this.', "i wouldn't sign"],
    ['This is a fair lease for both sides.', 'is a fair lease'],
    ['You can safely sign it today.', 'can safely sign'],
    ['This lease is not fair.', 'this lease is not fair'],
    ['The deposit clause is unenforceable.', 'the deposit clause is unenforceable'],
    ['This agreement has no hidden traps.', 'has no hidden traps'],
    ['You are fully protected by this agreement.', 'you are fully protected'],
    ['The tenant should sign it immediately.', 'should sign'],
  ])('withholds: %s', (prose, matched) => {
    expect(findAdvicePhrases(prose)).toContain(matched);
  });

  it.each([
    'This clause says the deposit is refundable.',
    'The lease does not list any late fee.',
    'The agreement is valid for twelve months from the start date.',
    'The offer in this term is valid until 1 March.',
    'The tenant must keep the home safe and clean.',
    'Fair wear and tear is not charged to you.',
    'The lease says the landlord will sign the renewal.',
    'This clause says the tenant is responsible for all repairs.',
    'The document does not mention pets.',
    'You must give thirty days of written notice before you leave.',
  ])('leaves information alone — over-refusal is a failure too: %s', (prose) => {
    expect(findAdvicePhrases(prose)).toEqual([]);
  });

  it('reports every verdict in a passage, so the reason names what was matched', () => {
    expect(
      findAdvicePhrases(
        'This lease is completely fair and safe to sign. There are no risks in this agreement.',
      ),
    ).toEqual(['this lease is completely fair', 'there are no risks', 'safe to sign']);
  });
});

describe('the guarded port covers the streaming path too', () => {
  const safe = prepareForModel('Mr. Rajesh Kumar Sharma ("the Landlord") shall pay rent.');
  const guarded = createGuardedPort(createReplayAdapter([], { matchBy: 'task' }), safe);

  async function drain(stream: AsyncIterable<string>): Promise<string> {
    let out = '';
    for await (const chunk of stream) out += chunk;
    return out;
  }

  it('refuses a stream carrying raw document text', async () => {
    // A guard on one method and not the other is not a guard: the streaming path carries the same
    // bytes to the same provider, and forgetting it would leak exactly what redaction exists for.
    await expect(
      drain(
        guarded.generateTextStream({
          task: 'answer',
          tier: 'analysis',
          systemInstruction: SYSTEM_PREAMBLE,
          document: 'Mr. Rajesh Kumar Sharma shall pay rent.',
          task_input: 'answer',
        }),
      ),
    ).rejects.toThrow(/must go through prepareForModel/);
  });

  it('lets a prepared document through to the adapter', async () => {
    // The cassette is absent, so reaching CASSETTE_MISS proves the guard let it past.
    await expect(
      drain(
        guarded.generateTextStream({
          task: 'answer',
          tier: 'analysis',
          systemInstruction: SYSTEM_PREAMBLE,
          document: safe.channel,
          task_input: 'answer',
        }),
      ),
    ).rejects.toThrow(/No recorded response/i);
  });

  it('scrubs the task input of a stream, not only its document', async () => {
    let sent: TextRequest | undefined;
    const recording: LlmPort = {
      ...createReplayAdapter([], { matchBy: 'task' }),
      generateTextStream(request: TextRequest): AsyncIterable<string> {
        sent = request;
        return (async function* reply(): AsyncGenerator<string> {
          yield 'ok';
        })();
      },
    };

    const reply = await drain(
      createGuardedPort(recording, safe).generateTextStream({
        task: 'answer',
        tier: 'analysis',
        systemInstruction: SYSTEM_PREAMBLE,
        document: safe.channel,
        task_input: 'What does Mr. Sharma have to pay?',
      }),
    );

    expect(reply).toBe('ok');
    expect(sent?.task_input).not.toContain('Sharma');
    expect(sent?.task_input).toContain(`Mr. ${safe.map.surrogateFor('Sharma')} have to pay`);
  });

  it('scrubs text sent for a token count — it reaches the provider just the same', async () => {
    let counted = '';
    const recording: LlmPort = {
      ...createReplayAdapter([], { matchBy: 'task' }),
      countTokens(text: string): Promise<number> {
        counted = text;
        return Promise.resolve(text.length);
      },
    };

    await expect(
      createGuardedPort(recording, safe).countTokens('Rent is paid to Rajesh Kumar Sharma.'),
    ).resolves.toBeGreaterThan(0);
    expect(counted).not.toMatch(/Rajesh|Kumar|Sharma/);
    expect(restoreForReader(counted, safe)).toBe('Rent is paid to Rajesh Kumar Sharma.');
  });
});
