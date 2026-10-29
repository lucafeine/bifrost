import { describe, expect, it } from 'vitest';
import {
    diffReactionKeys,
    emojiKeyFromInput,
    emojiKeyFromMapped,
} from './emojiKey';

describe('emojiKeyFromInput', () => {
    it('normalizes unicode emojis', () => {
        expect(
            emojiKeyFromInput({
                id: null,
                name: '\u2764\uFE0F',
                animated: false,
            })
        ).toBe('u:\u2764');
        expect(
            emojiKeyFromInput({
                id: null,
                name: '1\uFE0F\u20E3',
                animated: false,
            })
        ).toBe('u:1\u20E3');
    });

    it('identifies custom emojis by name and id', () => {
        expect(
            emojiKeyFromInput({ id: '111', name: 'lemon', animated: false })
        ).toBe('c:lemon:111');
        expect(
            emojiKeyFromInput({ id: '222', name: 'party', animated: true })
        ).toBe('c:party:222');
    });
});

describe('emojiKeyFromMapped', () => {
    it('matches the key of the target-side emoji', () => {
        expect(emojiKeyFromMapped({ kind: 'unicode', value: '\u2764' })).toBe(
            'u:\u2764'
        );
        expect(
            emojiKeyFromMapped({
                kind: 'custom',
                id: '900',
                name: 'lemon',
                animated: false,
                value: 'lemon:900',
            })
        ).toBe('c:lemon:900');
    });
});

describe('diffReactionKeys', () => {
    it('computes additions and removals', () => {
        const { toAdd, toRemove } = diffReactionKeys(
            ['u:🍋', 'c:lemon:900'],
            ['u:🍋', 'c:party:901']
        );

        expect(toAdd).toEqual(['c:lemon:900']);
        expect(toRemove).toEqual(['c:party:901']);
    });

    it('is empty when both sets match', () => {
        const { toAdd, toRemove } = diffReactionKeys(
            ['u:🍋', 'u:🎉'],
            ['u:🎉', 'u:🍋']
        );

        expect(toAdd).toEqual([]);
        expect(toRemove).toEqual([]);
    });

    it('deduplicates the desired set', () => {
        const { toAdd } = diffReactionKeys(['u:🍋', 'u:🍋'], []);

        expect(toAdd).toEqual(['u:🍋']);
    });
});
