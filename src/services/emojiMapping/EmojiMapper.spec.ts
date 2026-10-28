import { describe, expect, it } from 'vitest';
import EmojiMapper, {
    EmojiDirectory,
    normalizeUnicodeEmoji,
    renderEmojiIdentifier,
} from './EmojiMapper';
import { GeneralEmoji } from '../../utils/emojis';

const heart = '\u2764\uFE0F'; // ❤️ with variation selector
const keycapOne = '1\uFE0F\u20E3'; // 1️⃣

const discordEmojis: GeneralEmoji[] = [
    { name: 'lemon', id: '111', animated: false },
    { name: 'party', id: '222', animated: true },
];

const fluxerEmojis: GeneralEmoji[] = [
    { name: 'lemon', id: '900', animated: false },
    { name: 'party', id: '901', animated: true },
];

function directory(emojis: GeneralEmoji[]): EmojiDirectory {
    return { fetchEmojis: async () => emojis };
}

describe('normalizeUnicodeEmoji', () => {
    it('strips variation selectors', () => {
        expect(normalizeUnicodeEmoji(heart)).toBe('\u2764');
    });

    it('keeps keycap combiners', () => {
        expect(normalizeUnicodeEmoji(keycapOne)).toBe('1\u20E3');
    });
});

describe('renderEmojiIdentifier', () => {
    it('renders Discord mention format', () => {
        expect(
            renderEmojiIdentifier('discord', {
                name: 'lemon',
                id: '111',
                animated: false,
            })
        ).toBe('<:lemon:111>');
        expect(
            renderEmojiIdentifier('discord', {
                name: 'party',
                id: '222',
                animated: true,
            })
        ).toBe('<a:party:222>');
    });

    it('renders Fluxer identifier format', () => {
        expect(
            renderEmojiIdentifier('fluxer', {
                name: 'lemon',
                id: '900',
                animated: false,
            })
        ).toBe('lemon:900');
        expect(
            renderEmojiIdentifier('fluxer', {
                name: 'party',
                id: '901',
                animated: true,
            })
        ).toBe('a:party:901');
    });
});

describe('EmojiMapper.resolve', () => {
    it('resolves unicode emoji to their normalized form', async () => {
        const mapper = new EmojiMapper();

        const mapped = await mapper.resolve(
            {
                platform: 'discord',
                id: null,
                name: heart,
                animated: false,
                sourceGuildId: '1',
            },
            'fluxer'
        );

        expect(mapped).toEqual({ kind: 'unicode', value: '\u2764' });
    });

    it('matches custom emojis by name in the target guild', async () => {
        const mapper = new EmojiMapper({
            discordDirectory: directory(discordEmojis),
            fluxerDirectory: directory(fluxerEmojis),
        });

        const toFluxer = await mapper.resolve(
            {
                platform: 'discord',
                id: '111',
                name: 'lemon',
                animated: false,
                sourceGuildId: '1',
            },
            'fluxer',
            '2'
        );

        expect(toFluxer).toEqual({
            kind: 'custom',
            id: '900',
            name: 'lemon',
            animated: false,
            value: 'lemon:900',
        });

        const toDiscord = await mapper.resolve(
            {
                platform: 'fluxer',
                id: '901',
                name: 'party',
                animated: true,
                sourceGuildId: '2',
            },
            'discord',
            '1'
        );

        expect(toDiscord).toEqual({
            kind: 'custom',
            id: '222',
            name: 'party',
            animated: true,
            value: '<a:party:222>',
        });
    });

    it('returns null when nothing matches', async () => {
        const mapper = new EmojiMapper({
            discordDirectory: directory(discordEmojis),
        });

        const mapped = await mapper.resolve(
            {
                platform: 'fluxer',
                id: '999',
                name: 'missing',
                animated: false,
                sourceGuildId: '2',
            },
            'discord',
            '1'
        );

        expect(mapped).toBeNull();
    });

    it('returns null when the target guild is unknown and no directory exists', async () => {
        const mapper = new EmojiMapper();

        const mapped = await mapper.resolve(
            {
                platform: 'discord',
                id: '111',
                name: 'lemon',
                animated: false,
                sourceGuildId: '1',
            },
            'fluxer'
        );

        expect(mapped).toBeNull();
    });
});

describe('EmojiMapper.mapContent', () => {
    const mapper = new EmojiMapper();

    it('replaces known emojis with the target guild emoji', () => {
        expect(mapper.mapContent('hi <:lemon:111>!', discordEmojis)).toBe(
            'hi <:lemon:111>!'
        );
        expect(mapper.mapContent('hi <:lemon:555>!', fluxerEmojis)).toBe(
            'hi <:lemon:900>!'
        );
        expect(mapper.mapContent('hi <a:party:555>!', fluxerEmojis)).toBe(
            'hi <a:party:901>!'
        );
    });

    it('leaves unknown emojis untouched', () => {
        expect(mapper.mapContent('hi <:missing:555>!', fluxerEmojis)).toBe(
            'hi <:missing:555>!'
        );
    });

    it('leaves unicode emojis untouched', () => {
        expect(mapper.mapContent(`hi ${heart}`, fluxerEmojis)).toBe(
            `hi ${heart}`
        );
    });
});
