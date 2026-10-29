type Timer = ReturnType<typeof setTimeout>;

/**
 * Trailing debounce per key (one flush per message), plus re-entrancy guard:
 * if a key is already being flushed, the next schedule is deferred until the
 * flush finishes instead of running concurrently.
 *
 * A max wait bounds the debounce: under continuous scheduling (reaction spam)
 * the trailing timer would otherwise be reset forever and the flush starved.
 */
export default class ReactionCoalescer {
    private readonly timers = new Map<string, Timer>();
    private readonly deadlines = new Map<string, number>();
    private readonly inFlight = new Set<string>();
    private readonly dirty = new Set<string>();

    constructor(
        private readonly onFlush: (key: string) => Promise<void>,
        private readonly debounceMs = 500,
        private readonly onError: (error: unknown) => void = () => undefined,
        private readonly maxWaitMs = debounceMs * 4
    ) {}

    /**
     * Schedules a flush. Without an explicit `delayMs` the trailing debounce
     * applies (bounded by the max wait); with one the flush runs after exactly
     * that delay (used for retries).
     */
    schedule(key: string, delayMs?: number): void {
        const existing = this.timers.get(key);
        if (existing) clearTimeout(existing);

        let delay = delayMs ?? this.debounceMs;
        if (delayMs === undefined) {
            const now = Date.now();
            const deadline = this.deadlines.get(key) ?? now + this.maxWaitMs;
            this.deadlines.set(key, deadline);
            delay = Math.min(delay, Math.max(0, deadline - now));
        }

        this.timers.set(
            key,
            setTimeout(() => {
                this.timers.delete(key);
                void this.flush(key);
            }, delay)
        );
    }

    /** Number of pending (not yet started) flushes. */
    get pending(): number {
        return this.timers.size;
    }

    clear(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        this.deadlines.clear();
        this.dirty.clear();
    }

    private async flush(key: string): Promise<void> {
        if (this.inFlight.has(key)) {
            this.dirty.add(key);
            return;
        }

        this.deadlines.delete(key);
        this.inFlight.add(key);
        try {
            await this.onFlush(key);
        } catch (error) {
            this.onError(error);
        } finally {
            this.inFlight.delete(key);
            if (this.dirty.delete(key)) this.schedule(key);
        }
    }
}
