import type {
    Client as FluxerClient,
    Message as FluxerMessage,
    MessageReaction as FluxerMessageReaction,
    ReactionEmojiPayload,
} from '@fluxerjs/core';
import type {
    Client as DiscordClient,
    Message as DiscordMessage,
    MessageReaction as DiscordMessageReaction,
    PartialMessageReaction,
} from 'discord.js';
import { ChannelLink } from '../../db/entities/ChannelLink';
import { GuildLink } from '../../db/entities/GuildLink';
import { MessageLink } from '../../db/entities/MessageLink';
import type { GuildLinkSettingsRepository } from '../../db/repositories/GuildLinkSettingsRepository';
import logger from '../../utils/logging/logger';
import type BridgeLogService from '../BridgeLogService';
import EmojiMapper, {
    MappedEmoji,
    SyncPlatform,
} from '../emojiMapping/EmojiMapper';
import type DiscordEntityResolver from '../entityResolver/DiscordEntityResolver';
import type FluxerEntityResolver from '../entityResolver/FluxerEntityResolver';
import type { LinkService } from '../LinkService';
import type MetricsService from '../MetricsService';
import ReactionCoalescer from './ReactionCoalescer';
import ReactionSuppressionStore from './ReactionSuppressionStore';
import {
    diffReactionKeys,
    emojiKeyFromInput,
    emojiKeyFromMapped,
} from './emojiKey';
import { countUserReactions } from './reactionCount';
import { isTolerableReactionError } from './reactionErrors';
import { ReactionEmojiInput, ReactionEvent } from './types';

type Direction = 'discord_to_fluxer' | 'fluxer_to_discord';

/**
 * - `applied`: the pair was reconciled.
 * - `deferred`: the same pair is already being reconciled (triggered from the
 *   other platform's key); the work is folded into that run.
 * - `retry`: nothing to reconcile *yet* (message link not written, transient
 *   error) — worth another attempt.
 * - `skipped`: nothing to reconcile (feature off, unusable state).
 */
type ReconcileOutcome = 'applied' | 'deferred' | 'retry' | 'skipped';

interface ReactionPlan {
    desired: Map<string, MappedEmoji>;
    toAdd: string[];
    toRemove: string[];
}

/** Reconcile state of one message pair (both platform keys map onto it). */
interface PairFlushState {
    running: boolean;
    again: boolean;
    cleared: Set<SyncPlatform>;
}

/**
 * Delays before re-attempting a reconcile whose message link is not (yet) in
 * the database: the link is written after the relay round-trip, so a reaction
 * on a just-posted message can beat it.
 */
const RETRY_DELAYS_MS = [1_000, 4_000];

export interface ReactionSyncServiceOptions {
    linkService: LinkService;
    settingsRepo: GuildLinkSettingsRepository;
    emojiMapper: EmojiMapper;
    discordEntityResolver: DiscordEntityResolver;
    fluxerEntityResolver: FluxerEntityResolver;
    metricsService?: MetricsService | null;
    bridgeLogService?: BridgeLogService | null;
    debounceMs?: number;
}

export function discordReactionEmoji(
    reaction: DiscordMessageReaction | PartialMessageReaction
): ReactionEmojiInput {
    return {
        id: reaction.emoji.id ?? null,
        name: reaction.emoji.name ?? '',
        animated: Boolean(reaction.emoji.animated),
    };
}

export function fluxerReactionEmoji(
    emoji: ReactionEmojiPayload
): ReactionEmojiInput {
    return {
        id: emoji.id ?? null,
        name: emoji.name,
        animated: Boolean(emoji.animated),
    };
}

/** Reactions that come from real users (the bridge bot's own reaction excluded). */
function collectDiscordUserEmojis(
    message: DiscordMessage
): ReactionEmojiInput[] {
    const emojis: ReactionEmojiInput[] = [];

    for (const reaction of message.reactions.cache.values()) {
        if (countUserReactions(reaction.count, reaction.me) <= 0) continue;
        emojis.push(discordReactionEmoji(reaction));
    }

    return emojis;
}

function collectFluxerUserEmojis(message: FluxerMessage): ReactionEmojiInput[] {
    const emojis: ReactionEmojiInput[] = [];

    for (const reaction of message.reactions.cache.values()) {
        if (countUserReactions(reaction.count, reaction.me) <= 0) continue;
        emojis.push(fluxerReactionEmoji(reaction.emoji));
    }

    return emojis;
}

function collectDiscordBotReactions(
    message: DiscordMessage
): Map<string, DiscordMessageReaction> {
    const reactions = new Map<string, DiscordMessageReaction>();

    for (const reaction of message.reactions.cache.values()) {
        if (!reaction.me) continue;
        reactions.set(
            emojiKeyFromInput(discordReactionEmoji(reaction)),
            reaction
        );
    }

    return reactions;
}

function collectFluxerBotReactions(
    message: FluxerMessage
): Map<string, FluxerMessageReaction> {
    const reactions = new Map<string, FluxerMessageReaction>();

    for (const reaction of message.reactions.cache.values()) {
        if (!reaction.me) continue;
        reactions.set(
            emojiKeyFromInput(fluxerReactionEmoji(reaction.emoji)),
            reaction
        );
    }

    return reactions;
}

/**
 * Mirrors reactions between paired messages (P2).
 *
 * Every reaction event only schedules a trailing debounce per source message
 * (bounded by a max wait so continuous bursts still make progress); the flush
 * fetches both sides fresh and reconciles the union of their **real** user
 * reactions. The bridge bot only reacts on a side when the emoji is missing
 * there (so reacting on both platforms never duplicates the emoji), and only
 * bridge-owned reactions are ever removed.
 *
 * A local removal is a durable veto: the mirror stays off on that side until
 * the emoji disappears from the other side or a local user re-adds it, so it
 * can never bounce back on a later event. Reconciles of the same pair are
 * serialized no matter which platform's key triggered them (bursts on both
 * sides would otherwise race each other), and every add/remove is applied
 * independently so one failed call cannot strand the rest of the plan.
 */
export default class ReactionSyncService {
    private readonly linkService: LinkService;
    private readonly settingsRepo: GuildLinkSettingsRepository;
    private readonly emojiMapper: EmojiMapper;
    private readonly discordEntityResolver: DiscordEntityResolver;
    private readonly fluxerEntityResolver: FluxerEntityResolver;
    private readonly metricsService: MetricsService | null;
    private readonly bridgeLogService: BridgeLogService | null;
    private readonly coalescer: ReactionCoalescer;
    private readonly suppressions = new ReactionSuppressionStore();
    private readonly pendingRemoveAll = new Set<string>();
    private readonly retryAttempts = new Map<string, number>();
    private readonly pairStates = new Map<string, PairFlushState>();

    private discordClient: DiscordClient | null = null;
    private fluxerClient: FluxerClient | null = null;

    constructor(options: ReactionSyncServiceOptions) {
        this.linkService = options.linkService;
        this.settingsRepo = options.settingsRepo;
        this.emojiMapper = options.emojiMapper;
        this.discordEntityResolver = options.discordEntityResolver;
        this.fluxerEntityResolver = options.fluxerEntityResolver;
        this.metricsService = options.metricsService ?? null;
        this.bridgeLogService = options.bridgeLogService ?? null;
        this.coalescer = new ReactionCoalescer(
            (key) => this.reconcileFromKey(key),
            options.debounceMs,
            (error) => logger.error('Reaction reconcile flush failed:', error)
        );
    }

    setDiscordClient(client: DiscordClient) {
        this.discordClient = client;
    }

    setFluxerClient(client: FluxerClient) {
        this.fluxerClient = client;
    }

    handleEvent(event: ReactionEvent): void {
        const botId =
            event.platform === 'discord'
                ? (this.discordClient?.user?.id ?? null)
                : (this.fluxerClient?.user?.id ?? null);

        if (
            event.actorId !== null &&
            botId !== null &&
            event.actorId === botId
        ) {
            this.metricsService?.syncEchoSuppressed.inc({ kind: 'reaction' });
            return;
        }

        if (event.emoji) {
            const key = emojiKeyFromInput(event.emoji);

            // A real user removed this reaction on this side: veto the mirror
            // there so it cannot bounce back. The veto is lifted when a local
            // user re-adds the emoji or the other side stops reacting with it.
            if (event.kind === 'remove' || event.kind === 'removeEmoji') {
                this.suppressions.suppress(
                    event.platform,
                    event.messageId,
                    key
                );
            } else if (event.kind === 'add') {
                // The user re-added it themselves: mirroring may resume.
                this.suppressions.unsuppress(
                    event.platform,
                    event.messageId,
                    key
                );
            }
        }

        if (event.kind === 'removeAll') {
            this.pendingRemoveAll.add(`${event.platform}:${event.messageId}`);
        }

        this.coalescer.schedule(`${event.platform}:${event.messageId}`);
    }

    private async reconcileFromKey(key: string): Promise<void> {
        const separator = key.indexOf(':');
        const platform = key.slice(0, separator) as SyncPlatform;
        const messageId = key.slice(separator + 1);

        // Peek instead of consuming: the clear-all survives retries and is
        // only dropped once the pair was actually reconciled (or handed over
        // to a reconcile that is already running).
        const suppressAllOn: SyncPlatform | null = this.pendingRemoveAll.has(
            key
        )
            ? platform
            : null;

        const outcome = await this.reconcile(
            platform,
            messageId,
            suppressAllOn
        );

        if (outcome === 'retry') {
            const attempt = (this.retryAttempts.get(key) ?? 0) + 1;
            if (attempt <= RETRY_DELAYS_MS.length) {
                this.retryAttempts.set(key, attempt);
                this.coalescer.schedule(key, RETRY_DELAYS_MS[attempt - 1]);
                return;
            }
        }

        this.retryAttempts.delete(key);
        this.pendingRemoveAll.delete(key);
    }

    private async reconcile(
        platform: SyncPlatform,
        messageId: string,
        suppressAllOn: SyncPlatform | null
    ): Promise<ReconcileOutcome> {
        const direction: Direction =
            platform === 'discord' ? 'discord_to_fluxer' : 'fluxer_to_discord';
        let guildLinkId: string | null = null;

        try {
            const messageLink =
                platform === 'discord'
                    ? await this.linkService.getMessageLinkByDiscordMessageId(
                          messageId
                      )
                    : await this.linkService.getMessageLinkByFluxerMessageId(
                          messageId
                      );
            if (!messageLink) {
                // Not a bridged message (predates the bridge, was never
                // relayed, or the relay has not written the link yet).
                return 'retry';
            }

            const channelLink = await this.linkService.getChannelLinkById(
                messageLink.channelLinkId
            );
            if (!channelLink) return 'skipped';

            const guildLink = await this.linkService.getGuildLinkById(
                messageLink.guildLinkId
            );
            if (!guildLink) return 'skipped';
            guildLinkId = guildLink.id;

            const settings = await this.settingsRepo.getOrCreate(guildLink.id);
            if (!settings.syncReactions) {
                this.metricsService?.syncEvents.inc({
                    kind: 'reaction',
                    direction,
                    result: 'skipped',
                });
                return 'skipped';
            }

            const result = await this.reconcilePairThroughGate(
                guildLink,
                channelLink,
                messageLink,
                suppressAllOn
            );
            if (result.deferred) return 'deferred';

            this.metricsService?.syncEvents.inc({
                kind: 'reaction',
                direction,
                result: result.changes > 0 ? 'ok' : 'skipped',
            });
            return 'applied';
        } catch (error) {
            if (isTolerableReactionError(error)) {
                // The pair vanished under us (message deleted, ...): nothing
                // left to reconcile.
                logger.debug(
                    'Reaction sync: skipping reconcile, pair is gone:',
                    error
                );
                this.metricsService?.syncEvents.inc({
                    kind: 'reaction',
                    direction,
                    result: 'skipped',
                });
                return 'skipped';
            }

            logger.error('Reaction sync failed:', error);
            this.metricsService?.syncEvents.inc({
                kind: 'reaction',
                direction,
                result: 'error',
            });
            if (guildLinkId) {
                this.bridgeLogService
                    ?.post(
                        guildLinkId,
                        'error',
                        `Reaction sync failed: ${error instanceof Error ? error.message : String(error)}`
                    )
                    .catch((logError) =>
                        logger.error('Bridge log post failed:', logError)
                    );
            }
            // Likely transient: retry so the suppressions carried by this
            // flush are not lost.
            return 'retry';
        }
    }

    /**
     * Runs {@link reconcilePair} under a per-pair gate. Both platform keys of a
     * pair resolve to the same message link, so their flushes must never run
     * concurrently: a flush that arrives while the pair is being reconciled is
     * folded into another iteration of the running one.
     */
    private async reconcilePairThroughGate(
        guildLink: GuildLink,
        channelLink: ChannelLink,
        messageLink: MessageLink,
        suppressAllOn: SyncPlatform | null
    ): Promise<{ deferred: true } | { deferred: false; changes: number }> {
        const pairKey = messageLink.id;
        let state = this.pairStates.get(pairKey);
        if (!state) {
            state = { running: false, again: false, cleared: new Set() };
            this.pairStates.set(pairKey, state);
        }

        if (suppressAllOn) state.cleared.add(suppressAllOn);

        if (state.running) {
            state.again = true;
            return { deferred: true };
        }

        state.running = true;
        try {
            let changes = 0;
            do {
                state.again = false;
                const cleared = state.cleared;
                state.cleared = new Set();
                changes = await this.reconcilePair(
                    guildLink,
                    channelLink,
                    messageLink,
                    cleared
                );
            } while (state.again);

            return { deferred: false, changes };
        } finally {
            state.running = false;
            // Safe: from the `while` check above up to here there is no await,
            // so nothing can have set `again` in between.
            this.pairStates.delete(pairKey);
        }
    }

    private async reconcilePair(
        guildLink: GuildLink,
        channelLink: ChannelLink,
        messageLink: MessageLink,
        cleared: Set<SyncPlatform>
    ): Promise<number> {
        const [discordMessage, fluxerMessage] = await Promise.all([
            this.discordEntityResolver.fetchMessage(
                guildLink.discordGuildId,
                channelLink.discordChannelId,
                messageLink.discordMessageId,
                { force: true }
            ),
            this.fluxerEntityResolver.fetchMessage(
                guildLink.fluxerGuildId,
                channelLink.fluxerChannelId,
                messageLink.fluxerMessageId
                // Fluxer's fetch always goes to the API, no force needed.
            ),
        ]);

        const discordUserEmojis = collectDiscordUserEmojis(discordMessage);
        const fluxerUserEmojis = collectFluxerUserEmojis(fluxerMessage);
        const discordUserKeys = new Set(
            discordUserEmojis.map(emojiKeyFromInput)
        );
        const fluxerUserKeys = new Set(fluxerUserEmojis.map(emojiKeyFromInput));

        const discordBotReactions = collectDiscordBotReactions(discordMessage);
        const fluxerBotReactions = collectFluxerBotReactions(fluxerMessage);

        // The bridge only adds an emoji on a side where no real user has it.
        const discordPlan = await this.planReactions(
            fluxerUserEmojis,
            'fluxer',
            guildLink.fluxerGuildId,
            'discord',
            guildLink.discordGuildId,
            discordMessage.id,
            discordUserKeys,
            discordBotReactions.keys(),
            cleared.has('discord')
        );
        const fluxerPlan = await this.planReactions(
            discordUserEmojis,
            'discord',
            guildLink.discordGuildId,
            'fluxer',
            guildLink.fluxerGuildId,
            fluxerMessage.id,
            fluxerUserKeys,
            fluxerBotReactions.keys(),
            cleared.has('fluxer')
        );

        let changes = 0;
        changes += await this.applyDiscordPlan(
            discordMessage,
            discordPlan,
            discordBotReactions
        );
        changes += await this.applyFluxerPlan(
            fluxerMessage,
            fluxerPlan,
            fluxerBotReactions
        );

        return changes;
    }

    private async applyDiscordPlan(
        message: DiscordMessage,
        plan: ReactionPlan,
        current: Map<string, DiscordMessageReaction>
    ): Promise<number> {
        let changes = 0;

        for (const key of plan.toAdd) {
            const mapped = plan.desired.get(key) as MappedEmoji;
            try {
                await message.react(mapped.value);
                changes++;
            } catch (error) {
                this.reportReactionError('mirror add', error);
            }
        }

        const botId = this.discordClient?.user?.id ?? null;
        for (const key of plan.toRemove) {
            if (!botId) {
                logger.warn(
                    'Reaction sync: Discord bot id unavailable, cannot remove mirrored reaction'
                );
                break;
            }

            const reaction = current.get(key);
            if (!reaction) continue;

            try {
                await reaction.users.remove(botId);
                changes++;
            } catch (error) {
                this.reportReactionError('mirror remove', error);
            }
        }

        return changes;
    }

    private async applyFluxerPlan(
        message: FluxerMessage,
        plan: ReactionPlan,
        current: Map<string, FluxerMessageReaction>
    ): Promise<number> {
        let changes = 0;

        for (const key of plan.toAdd) {
            const mapped = plan.desired.get(key) as MappedEmoji;
            try {
                await message.react(mapped.value);
                changes++;
            } catch (error) {
                this.reportReactionError('mirror add', error);
            }
        }

        for (const key of plan.toRemove) {
            const reaction = current.get(key);
            if (!reaction) continue;

            try {
                await message.removeReaction(reaction.emojiIdentifier);
                changes++;
            } catch (error) {
                this.reportReactionError('mirror remove', error);
            }
        }

        return changes;
    }

    private reportReactionError(operation: string, error: unknown): void {
        if (isTolerableReactionError(error)) {
            logger.debug(
                `Reaction sync: ${operation} skipped, target state is gone:`,
                error
            );
            return;
        }

        logger.warn(`Reaction sync: ${operation} failed:`, error);
    }

    private async planReactions(
        sourceEmojis: ReactionEmojiInput[],
        sourcePlatform: SyncPlatform,
        sourceGuildId: string,
        targetPlatform: SyncPlatform,
        targetGuildId: string,
        targetMessageId: string,
        targetUserKeys: Set<string>,
        currentBotKeys: Iterable<string>,
        suppressAll: boolean
    ): Promise<ReactionPlan> {
        const mappedEmojis: { key: string; mapped: MappedEmoji }[] = [];

        for (const emoji of sourceEmojis) {
            const mapped = await this.emojiMapper.resolve(
                {
                    platform: sourcePlatform,
                    id: emoji.id,
                    name: emoji.name,
                    animated: emoji.animated,
                    sourceGuildId,
                },
                targetPlatform,
                targetGuildId
            );

            if (!mapped) {
                logger.debug(
                    `Reaction sync: cannot map emoji "${emoji.name}" (${sourcePlatform} -> ${targetPlatform}), skipping`
                );
                continue;
            }

            mappedEmojis.push({ key: emojiKeyFromMapped(mapped), mapped });
        }

        const sourceMappedKeys = new Set(mappedEmojis.map(({ key }) => key));

        // A clear-all on the target side vetoes the current emoji set (a
        // moderator explicitly cleared the reactions there).
        if (suppressAll) {
            this.suppressions.suppressMany(
                targetPlatform,
                targetMessageId,
                sourceMappedKeys
            );
        }
        this.suppressions.reconcile(
            targetPlatform,
            targetMessageId,
            sourceMappedKeys
        );

        const desired = new Map<string, MappedEmoji>();

        for (const { key, mapped } of mappedEmojis) {
            // A real user on the target already has this emoji: no bot mirror.
            if (targetUserKeys.has(key)) continue;
            // A user removed the mirror on that side: keep it removed while
            // the emoji remains on the source side (the veto lifts when the
            // source drops it or a local user re-adds it).
            if (
                this.suppressions.isSuppressed(
                    targetPlatform,
                    targetMessageId,
                    key
                )
            ) {
                continue;
            }

            desired.set(key, mapped);
        }

        const { toAdd, toRemove } = diffReactionKeys(
            desired.keys(),
            currentBotKeys
        );

        return { desired, toAdd, toRemove };
    }
}
