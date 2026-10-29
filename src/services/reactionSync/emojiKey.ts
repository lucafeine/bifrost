import {
    MappedEmoji,
    normalizeUnicodeEmoji,
} from '../emojiMapping/EmojiMapper';
import { ReactionEmojiInput } from './types';

/**
 * Canonical key for a reaction emoji on a given platform: custom emojis are
 * identified by name + id (ids differ across guilds), unicode by the
 * normalized sequence.
 */
export function emojiKeyFromInput(input: ReactionEmojiInput): string {
    if (!input.id) return `u:${normalizeUnicodeEmoji(input.name)}`;
    return `c:${input.name}:${input.id}`;
}

export function emojiKeyFromMapped(mapped: MappedEmoji): string {
    if (mapped.kind === 'unicode') return `u:${mapped.value}`;
    return `c:${mapped.name}:${mapped.id}`;
}

/**
 * Emoji-set diff: what must be added to and removed from the target so that
 * its bridge-owned reactions match the source emoji set.
 */
export function diffReactionKeys(
    desired: Iterable<string>,
    current: Iterable<string>
): { toAdd: string[]; toRemove: string[] } {
    const desiredSet = new Set(desired);
    const currentSet = new Set(current);

    return {
        toAdd: [...desiredSet].filter((key) => !currentSet.has(key)),
        toRemove: [...currentSet].filter((key) => !desiredSet.has(key)),
    };
}
