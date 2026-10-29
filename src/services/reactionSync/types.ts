import { SyncPlatform } from '../emojiMapping/EmojiMapper';

export type ReactionEventKind = 'add' | 'remove' | 'removeEmoji' | 'removeAll';

/** Minimal emoji shape carried by reaction events on either platform. */
export interface ReactionEmojiInput {
    /** Custom emoji id, or null for a unicode emoji. */
    id: string | null;
    /** Emoji name, or the raw unicode sequence. */
    name: string;
    animated: boolean;
}

export interface ReactionEvent {
    /** Platform the event comes from. */
    platform: SyncPlatform;
    kind: ReactionEventKind;
    channelId: string;
    messageId: string;
    /** User who triggered the event, null when the platform does not say. */
    actorId: string | null;
    /** Emoji involved, null for `removeAll`. */
    emoji: ReactionEmojiInput | null;
}
