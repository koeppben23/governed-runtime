/**
 * @module identity/actor-info.test
 * @description Tests for actor identity comparison utilities. Actor assurance
 * semantics are tested at their authority (`shared/actor-assurance.test.ts`).
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 * @version v2
 */

import { describe, it, expect } from 'vitest';
import { compareActorIdentity, normalizeActorId, sameActorIdentity } from './actor-info.js';

describe('actor-info identity comparison', () => {
  it('normalizes whitespace and case', () => {
    expect(normalizeActorId('  Alice.Example  ')).toBe('alice.example');
  });

  it('returns null for blank or missing actor IDs', () => {
    expect(normalizeActorId('   ')).toBeNull();
    expect(normalizeActorId(null)).toBeNull();
    expect(normalizeActorId(undefined)).toBeNull();
  });

  it('treats NFC and NFD canonically equivalent actor IDs as the same actor', () => {
    expect(compareActorIdentity({ actorId: 'café' }, { actorId: 'cafe\u0301' })).toBe('same');
    expect(sameActorIdentity({ actorId: 'café' }, { actorId: 'cafe\u0301' })).toBe(true);
  });

  it('reports different actors as different', () => {
    expect(compareActorIdentity({ actorId: 'alice' }, { actorId: 'bob' })).toBe('different');
    expect(sameActorIdentity({ actorId: 'alice' }, { actorId: 'bob' })).toBe(false);
  });

  it('returns uncomparable when an actor ID is blank after trimming', () => {
    expect(compareActorIdentity({ actorId: 'alice' }, { actorId: '   ' })).toBe('uncomparable');
    expect(sameActorIdentity({ actorId: 'alice' }, { actorId: '   ' })).toBeNull();
  });

  it('returns uncomparable for missing identity objects', () => {
    expect(compareActorIdentity(null, { actorId: 'alice' })).toBe('uncomparable');
    expect(sameActorIdentity(undefined, undefined)).toBeNull();
  });

  it('pins dotted-I lowercasing without adding broader confusable folding', () => {
    // NFC is intentional for #486: canonical equivalence, not NFKC/confusable policy.
    expect(normalizeActorId('\u0130')).toBe('i\u0307');
    expect(compareActorIdentity({ actorId: '\u0130' }, { actorId: 'i' })).toBe('different');
  });
});
