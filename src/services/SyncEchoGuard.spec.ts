import { describe, expect, it } from 'vitest';
import SyncEchoGuard from './SyncEchoGuard';

describe('SyncEchoGuard', () => {
    it('consumes a reservation on the first echo match', () => {
        const guard = new SyncEchoGuard();

        guard.expect('fluxer:reaction:add:9876543210:lemon');

        expect(guard.isEcho('fluxer:reaction:add:9876543210:lemon')).toBe(true);
        // The reservation is consumed: the same key is not an echo twice.
        expect(guard.isEcho('fluxer:reaction:add:9876543210:lemon')).toBe(
            false
        );
    });

    it('returns false for unknown keys', () => {
        const guard = new SyncEchoGuard();

        expect(guard.isEcho('discord:channel:update:1234:name')).toBe(false);
    });

    it('expires reservations after their TTL', () => {
        let now = 0;
        const guard = new SyncEchoGuard({ now: () => now });

        guard.expect('discord:reaction:add:42:party', 15_000);

        now = 14_999;
        expect(guard.isEcho('discord:reaction:add:42:party')).toBe(true);

        guard.expect('discord:reaction:add:42:party', 15_000);

        now = 30_000;
        expect(guard.isEcho('discord:reaction:add:42:party')).toBe(false);
    });

    it('tracks concurrent keys independently', () => {
        const guard = new SyncEchoGuard();

        guard.expect('discord:reaction:add:1:lemon');
        guard.expect('fluxer:reaction:add:2:lemon');
        guard.expect('discord:reaction:add:1:party');

        expect(guard.isEcho('fluxer:reaction:add:2:lemon')).toBe(true);
        expect(guard.isEcho('discord:reaction:add:1:lemon')).toBe(true);
        expect(guard.isEcho('discord:reaction:add:1:party')).toBe(true);
        expect(guard.size).toBe(0);
    });

    it('keeps a per-key TTL override independent from the default', () => {
        let now = 0;
        const guard = new SyncEchoGuard({
            defaultTtlMs: 15_000,
            now: () => now,
        });

        guard.expect('discord:pin:add:7:99', 1_000);
        guard.expect('fluxer:pin:add:8:99');

        now = 1_500;
        expect(guard.isEcho('discord:pin:add:7:99')).toBe(false);
        expect(guard.isEcho('fluxer:pin:add:8:99')).toBe(true);
    });

    it('evicts beyond the max capacity without breaking lookups', () => {
        const guard = new SyncEchoGuard({ max: 2 });

        guard.expect('a');
        guard.expect('b');
        guard.expect('c');

        expect(guard.isEcho('a')).toBe(false);
        expect(guard.isEcho('b')).toBe(true);
        expect(guard.isEcho('c')).toBe(true);
    });

    it('detects events authored by the bridge bot itself', () => {
        expect(SyncEchoGuard.isBridgeActor('bot-1', 'bot-1')).toBe(true);
        expect(SyncEchoGuard.isBridgeActor('user-1', 'bot-1')).toBe(false);
        expect(SyncEchoGuard.isBridgeActor(null, 'bot-1')).toBe(false);
        expect(SyncEchoGuard.isBridgeActor('bot-1', null)).toBe(false);
    });
});
