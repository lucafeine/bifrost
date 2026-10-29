import type { Client as DiscordClient } from 'discord.js';
import type { Client as FluxerClient } from '@fluxerjs/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuildLinkSettingsRepository } from '../../db/repositories/GuildLinkSettingsRepository';
import EmojiMapper from '../emojiMapping/EmojiMapper';
import type DiscordEntityResolver from '../entityResolver/DiscordEntityResolver';
import type FluxerEntityResolver from '../entityResolver/FluxerEntityResolver';
import type { LinkService } from '../LinkService';
import ReactionSyncService from './ReactionSyncService';
import { ReactionEvent, ReactionEventKind } from './types';

// The logger pulls in env validation (bot tokens) at import time.
vi.mock('../../utils/logging/logger', () => ({
    default: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

const DISCORD_BOT_ID = 'bot-discord';
const FLUXER_BOT_ID = 'bot-fluxer';

interface FakeReaction {
    count: number;
    me: boolean;
    emoji: { id: string | null; name: string; animated: boolean };
    emojiIdentifier?: string;
    users?: { remove: ReturnType<typeof vi.fn> };
}

function userReaction(
    cache: Map<string, FakeReaction>,
    key: string,
    name: string
): void {
    cache.set(key, {
        count: 1,
        me: false,
        emoji: { id: null, name, animated: false },
        emojiIdentifier: name,
        users: { remove: vi.fn(async () => undefined) },
    });
}

function botReaction(
    cache: Map<string, FakeReaction>,
    key: string,
    name: string
): void {
    cache.set(key, {
        count: 1,
        me: true,
        emoji: { id: null, name, animated: false },
        emojiIdentifier: name,
        users: { remove: vi.fn(async () => undefined) },
    });
}

function event(
    platform: 'discord' | 'fluxer',
    kind: ReactionEventKind,
    actorId: string | null,
    name: string | null
): ReactionEvent {
    return {
        platform,
        kind,
        channelId: platform === 'discord' ? 'dc1' : 'fc1',
        messageId: platform === 'discord' ? 'd1' : 'f1',
        actorId,
        emoji: name ? { id: null, name, animated: false } : null,
    };
}

function makeFixture(options: { fetchDelayMs?: number } = {}) {
    const fetchDelayMs = options.fetchDelayMs ?? 0;

    const discordReactions = new Map<string, FakeReaction>();
    const fluxerReactions = new Map<string, FakeReaction>();

    const discordMessage = {
        id: 'd1',
        reactions: { cache: discordReactions },
        react: vi.fn(async () => undefined),
    };
    const fluxerMessage = {
        id: 'f1',
        reactions: { cache: fluxerReactions },
        react: vi.fn(async () => undefined),
        removeReaction: vi.fn(async () => undefined),
    };

    const messageLink = {
        id: 'link1',
        guildLinkId: 'gl1',
        channelLinkId: 'cl1',
        discordMessageId: 'd1',
        fluxerMessageId: 'f1',
    };

    const linkService = {
        getMessageLinkByDiscordMessageId: vi.fn(async (id: string) =>
            id === 'd1' ? messageLink : null
        ),
        getMessageLinkByFluxerMessageId: vi.fn(async (id: string) =>
            id === 'f1' ? messageLink : null
        ),
        getChannelLinkById: vi.fn(async () => ({
            id: 'cl1',
            guildLinkId: 'gl1',
            discordChannelId: 'dc1',
            fluxerChannelId: 'fc1',
        })),
        getGuildLinkById: vi.fn(async () => ({
            id: 'gl1',
            discordGuildId: 'dg1',
            fluxerGuildId: 'fg1',
        })),
    };

    const settingsRepo = {
        getOrCreate: vi.fn(async () => ({ syncReactions: true })),
    };

    const fetchState = { inFlight: 0, maxInFlight: 0 };
    const track = async <T>(value: T): Promise<T> => {
        fetchState.inFlight++;
        fetchState.maxInFlight = Math.max(
            fetchState.maxInFlight,
            fetchState.inFlight
        );
        if (fetchDelayMs > 0) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, fetchDelayMs);
            });
        } else {
            await Promise.resolve();
        }
        fetchState.inFlight--;
        return value;
    };

    const discordEntityResolver = {
        fetchMessage: vi.fn(async () => track(discordMessage)),
    };
    const fluxerEntityResolver = {
        fetchMessage: vi.fn(async () => track(fluxerMessage)),
    };

    const service = new ReactionSyncService({
        linkService: linkService as unknown as LinkService,
        settingsRepo: settingsRepo as unknown as GuildLinkSettingsRepository,
        emojiMapper: new EmojiMapper(),
        discordEntityResolver:
            discordEntityResolver as unknown as DiscordEntityResolver,
        fluxerEntityResolver:
            fluxerEntityResolver as unknown as FluxerEntityResolver,
        debounceMs: 20,
    });

    service.setDiscordClient({
        user: { id: DISCORD_BOT_ID },
    } as unknown as DiscordClient);
    service.setFluxerClient({
        user: { id: FLUXER_BOT_ID },
    } as unknown as FluxerClient);

    return {
        service,
        discordMessage,
        fluxerMessage,
        discordReactions,
        fluxerReactions,
        discordEntityResolver,
        fluxerEntityResolver,
        linkService,
        messageLink,
        fetchState,
    };
}

describe('ReactionSyncService', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('mirrors real user reactions from the other side with a stand-in', async () => {
        const f = makeFixture();
        userReaction(f.fluxerReactions, 'u:🍋', '🍋');

        f.service.handleEvent(event('fluxer', 'add', 'user-1', '🍋'));
        await vi.advanceTimersByTimeAsync(100);

        expect(f.discordMessage.react).toHaveBeenCalledTimes(1);
        expect(f.discordMessage.react).toHaveBeenCalledWith('🍋');
        expect(f.fluxerMessage.react).not.toHaveBeenCalled();
        expect(f.fluxerMessage.removeReaction).not.toHaveBeenCalled();
    });

    it('never double-mirrors an emoji a real user already has on the target', async () => {
        const f = makeFixture();
        userReaction(f.fluxerReactions, 'u:🍋', '🍋');
        userReaction(f.discordReactions, 'u:🍋', '🍋');

        f.service.handleEvent(event('fluxer', 'add', 'user-1', '🍋'));
        await vi.advanceTimersByTimeAsync(100);

        expect(f.discordMessage.react).not.toHaveBeenCalled();
        expect(f.fluxerMessage.react).not.toHaveBeenCalled();
    });

    it('propagates a removal to the other side', async () => {
        const f = makeFixture();
        userReaction(f.discordReactions, 'u:🍋', '🍋');
        botReaction(f.fluxerReactions, 'u:🍋', '🍋');

        f.discordReactions.delete('u:🍋');
        f.service.handleEvent(event('discord', 'remove', 'user-1', '🍋'));
        await vi.advanceTimersByTimeAsync(100);

        expect(f.fluxerMessage.removeReaction).toHaveBeenCalledWith('🍋');
        expect(f.discordMessage.react).not.toHaveBeenCalled();
    });

    it('keeps a local removal removed across later reconciles (no bounce-back)', async () => {
        const f = makeFixture();
        userReaction(f.fluxerReactions, 'u:🍋', '🍋');
        userReaction(f.discordReactions, 'u:🍋', '🍋');

        // The Discord user removes their own reaction.
        f.discordReactions.delete('u:🍋');
        f.service.handleEvent(event('discord', 'remove', 'user-1', '🍋'));
        await vi.advanceTimersByTimeAsync(100);

        expect(f.discordMessage.react).not.toHaveBeenCalled();

        // Any later event on the message must not resurrect the emoji on the
        // side where it was removed.
        userReaction(f.fluxerReactions, 'u:🎉', '🎉');
        f.service.handleEvent(event('fluxer', 'add', 'user-2', '🎉'));
        await vi.advanceTimersByTimeAsync(100);

        expect(f.discordMessage.react).not.toHaveBeenCalledWith('🍋');
        expect(f.discordMessage.react).toHaveBeenCalledTimes(1);
        expect(f.discordMessage.react).toHaveBeenCalledWith('🎉');
    });

    it('lifts the veto once the emoji disappears from the source and comes back', async () => {
        const f = makeFixture();
        userReaction(f.fluxerReactions, 'u:🍋', '🍋');
        userReaction(f.discordReactions, 'u:🍋', '🍋');

        f.discordReactions.delete('u:🍋');
        f.service.handleEvent(event('discord', 'remove', 'user-1', '🍋'));
        await vi.advanceTimersByTimeAsync(100);
        expect(f.discordMessage.react).not.toHaveBeenCalled();

        // The source side drops the emoji entirely.
        f.fluxerReactions.delete('u:🍋');
        f.service.handleEvent(event('fluxer', 'remove', 'user-1', '🍋'));
        await vi.advanceTimersByTimeAsync(100);

        // A brand-new source reaction mirrors again.
        userReaction(f.fluxerReactions, 'u:🍋', '🍋');
        f.service.handleEvent(event('fluxer', 'add', 'user-1', '🍋'));
        await vi.advanceTimersByTimeAsync(100);

        expect(f.discordMessage.react).toHaveBeenCalledWith('🍋');
    });

    it('clear-all removes the mirrors and vetoes the current set', async () => {
        const f = makeFixture();
        userReaction(f.fluxerReactions, 'u:🍋', '🍋');
        botReaction(f.discordReactions, 'u:🍋', '🍋');

        f.service.handleEvent(event('discord', 'removeAll', null, null));
        await vi.advanceTimersByTimeAsync(100);

        const mirror = f.discordReactions.get('u:🍋')?.users?.remove;
        expect(mirror).toHaveBeenCalledWith(DISCORD_BOT_ID);

        // The cleared side keeps the current emoji set vetoed.
        userReaction(f.fluxerReactions, 'u:🎉', '🎉');
        f.service.handleEvent(event('fluxer', 'add', 'user-2', '🎉'));
        await vi.advanceTimersByTimeAsync(100);

        expect(f.discordMessage.react).not.toHaveBeenCalledWith('🍋');
    });

    it('serializes reconciles of the same pair across both platforms', async () => {
        const f = makeFixture({ fetchDelayMs: 50 });

        userReaction(f.fluxerReactions, 'u:🍋', '🍋');
        userReaction(f.discordReactions, 'u:🎉', '🎉');

        f.service.handleEvent(event('discord', 'add', 'user-1', '🎉'));
        f.service.handleEvent(event('fluxer', 'add', 'user-2', '🍋'));
        await vi.advanceTimersByTimeAsync(500);

        // One reconcile fetches both sides (2); two concurrent reconciles of
        // the same pair would fetch 4 at once.
        expect(f.fetchState.maxInFlight).toBeLessThanOrEqual(2);

        // Both emojis converge on both sides.
        expect(f.discordMessage.react).toHaveBeenCalledWith('🍋');
        expect(f.fluxerMessage.react).toHaveBeenCalledWith('🎉');
    });

    it('keeps applying the rest of the plan when one reaction call fails', async () => {
        const f = makeFixture();
        userReaction(f.fluxerReactions, 'u:🍋', '🍋');
        userReaction(f.fluxerReactions, 'u:🎉', '🎉');

        f.discordMessage.react = vi.fn(async (value: string) => {
            if (value === '🍋') {
                throw Object.assign(new Error('Unknown Emoji'), {
                    code: 10014,
                });
            }
        });

        f.service.handleEvent(event('fluxer', 'add', 'user-1', '🍋'));
        f.service.handleEvent(event('fluxer', 'add', 'user-2', '🎉'));
        await vi.advanceTimersByTimeAsync(100);

        expect(f.discordMessage.react).toHaveBeenCalledWith('🍋');
        expect(f.discordMessage.react).toHaveBeenCalledWith('🎉');
    });

    it('ignores the bridge bot own reaction events', async () => {
        const f = makeFixture();

        f.service.handleEvent(event('fluxer', 'add', FLUXER_BOT_ID, '🍋'));
        f.service.handleEvent(event('discord', 'remove', DISCORD_BOT_ID, '🍋'));
        await vi.advanceTimersByTimeAsync(100);

        expect(f.discordEntityResolver.fetchMessage).not.toHaveBeenCalled();
        expect(f.fluxerEntityResolver.fetchMessage).not.toHaveBeenCalled();
    });

    it('retries when the message link is not written yet', async () => {
        const f = makeFixture();
        userReaction(f.fluxerReactions, 'u:🍋', '🍋');

        let linkCalls = 0;
        f.linkService.getMessageLinkByFluxerMessageId.mockImplementation(
            async () => {
                linkCalls++;
                return linkCalls < 2 ? null : f.messageLink;
            }
        );

        f.service.handleEvent(event('fluxer', 'add', 'user-1', '🍋'));
        await vi.advanceTimersByTimeAsync(100);
        expect(f.discordMessage.react).not.toHaveBeenCalled();

        // First retry lands 1 s later and finds the link.
        await vi.advanceTimersByTimeAsync(1_100);
        expect(f.discordMessage.react).toHaveBeenCalledWith('🍋');
    });
});
