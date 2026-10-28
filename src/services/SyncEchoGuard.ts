export interface SyncEchoGuardOptions {
    /** Maximum number of reserved keys kept in memory. */
    max?: number;
    /** Default reservation lifetime in milliseconds. */
    defaultTtlMs?: number;
    /** Clock injection for tests. */
    now?: () => number;
}

/**
 * Loop prevention for mirrored sync actions.
 *
 * Mirrored actions re-emit events on the target platform. Messages avoid this
 * naturally (webhook echoes are ignored), but reactions, roles and channels
 * have no such marker, so mirrored actions reserve an expected echo key before
 * the API call and the resulting event is suppressed when it arrives.
 *
 * This is best-effort by design: a redundant mirror is idempotent (reacting
 * twice is a no-op, re-editing a channel converges), so the worst case is a
 * harmless duplicate, never a ping-pong loop.
 *
 * Additionally, events whose actor is the bridge bot itself should always be
 * ignored (see {@link SyncEchoGuard.isBridgeActor}).
 */
export default class SyncEchoGuard {
    static readonly DEFAULT_TTL_MS = 15_000;

    private readonly reservations = new Map<string, number>();
    private readonly max: number;
    private readonly defaultTtlMs: number;
    private readonly now: () => number;

    constructor(options: SyncEchoGuardOptions = {}) {
        this.max = options.max ?? 10_000;
        this.defaultTtlMs =
            options.defaultTtlMs ?? SyncEchoGuard.DEFAULT_TTL_MS;
        this.now = options.now ?? Date.now;
    }

    /**
     * We are about to perform an action; reserve the key its echo event will
     * carry. Key format: `{platform}:{action}:{targetId}:{qualifier}`, e.g.
     * `fluxer:reaction:add:9876543210:lemon` or
     * `discord:channel:update:1234:name`.
     *
     * If the action fails, the reservation simply expires.
     */
    expect(key: string, ttlMs?: number): void {
        this.prune();

        // Re-insert so the key is the newest entry (Map keeps insertion order).
        this.reservations.delete(key);
        this.reservations.set(key, this.now() + (ttlMs ?? this.defaultTtlMs));

        while (this.reservations.size > this.max) {
            const oldest = this.reservations.keys().next();
            if (oldest.done) break;
            this.reservations.delete(oldest.value);
        }
    }

    /** True (and consumes the reservation) when `key` is an expected echo. */
    isEcho(key: string): boolean {
        const expiresAt = this.reservations.get(key);
        if (expiresAt === undefined) return false;

        this.reservations.delete(key);
        return expiresAt > this.now();
    }

    /** Number of live (non-expired) reservations. */
    get size(): number {
        this.prune();
        return this.reservations.size;
    }

    clear(): void {
        this.reservations.clear();
    }

    /** Events authored by the bridge bot itself are always echoes. */
    static isBridgeActor(
        actorId: string | null,
        bridgeBotId: string | null
    ): boolean {
        return (
            actorId !== null && bridgeBotId !== null && actorId === bridgeBotId
        );
    }

    private prune(): void {
        const now = this.now();
        for (const [key, expiresAt] of this.reservations) {
            if (expiresAt > now) continue;
            this.reservations.delete(key);
        }
    }
}

/**
 * Process-wide guard shared by every sync handler (mirrored actions live in
 * both clients and must share reservations). Tests should instantiate
 * `SyncEchoGuard` directly instead.
 */
export const syncEchoGuard = new SyncEchoGuard();
