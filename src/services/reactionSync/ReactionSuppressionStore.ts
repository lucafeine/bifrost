import { SyncPlatform } from '../emojiMapping/EmojiMapper';

interface SuppressionEntry {
    createdAt: number;
}

/**
 * Remembers emojis whose bot mirror was removed by a real user on a side.
 *
 * A suppression only shields the next reconcile of that message: it prevents
 * the mirror from bouncing back right after the user removed it, without
 * disabling the emoji forever. Entries older than the current reconcile are
 * consumed; a user who adds the emoji again also lifts the suppression.
 */
export default class ReactionSuppressionStore {
    private readonly entries = new Map<
        string,
        Map<string, Map<string, SuppressionEntry>>
    >();
    private count = 0;

    constructor(private readonly max = 10_000) {}

    suppress(
        platform: SyncPlatform,
        messageId: string,
        emojiKey: string,
        now = Date.now()
    ): void {
        const messages =
            this.entries.get(platform) ??
            new Map<string, Map<string, SuppressionEntry>>();
        this.entries.set(platform, messages);

        const keys =
            messages.get(messageId) ?? new Map<string, SuppressionEntry>();
        messages.set(messageId, keys);

        if (!keys.has(emojiKey)) {
            keys.set(emojiKey, { createdAt: now });
            this.count++;
            this.trim();
        } else {
            keys.get(emojiKey)!.createdAt = now;
        }
    }

    suppressMany(
        platform: SyncPlatform,
        messageId: string,
        emojiKeys: Iterable<string>,
        now = Date.now()
    ): void {
        for (const key of emojiKeys) {
            this.suppress(platform, messageId, key, now);
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
     * Drops suppressions whose emoji is no longer present on the source side.
     */
    reconcile(
        platform: SyncPlatform,
        messageId: string,
        sourceKeys: Set<string>
    ): void {
        const messages = this.entries.get(platform);
        const keys = messages?.get(messageId);
        if (!messages || !keys) return;

        for (const key of [...keys.keys()]) {
            if (sourceKeys.has(key)) continue;
            keys.delete(key);
            this.count--;
        }

        if (keys.size === 0) messages.delete(messageId);
        if (messages.size === 0) this.entries.delete(platform);
    }

    /**
     * Consumes entries created before `cutoff`: the reconcile that follows a
     * removal has applied the suppression, so a later reconcile may mirror the
     * emoji again.
     */
    consume(platform: SyncPlatform, messageId: string, cutoff: number): void {
        const messages = this.entries.get(platform);
        const keys = messages?.get(messageId);
        if (!messages || !keys) return;

        for (const [key, entry] of [...keys]) {
            if (entry.createdAt > cutoff) continue;
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
