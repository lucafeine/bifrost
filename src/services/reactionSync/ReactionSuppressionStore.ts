import { SyncPlatform } from '../emojiMapping/EmojiMapper';

/**
 * Remembers emojis whose bot mirror must stay removed on a side, because a
 * real user removed the reaction there (or a moderator cleared it).
 *
 * A veto is durable: it shields *every* later reconcile of that message so the
 * mirror cannot bounce back, and is lifted only when
 * - a real user on that side adds the emoji again ({@link unsuppress}), or
 * - the emoji disappears from the other side's real user reactions
 *   ({@link reconcile}).
 */
export default class ReactionSuppressionStore {
    /** platform → message id → vetoed emoji keys. */
    private readonly entries = new Map<string, Map<string, Set<string>>>();
    private count = 0;

    constructor(private readonly max = 10_000) {}

    suppress(
        platform: SyncPlatform,
        messageId: string,
        emojiKey: string
    ): void {
        const messages =
            this.entries.get(platform) ?? new Map<string, Set<string>>();
        this.entries.set(platform, messages);

        const keys = messages.get(messageId) ?? new Set<string>();
        messages.set(messageId, keys);

        if (!keys.has(emojiKey)) {
            keys.add(emojiKey);
            this.count++;
            this.trim();
        }
    }

    suppressMany(
        platform: SyncPlatform,
        messageId: string,
        emojiKeys: Iterable<string>
    ): void {
        for (const key of emojiKeys) {
            this.suppress(platform, messageId, key);
        }
    }

    unsuppress(
        platform: SyncPlatform,
        messageId: string,
        emojiKey: string
    ): void {
        const messages = this.entries.get(platform);
        const keys = messages?.get(messageId);
        if (!messages || !keys) return;

        if (keys.delete(emojiKey)) this.count--;

        if (keys.size === 0) messages.delete(messageId);
        if (messages.size === 0) this.entries.delete(platform);
    }

    isSuppressed(
        platform: SyncPlatform,
        messageId: string,
        emojiKey: string
    ): boolean {
        return (
            this.entries.get(platform)?.get(messageId)?.has(emojiKey) ?? false
        );
    }

    /**
     * Drops suppressions whose emoji is no longer present on the source side:
     * the veto is lifted once the mirrored emoji disappears from the other
     * platform's real user reactions.
     */
    reconcile(
        platform: SyncPlatform,
        messageId: string,
        sourceKeys: Set<string>
    ): void {
        const messages = this.entries.get(platform);
        const keys = messages?.get(messageId);
        if (!messages || !keys) return;

        for (const key of [...keys]) {
            if (sourceKeys.has(key)) continue;
            keys.delete(key);
            this.count--;
        }

        if (keys.size === 0) messages.delete(messageId);
        if (messages.size === 0) this.entries.delete(platform);
    }

    clear(): void {
        this.entries.clear();
        this.count = 0;
    }

    private trim(): void {
        if (this.count <= this.max) return;

        // Drop the oldest (platform, message) bucket to keep memory bounded.
        const platform = this.entries.keys().next().value;
        if (platform === undefined) return;

        const messages = this.entries.get(platform);
        if (!messages) return;

        const messageId = messages.keys().next().value;
        if (messageId === undefined) return;

        this.count -= messages.get(messageId)?.size ?? 0;
        messages.delete(messageId);
        if (messages.size === 0) this.entries.delete(platform);
    }
}
