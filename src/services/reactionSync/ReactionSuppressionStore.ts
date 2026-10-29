import { SyncPlatform } from '../emojiMapping/EmojiMapper';

/**
 * Remembers emojis whose bot mirror was removed by a real user on a side.
 *
 * Without this, the reconcile would immediately re-add the mirror as long as
 * the emoji still exists on the other side, which makes a reaction impossible
 * to get rid of locally. The suppression is lifted once the emoji disappears
 * from the source side, so a later reaction can be mirrored again.
 */
export default class ReactionSuppressionStore {
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
        for (const key of emojiKeys) this.suppress(platform, messageId, key);
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
     * the user's local removal has been reconciled, a future reaction may be
     * mirrored again.
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
