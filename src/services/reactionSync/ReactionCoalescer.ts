type Timer = ReturnType<typeof setTimeout>;

/**
 * Trailing debounce per key (one flush per message), plus re-entrancy guard:
 * if a key is already being flushed, the next schedule is deferred until the
 * flush finishes instead of running concurrently.
 */
export default class ReactionCoalescer {
    private readonly timers = new Map<string, Timer>();
    private readonly inFlight = new Set<string>();
    private readonly dirty = new Set<string>();

    constructor(
        private readonly onFlush: (key: string) => Promise<void>,
        private readonly debounceMs = 500,
        private readonly onError: (error: unknown) => void = () => undefined
    ) {}

    schedule(key: string): void {
        const existing = this.timers.get(key);
        if (existing) clearTimeout(existing);

        this.timers.set(
            key,
            setTimeout(() => {
                this.timers.delete(key);
                void this.flush(key);
            }, this.debounceMs)
        );
    }

    /** Number of pending (not yet started) flushes. */
    get pending(): number {
        return this.timers.size;
    }

    clear(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        this.dirty.clear();
    }

    private async flush(key: string): Promise<void> {
        if (this.inFlight.has(key)) {
            this.dirty.add(key);
            return;
        }

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
