import { emojiToString, GeneralEmoji, replaceEmojis } from '../../utils/emojis';

export type SyncPlatform = 'discord' | 'fluxer';

/** A custom or unicode emoji on a given platform. */
export interface EmojiRef {
    /** Platform the emoji comes from. */
    platform: SyncPlatform;
    /** Custom emoji id, or null for a unicode emoji. */
    id: string | null;
    /** Emoji name, or the raw unicode sequence for a unicode emoji. */
    name: string;
    animated: boolean;
    sourceGuildId: string | null;
}

export type MappedEmoji =
    | {
          kind: 'unicode';
          /** Normalized unicode sequence, safe to send to both platforms. */
          value: string;
      }
    | {
          kind: 'custom';
          id: string;
          name: string;
          animated: boolean;
          /** Ready-to-send emoji identifier on the target platform. */
          value: string;
      };

/**
 * Minimal read access to the emoji list of a guild. Structurally satisfied by
 * the entity resolvers.
 */
export interface EmojiDirectory {
    fetchEmojis(guildId: string): Promise<GeneralEmoji[]>;
}

export interface EmojiMapperOptions {
    discordDirectory?: EmojiDirectory | null;
    fluxerDirectory?: EmojiDirectory | null;
}

const VARIATION_SELECTOR = /\uFE0F/g;

/**
 * Unicode emoji render differently across platforms when they carry the
 * variation selector U+FE0F. Normalize to the canonical form (strip U+FE0F,
 * keep the keycap combiner U+20E3) before comparing or sending.
 */
export function normalizeUnicodeEmoji(value: string): string {
    return value.replace(VARIATION_SELECTOR, '');
}

/** Content mention form (`<:name:id>` / `<a:name:id>`), used by both platforms. */
export function renderEmojiMention(emoji: {
    name: string;
    id: string;
    animated: boolean;
}): string {
    return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
}

/**
 * Identifier form used by reaction/emoji APIs:
 * Discord takes `<:name:id>` / `<a:name:id>`,
 * Fluxer takes `name:id` / `a:name:id`.
 */
export function renderEmojiIdentifier(
    target: SyncPlatform,
    emoji: { name: string; id: string; animated: boolean }
): string {
    if (target === 'discord') return renderEmojiMention(emoji);
    return `${emoji.animated ? 'a:' : ''}${emoji.name}:${emoji.id}`;
}

/**
 * Single place that answers: "given an emoji on side A, what do I send to
 * side B?" Shared by message content, reactions and the emoji mirror.
 */
export default class EmojiMapper {
    private readonly discordDirectory: EmojiDirectory | null;
    private readonly fluxerDirectory: EmojiDirectory | null;

    constructor(options: EmojiMapperOptions = {}) {
        this.discordDirectory = options.discordDirectory ?? null;
        this.fluxerDirectory = options.fluxerDirectory ?? null;
    }

    /**
     * Resolution order:
     * 1. Unicode — identity on both sides (normalized).
     * 2. `emoji_links` lookup by source emoji id (P5).
     * 3. Name match in the target guild (reusing the per-guild emoji caches).
     * 4. Lazy mirror to the target side (P5).
     * 5. Fallback `null` — the caller renders `:name:` text or an image URL.
     */
    async resolve(
        input: EmojiRef,
        target: SyncPlatform,
        targetGuildId: string | null = null
    ): Promise<MappedEmoji | null> {
        if (input.id === null) {
            return {
                kind: 'unicode',
                value: normalizeUnicodeEmoji(input.name),
            };
        }

        // P5 (emoji mirror) will add two branches around the name match:
        // step 2, resolve via the `emoji_links` table keyed by source emoji id;
        // step 4, lazily mirror the emoji to the target side before giving up.

        if (targetGuildId) {
            const match = await this.findByName(
                target,
                targetGuildId,
                input.name
            );
            if (match) {
                return {
                    kind: 'custom',
                    id: match.id,
                    name: match.name,
                    animated: match.animated,
                    value: renderEmojiIdentifier(target, match),
                };
            }
        }

        return null;
    }

    /**
     * Replaces custom emoji mentions in message content with the matching
     * emoji of the target guild (matched by name). Unknown emojis are left
     * untouched.
     */
    mapContent(content: string, targetEmojis: GeneralEmoji[]): string {
        return replaceEmojis(content, (emoji) => {
            const match = targetEmojis.find((e) => e.name === emoji.name);
            return match ? renderEmojiMention(match) : emojiToString(emoji);
        });
    }

    private async findByName(
        target: SyncPlatform,
        targetGuildId: string,
        name: string
    ): Promise<GeneralEmoji | null> {
        const directory =
            target === 'discord' ? this.discordDirectory : this.fluxerDirectory;
        if (!directory) return null;

        const emojis = await directory.fetchEmojis(targetGuildId);
        return emojis.find((e) => e.name === name) ?? null;
    }
}
