import { describe, expect, it } from 'vitest';
import ReactionSuppressionStore from './ReactionSuppressionStore';

describe('ReactionSuppressionStore', () => {
    it('suppresses per emoji on a message', () => {
        const store = new ReactionSuppressionStore();

        store.suppress('discord', 'm1', 'u:🍋');

        expect(store.isSuppressed('discord', 'm1', 'u:🍋')).toBe(true);
        expect(store.isSuppressed('discord', 'm1', 'u:🎉')).toBe(false);
        expect(store.isSuppressed('discord', 'm2', 'u:🍋')).toBe(false);
        expect(store.isSuppressed('fluxer', 'm1', 'u:🍋')).toBe(false);
    });

    it('lifts suppression once the source no longer has the emoji', () => {
        const store = new ReactionSuppressionStore();

        store.suppress('discord', 'm1', 'u:🍋');
        store.reconcile('discord', 'm1', new Set(['u:🍋']));
        expect(store.isSuppressed('discord', 'm1', 'u:🍋')).toBe(true);

        store.reconcile('discord', 'm1', new Set());
        expect(store.isSuppressed('discord', 'm1', 'u:🍋')).toBe(false);

        // A later reaction can be mirrored again.
        store.reconcile('discord', 'm1', new Set(['u:🍋']));
        expect(store.isSuppressed('discord', 'm1', 'u:🍋')).toBe(false);
    });

    it('supports bulk suppression', () => {
        const store = new ReactionSuppressionStore();

        store.suppressMany('fluxer', 'm1', ['u:🍋', 'u:🎉']);

        expect(store.isSuppressed('fluxer', 'm1', 'u:🍋')).toBe(true);
        expect(store.isSuppressed('fluxer', 'm1', 'u:🎉')).toBe(true);
    });

    it('stays bounded', () => {
        const store = new ReactionSuppressionStore(2);

        store.suppress('discord', 'm1', 'u:🍋');
        store.suppress('discord', 'm1', 'u:🎉');
        store.suppress('discord', 'm2', 'u:🍋');

        expect(store.isSuppressed('discord', 'm1', 'u:🍋')).toBe(false);
        expect(store.isSuppressed('discord', 'm1', 'u:🎉')).toBe(false);
        expect(store.isSuppressed('discord', 'm2', 'u:🍋')).toBe(true);
    });
});
