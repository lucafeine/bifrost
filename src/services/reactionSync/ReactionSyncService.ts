import type {
    Client as FluxerClient,
    MessageReaction as FluxerMessageReaction,
    ReactionEmojiPayload,
} from '@fluxerjs/core';
import type {
    Client as DiscordClient,
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
import SyncEchoGuard, { syncEchoGuard } from '../SyncEchoGuard';
import ReactionCoalescer from './ReactionCoalescer';
import {
    diffReactionKeys,
    emojiKeyFromInput,
    emojiKeyFromMapped,
} from './emojiKey';
import { ReactionEmojiInput, ReactionEvent } from './types';

type Direction = 'discord_to_fluxer' | 'fluxer_to_discord';

export interface ReactionSyncServiceOptions {
    linkService: LinkService;
    settingsRepo: GuildLinkSettingsRepository;
    emojiMapper: EmojiMapper;
    discordEntityResolver: DiscordEntityResolver;
    fluxerEntityResolver: FluxerEntityResolver;
    metricsService?: MetricsService | null;
    bridgeLogService?: BridgeLogService | null;
    echoGuard?: Pick<SyncEchoGuard, 'expect' | 'isEcho'>;
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

function fluxerEmojiInput(reaction: FluxerMessageReaction): ReactionEmojiInput {
    return fluxerReactionEmoji(reaction.emoji);
}

/**
 * Mirrors reactions between paired messages (P2).
 *
 * Every reaction event only schedules a trailing debounce per source message;
 * the flush reconciles the aggregate emoji sets (source reactions vs the
 * bridge-owned reactions on the target) and applies the diff. This absorbs
 * bursts and makes the mirror self-healing.
 */
export default class ReactionSyncService {
    private readonly linkService: LinkService;
    private readonly settingsRepo: GuildLinkSettingsRepository;
    private readonly emojiMapper: EmojiMapper;
    private readonly discordEntityResolver: DiscordEntityResolver;
    private readonly fluxerEntityResolver: FluxerEntityResolver;
    private readonly metricsService: MetricsService | null;
    private readonly bridgeLogService: BridgeLogService | null;
    private readonly echoGuard: Pick<SyncEchoGuard, 'expect' | 'isEcho'>;
    private readonly coalescer: ReactionCoalescer;

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
        this.echoGuard = options.echoGuard ?? syncEchoGuard;
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

        if (SyncEchoGuard.isBridgeActor(event.actorId, botId)) {
            this.metricsService?.syncEchoSuppressed.inc({ kind: 'reaction' });
            return;
        }

        if (event.emoji) {
            const echoKey = `${event.platform}:reaction:${event.kind}:${event.messageId}:${emojiKeyFromInput(event.emoji)}`;
            if (this.echoGuard.isEcho(echoKey)) {
                this.metricsService?.syncEchoSuppressed.inc({
                    kind: 'reaction',
                });
                return;
            }
        }

        this.coalescer.schedule(`${event.platform}:${event.messageId}`);
    }

    private async reconcileFromKey(key: string): Promise<void> {
        const separator = key.indexOf(':');
        const platform = key.slice(0, separator) as SyncPlatform;
        const messageId = key.slice(separator + 1);

        await this.reconcile(platform, messageId);
    }

    private async reconcile(
        platform: SyncPlatform,
        messageId: string
    ): Promise<void> {
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
                // Not a bridged message (predates the bridge or was never relayed).
                return;
            }

            const channelLink = await this.linkService.getChannelLinkById(
                messageLink.channelLinkId
            );
            if (!channelLink) return;

            const guildLink = await this.linkService.getGuildLinkById(
                messageLink.guildLinkId
            );
            if (!guildLink) return;
            guildLinkId = guildLink.id;

            const settings = await this.settingsRepo.getOrCreate(guildLink.id);
            if (!settings.syncReactions) {
                this.metricsService?.syncEvents.inc({
                    kind: 'reaction',
                    direction,
                    result: 'skipped',
                });
                return;
            }

            const changes =
                platform === 'discord'
                    ? await this.reconcileDiscordSource(
                          guildLink,
                          channelLink,
                          messageLink
                      )
                    : await this.reconcileFluxerSource(
                          guildLink,
                          channelLink,
                          messageLink
                      );

            this.metricsService?.syncEvents.inc({
                kind: 'reaction',
                direction,
                result: changes > 0 ? 'ok' : 'skipped',
            });
        } catch (error) {
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
        }
    }

    private async reconcileDiscordSource(
        guildLink: GuildLink,
        channelLink: ChannelLink,
        messageLink: MessageLink
    ): Promise<number> {
        const sourceMessage = await this.discordEntityResolver.fetchMessage(
            guildLink.discordGuildId,
            channelLink.discordChannelId,
            messageLink.discordMessageId
        );
        const targetMessage = await this.fluxerEntityResolver.fetchMessage(
            guildLink.fluxerGuildId,
            channelLink.fluxerChannelId,
            messageLink.fluxerMessageId
        );

        const sourceEmojis = [...sourceMessage.reactions.cache.values()].map(
            (reaction) => discordReactionEmoji(reaction)
        );
        const current = new Map<string, FluxerMessageReaction>();
        for (const reaction of targetMessage.reactions.cache.values()) {
            if (!reaction.me) continue;
            current.set(
                emojiKeyFromInput(fluxerEmojiInput(reaction)),
                reaction
            );
        }

        const plan = await this.planReactions(
            sourceEmojis,
            'discord',
            guildLink.discordGuildId,
            'fluxer',
            guildLink.fluxerGuildId,
            current.keys()
        );

        for (const key of plan.toAdd) {
            const mapped = plan.desired.get(key) as MappedEmoji;
            this.echoGuard.expect(
                `fluxer:reaction:add:${targetMessage.id}:${key}`
            );
            await targetMessage.react(mapped.value);
        }

        for (const key of plan.toRemove) {
            const reaction = current.get(key) as FluxerMessageReaction;
            this.echoGuard.expect(
                `fluxer:reaction:remove:${targetMessage.id}:${key}`
            );
            await targetMessage.removeReaction(reaction.emojiIdentifier);
        }

        return plan.toAdd.length + plan.toRemove.length;
    }

    private async reconcileFluxerSource(
        guildLink: GuildLink,
        channelLink: ChannelLink,
        messageLink: MessageLink
    ): Promise<number> {
        const sourceMessage = await this.fluxerEntityResolver.fetchMessage(
            guildLink.fluxerGuildId,
            channelLink.fluxerChannelId,
            messageLink.fluxerMessageId
        );
        const targetMessage = await this.discordEntityResolver.fetchMessage(
            guildLink.discordGuildId,
            channelLink.discordChannelId,
            messageLink.discordMessageId
        );

        const sourceEmojis = [...sourceMessage.reactions.cache.values()].map(
            fluxerEmojiInput
        );
        const current = new Map<string, DiscordMessageReaction>();
        for (const reaction of targetMessage.reactions.cache.values()) {
            if (!reaction.me) continue;
            current.set(
                emojiKeyFromInput(discordReactionEmoji(reaction)),
                reaction
            );
        }

        const plan = await this.planReactions(
            sourceEmojis,
            'fluxer',
            guildLink.fluxerGuildId,
            'discord',
            guildLink.discordGuildId,
            current.keys()
        );

        for (const key of plan.toAdd) {
            const mapped = plan.desired.get(key) as MappedEmoji;
            this.echoGuard.expect(
                `discord:reaction:add:${targetMessage.id}:${key}`
            );
            await targetMessage.react(mapped.value);
        }

        const botId = this.discordClient?.user?.id ?? null;
        for (const key of plan.toRemove) {
            if (!botId) {
                logger.warn(
                    'Reaction sync: Discord bot id unavailable, cannot remove mirrored reaction'
                );
                break;
            }
            const reaction = current.get(key) as DiscordMessageReaction;
            this.echoGuard.expect(
                `discord:reaction:remove:${targetMessage.id}:${key}`
            );
            await reaction.users.remove(botId);
        }

        return plan.toAdd.length + plan.toRemove.length;
    }

    private async planReactions(
        sourceEmojis: ReactionEmojiInput[],
        sourcePlatform: SyncPlatform,
        sourceGuildId: string,
        targetPlatform: SyncPlatform,
        targetGuildId: string,
        currentKeys: Iterable<string>
    ): Promise<{
        desired: Map<string, MappedEmoji>;
        toAdd: string[];
        toRemove: string[];
    }> {
        const desired = new Map<string, MappedEmoji>();

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

            desired.set(emojiKeyFromMapped(mapped), mapped);
        }

        const { toAdd, toRemove } = diffReactionKeys(
            desired.keys(),
            currentKeys
        );

        return { desired, toAdd, toRemove };
    }
}
