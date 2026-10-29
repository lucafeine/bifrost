import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactionCoalescer from './ReactionCoalescer';

describe('ReactionCoalescer', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('flushes once per key after the debounce window', async () => {
        const flushed: string[] = [];
        const coalescer = new ReactionCoalescer(async (key) => {
            flushed.push(key);
        }, 500);

        coalescer.schedule('discord:1');
        coalescer.schedule('discord:1');
        coalescer.schedule('discord:1');

        expect(coalescer.pending).toBe(1);

        await vi.advanceTimersByTimeAsync(499);
        expect(flushed).toEqual([]);

        await vi.advanceTimersByTimeAsync(1);
        expect(flushed).toEqual(['discord:1']);
        expect(coalescer.pending).toBe(0);
    });

    it('keeps independent keys independent', async () => {
        const flushed: string[] = [];
        const coalescer = new ReactionCoalescer(async (key) => {
            flushed.push(key);
        }, 100);

        coalescer.schedule('discord:1');
        coalescer.schedule('fluxer:2');

        await vi.advanceTimersByTimeAsync(100);
        expect(flushed.sort()).toEqual(['discord:1', 'fluxer:2']);
    });

    it('defers a key scheduled while its flush is in flight', async () => {
        const flushed: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let first = true;

        const coalescer = new ReactionCoalescer(async (key) => {
            flushed.push(key);
            if (first) {
                first = false;
                await gate;
            }
        }, 100);

        coalescer.schedule('discord:1');
        await vi.advanceTimersByTimeAsync(100);
        expect(flushed).toEqual(['discord:1']);

        // The first flush is still running: this timer fires while in flight.
        coalescer.schedule('discord:1');
        await vi.advanceTimersByTimeAsync(100);
        expect(flushed).toEqual(['discord:1']);

        // Release the flush; the deferred schedule runs after it.
        release();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(100);
        expect(flushed).toEqual(['discord:1', 'discord:1']);
    });

    it('reports flush errors to the error handler', async () => {
        const errors: unknown[] = [];
        const coalescer = new ReactionCoalescer(
            async () => {
                throw new Error('boom');
            },
            50,
            (error) => errors.push(error)
        );

        coalescer.schedule('discord:1');
        await vi.advanceTimersByTimeAsync(50);

        expect(errors).toHaveLength(1);
        expect((errors[0] as Error).message).toBe('boom');
    });
});
