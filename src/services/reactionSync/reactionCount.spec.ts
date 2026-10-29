import { describe, expect, it } from 'vitest';
import { countUserReactions } from './reactionCount';

describe('countUserReactions', () => {
    it('keeps real user reactions', () => {
        expect(countUserReactions(1, false)).toBe(1);
        expect(countUserReactions(3, false)).toBe(3);
    });

    it('excludes the bridge bot reaction', () => {
        expect(countUserReactions(1, true)).toBe(0);
        expect(countUserReactions(2, true)).toBe(1);
        expect(countUserReactions(5, true)).toBe(4);
    });

    it('never goes negative', () => {
        expect(countUserReactions(0, false)).toBe(0);
        expect(countUserReactions(0, true)).toBe(0);
    });
});
