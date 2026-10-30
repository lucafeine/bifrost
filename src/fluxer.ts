import {
    Client,
    ClientOptions,
    EmbedBuilder,
    Events,
    Message,
    PartialMessage,
    TextChannel,
} from '@fluxerjs/core';
import CommandRegistry from './commands/CommandRegistry';
import {
    isCommandString,
    parseCommandString,
} from './commands/parseCommandString';
import { EmbedColors } from './utils/embeds';
import logger from './utils/logging/logger';
import FluxerCommandHandler from './commands/fluxer/FluxerCommandHandler';
import {
    COMMAND_PREFIX,
    DELETE_INVOCATION,
    AUTODISCOVERY_FLUXER_DOMAIN,
    FLUXER_TOKEN,
    FLUXER_API_URL,
    FLUXER_CHANNEL_CACHE_LIMIT,
    FLUXER_GUILD_CACHE_LIMIT,
    FLUXER_MEDIA_URL,
    FLUXER_STATIC_CDN_URL,
    FLUXER_INVITE_URL,
} from './utils/env';
import { LinkService } from './services/LinkService';
import LinkFluxerCommandHandler from './commands/fluxer/handlers/LinkFluxerCommandHandler';
import UnlinkFluxerCommandHandler from './commands/fluxer/handlers/UnlinkFluxerCommandHandler';
import ListFluxerCommandHandler from './commands/fluxer/handlers/ListFluxerCommandHandler';
import { WebhookService } from './services/WebhookService';
import FluxerToDiscordMessageRelay from './services/messageRelay/FluxerToDiscordMessageRelay';
import HelpFluxerCommandHandler from './commands/fluxer/handlers/HelpFluxerCommandHandler';
import AutolinkFluxerCommandHandler from './commands/fluxer/handlers/AutolinkFluxerCommandHandler';
import HealthCheckService from './services/HealthCheckService';
import FluxerEntityResolver from './services/entityResolver/FluxerEntityResolver';
import DiscordEntityResolver from './services/entityResolver/DiscordEntityResolver';
import FluxerMessageTransformer from './services/messageTransformer/FluxerMessageTransformer';
import MetricsService from './services/MetricsService';
import MessageQueueService from './services/MessageQueueService';
import StatsFluxerCommandHandler from './commands/fluxer/handlers/StatsFluxerCommandHandler';
import DiscordStatsService from './services/statsService/DiscordStatsService';
import FluxerStatsService from './services/statsService/FluxerStatsService';
import { DbStatsService } from './services/DbStatsService';
import EmojiMapper from './services/emojiMapping/EmojiMapper';
import BridgeLogService from './services/BridgeLogService';
import { GuildLinkSettingsRepository } from './db/repositories/GuildLinkSettingsRepository';
import { ChannelType as DiscordChannelType } from 'discord.js';
import { syncEchoGuard } from './services/SyncEchoGuard';
import { createPendingStructureDelete } from './commands/interactions/StructureDeleteStore';
import {
    changedStructureFields,
    fieldsForKind,
    normalizeChannelName,
    structureCreateKey,
    structureDeleteKey,
    structureSnapshot,
    structureUpdateKey,
    toDiscordChannelName,
    type StructureField,
    type StructureKind,
    type StructureSnapshot,
} from './utils/channelStructure';
import { ChannelType } from '@fluxerjs/core';
import ReactionSyncService, {
    fluxerReactionEmoji,
} from './services/reactionSync/ReactionSyncService';

const startFluxerClient = async ({
    linkService,
    webhookService,
    healthCheckService,
    discordEntityResolver,
    fluxerEntityResolver,
    metricsService,
    queueService,
    discordStatsService,
    fluxerStatsService,
    dbStatsService,
    emojiMapper,
    bridgeLogService,
    reactionSyncService,
    guildLinkSettingsRepo,
}: {
    linkService: LinkService;
    webhookService: WebhookService;
    healthCheckService: HealthCheckService;
    discordEntityResolver: DiscordEntityResolver;
    fluxerEntityResolver: FluxerEntityResolver;
    metricsService?: MetricsService;
    queueService?: MessageQueueService;
    discordStatsService: DiscordStatsService;
    fluxerStatsService: FluxerStatsService;
    dbStatsService: DbStatsService;
    emojiMapper: EmojiMapper;
    bridgeLogService: BridgeLogService;
    reactionSyncService: ReactionSyncService;
    guildLinkSettingsRepo: GuildLinkSettingsRepository;
}): Promise<Client> => {
    const clientOptions: ClientOptions = {
        intents: 0,
        waitForGuilds: true,
        cache: {
            guilds: FLUXER_GUILD_CACHE_LIMIT,
            channels: FLUXER_CHANNEL_CACHE_LIMIT,
        },
        presence: {
            status: 'online',
            customStatus: {
                text: 'Bridging to Discord',
            },
        },
        instance: {
            api: FLUXER_API_URL || undefined,
            media: FLUXER_MEDIA_URL || undefined,
            static_cdn: FLUXER_STATIC_CDN_URL || undefined,
            invite: FLUXER_INVITE_URL || undefined,
        },
    };

    const client = AUTODISCOVERY_FLUXER_DOMAIN
        ? await Client.fromDiscovery(AUTODISCOVERY_FLUXER_DOMAIN, clientOptions)
        : new Client(clientOptions);

    console.log();

    webhookService.setFluxerClient(client);
    healthCheckService.setFluxerClient(client);
    fluxerEntityResolver.setFluxerClient(client);
    fluxerStatsService.setClient(client);
    bridgeLogService.setFluxerClient(client);
    reactionSyncService.setFluxerClient(client);

    const messageTransformer = new FluxerMessageTransformer(emojiMapper);
    const messageRelay = new FluxerToDiscordMessageRelay({
        linkService,
        webhookService,
        messageTransformer,
        metricsService,
        queueService,
        discordEntityResolver,
    });

    const commandRegistry = new CommandRegistry<FluxerCommandHandler>();
    commandRegistry.registerCommand(
        'help',
        new HelpFluxerCommandHandler(client)
    );
    commandRegistry.registerCommand(
        'stats',
        new StatsFluxerCommandHandler(
            client,
            discordStatsService,
            fluxerStatsService,
            dbStatsService
        )
    );
    commandRegistry.registerCommand(
        'link',
        new LinkFluxerCommandHandler(
            client,
            linkService,
            webhookService,
            discordEntityResolver
        )
    );
    commandRegistry.registerCommand(
        'unlink',
        new UnlinkFluxerCommandHandler(client, linkService, webhookService)
    );
    commandRegistry.registerCommand(
        'list',
        new ListFluxerCommandHandler(client, linkService, discordEntityResolver)
    );
    commandRegistry.registerCommand(
        'autolink',
        new AutolinkFluxerCommandHandler(
            client,
            linkService,
            webhookService,
            discordEntityResolver
        )
    );

    client.once(Events.Ready, () => {
        logger.info('Fluxer bot is ready!');
        healthCheckService.pushFluxerHealthStatus();
    });

    client.on(Events.Error, (error) => {
        logger.error('Fluxer client error:', error);
    });

    client.on(Events.MessageDelete, async (message: PartialMessage) => {
        const messageLink = await linkService.getMessageLinkByFluxerMessageId(
            message.id
        );
        if (!messageLink) return;

        try {
            linkService.deleteMessageLink(messageLink.id);
        } catch (error) {
            logger.error('Error deleting message link from database:', error);
        }

        const channelLink = await linkService.getChannelLinkById(
            messageLink.channelLinkId
        );
        if (!channelLink) return;

        const guildLink = await linkService.getGuildLinkById(
            channelLink.guildLinkId
        );
        if (!guildLink) return;

        const msg = await discordEntityResolver.fetchMessage(
            guildLink.discordGuildId,
            channelLink.discordChannelId,
            messageLink.discordMessageId
        );
        if (!msg) {
            logger.error(
                'Could not find linked Discord message to delete for Fluxer message ID:',
                message.id
            );
            return;
        }

        try {
            await msg.delete();
        } catch (error) {
            logger.error('Error deleting message from Discord:', error);
        }
    });

    client.on(Events.MessageUpdate, async (_oldMessage, updatedMessage) => {
        if (!updatedMessage.partial && updatedMessage.webhookId) return;

        const linkedMessage = await linkService.getMessageLinkByFluxerMessageId(
            updatedMessage.id
        );
        if (!linkedMessage) return;

        let newMessage: Message;
        try {
            newMessage = updatedMessage.partial
                ? await updatedMessage.fetch()
                : updatedMessage;
        } catch (error) {
            logger.error('Error fetching updated Fluxer message:', error);
            return;
        }
        if (newMessage.webhookId) return;

        const linkedChannel = await linkService.getChannelLinkById(
            linkedMessage.channelLinkId
        );
        if (!linkedChannel) return;

        const guildLink = await linkService.getGuildLinkById(
            linkedChannel.guildLinkId
        );
        if (!guildLink) return;

        const webhook = await webhookService.getDiscordWebhook(
            linkedChannel.discordWebhookId,
            linkedChannel.discordWebhookToken
        );
        if (!webhook) {
            logger.warn(
                `No webhook found for linked channel ${linkedChannel.linkId}, cannot relay message update`
            );
            return;
        }

        const discordEmojis = await discordEntityResolver.fetchEmojis(
            guildLink.discordGuildId
        );

        const newMsg = await messageTransformer.transformMessage(
            newMessage,
            discordEmojis
        );
        try {
            await webhookService.editMessageViaDiscordWebhook(
                webhook,
                linkedMessage.discordMessageId,
                newMsg
            );
        } catch (error) {
            logger.error('Error editing message via Discord webhook:', error);
        }
    });

    client.on(Events.MessageCreate, async (message) => {
        if (message.author.id === client.user?.id) return;

        if (message.guildId && message.webhookId) {
            const webhookLink =
                await linkService.getChannelLinkByFluxerChannelId(
                    message.channelId
                );
            if (
                webhookLink &&
                webhookLink.fluxerWebhookId === message.webhookId
            )
                return;
        }

        if (isCommandString(message.content, COMMAND_PREFIX)) {
            const { command, args } = parseCommandString(
                message.content,
                COMMAND_PREFIX
            );
            const handler = commandRegistry.getCommandHandler(command);
            if (!handler) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                `Unknown command: \`${command}\`\nUse \`${COMMAND_PREFIX}help\` to see available commands.`
                            )
                            .setColor(EmbedColors.Error)
                            .setFooter({
                                text: `${message.author.username} used ${message.content} • ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`,
                                iconURL:
                                    (
                                        message.author as {
                                            avatarURL?: () =>
                                                | string
                                                | undefined;
                                        }
                                    ).avatarURL?.() ?? undefined,
                            })
                            .setTimestamp(),
                    ],
                });
                return;
            }

            try {
                await handler.handleCommand(message, command, ...args);
            } catch (error) {
                logger.error(
                    `Error executing fluxer command "${command}":`,
                    error
                );
            }

            if (DELETE_INVOCATION && message.guildId) {
                message
                    .delete()
                    .catch((err: unknown) =>
                        logger.error(
                            'Failed to delete invocation message:',
                            err
                        )
                    );
            }
        }

        if (
            message.guildId &&
            message.channel instanceof TextChannel &&
            !isCommandString(message.content, COMMAND_PREFIX)
        ) {
            await messageRelay.relayMessage(message);
        }
    });

    client.on(Events.MessageReactionAdd, (payload) => {
        reactionSyncService.handleEvent({
            platform: 'fluxer',
            kind: 'add',
            channelId: payload.channelId,
            messageId: payload.messageId,
            actorId: payload.userId,
            emoji: fluxerReactionEmoji(payload.emoji),
        });
    });

    client.on(Events.MessageReactionRemove, (payload) => {
        reactionSyncService.handleEvent({
            platform: 'fluxer',
            kind: 'remove',
            channelId: payload.channelId,
            messageId: payload.messageId,
            actorId: payload.userId,
            emoji: fluxerReactionEmoji(payload.emoji),
        });
    });

    client.on(Events.MessageReactionRemoveEmoji, (payload) => {
        reactionSyncService.handleEvent({
            platform: 'fluxer',
            kind: 'removeEmoji',
            channelId: payload.channelId,
            messageId: payload.messageId,
            actorId: null,
            emoji: fluxerReactionEmoji(payload.emoji),
        });
    });

    client.on(Events.MessageReactionRemoveAll, (payload) => {
        reactionSyncService.handleEvent({
            platform: 'fluxer',
            kind: 'removeAll',
            channelId: payload.channelId,
            messageId: payload.messageId,
            actorId: null,
            emoji: null,
        });
    });

    const typingThrottle = new Map<string, number>();

    client.on(Events.TypingStart, async (payload) => {
        try {
            if (payload.userId === client.user?.id) return;

            const user = await client.users
                .fetch(payload.userId)
                .catch(() => null);
            if (user?.bot) return;

            const channelLink = await linkService
                .getChannelLinkByFluxerChannelId(payload.channelId)
                .catch(() => null);
            if (!channelLink) return;

            const guildLink = await linkService
                .getGuildLinkById(channelLink.guildLinkId)
                .catch(() => null);
            if (!guildLink) return;

            const settings = await guildLinkSettingsRepo
                .getOrCreate(guildLink.id)
                .catch(() => null);
            if (!settings?.syncTyping) return;

            const key = `${channelLink.id}:${payload.userId}`;
            const nowTs = Date.now();
            const last = typingThrottle.get(key) ?? 0;
            if (nowTs - last < 8_000) return;
            typingThrottle.set(key, nowTs);

            const discordChannel = await discordEntityResolver
                .fetchChannel(
                    guildLink.discordGuildId,
                    channelLink.discordChannelId
                )
                .catch(() => null);
            if (
                discordChannel &&
                typeof (discordChannel as { sendTyping?: () => Promise<void> })
                    .sendTyping === 'function'
            ) {
                await (discordChannel as { sendTyping: () => Promise<void> })
                    .sendTyping()
                    .catch(() => {});
            }
        } catch (err) {
            logger.debug('Fluxer typing forward error:', err);
        }
    });

    // Bulk delete mirror
    client.on(Events.MessageDeleteBulk, async (payload) => {
        try {
            const ids = payload.ids ?? [];
            const links = (
                await Promise.all(
                    ids.map((id) =>
                        linkService
                            .getMessageLinkByFluxerMessageId(id)
                            .catch(() => null)
                    )
                )
            ).filter(Boolean) as Awaited<
                ReturnType<typeof linkService.getMessageLinkByFluxerMessageId>
            >[];
            if (!links.length) return;

            const concurrency = 5;
            for (let i = 0; i < links.length; i += concurrency) {
                const chunk = links.slice(i, i + concurrency);
                await Promise.all(
                    chunk.map(async (link) => {
                        if (!link) return;
                        const channelLink = await linkService
                            .getChannelLinkById(link.channelLinkId)
                            .catch(() => null);
                        const guildLink = channelLink
                            ? await linkService
                                  .getGuildLinkById(channelLink.guildLinkId)
                                  .catch(() => null)
                            : null;
                        if (!channelLink || !guildLink) return;
                        try {
                            const msg =
                                await discordEntityResolver.fetchMessage(
                                    guildLink.discordGuildId,
                                    channelLink.discordChannelId,
                                    link.discordMessageId
                                );
                            await msg.delete();
                        } catch {
                            // ignore
                        }
                        try {
                            await linkService.deleteMessageLink(link.id);
                        } catch {
                            // ignore
                        }
                    })
                );
            }
        } catch (err) {
            logger.debug('Fluxer bulk delete mirror error:', err);
        }
    });

    // Pins reconciliation trigger
    client.on(Events.ChannelPinsUpdate, async (payload) => {
        try {
            const channelLink = await linkService
                .getChannelLinkByFluxerChannelId(payload.channelId)
                .catch(() => null);
            if (!channelLink) return;
            const guildLink = await linkService
                .getGuildLinkById(channelLink.guildLinkId)
                .catch(() => null);
            if (!guildLink) return;
            const settings = await guildLinkSettingsRepo
                .getOrCreate(guildLink.id)
                .catch(() => null);
            if (!settings?.syncPins) return;

            const links = await linkService
                .getMessageLinksForChannelLink(channelLink.id)
                .catch(() => []);

            const fluxerChannel = await fluxerEntityResolver
                .fetchChannel(
                    guildLink.fluxerGuildId,
                    channelLink.fluxerChannelId
                )
                .catch(() => null);
            const fluxerPinnedIds = new Set<string>();
            if (
                fluxerChannel &&
                typeof (
                    fluxerChannel as unknown as {
                        fetchPinnedMessages?: () => Promise<unknown[]>;
                    }
                ).fetchPinnedMessages === 'function'
            ) {
                const pinned = (await (
                    fluxerChannel as unknown as {
                        fetchPinnedMessages: () => Promise<{ id: string }[]>;
                    }
                )
                    .fetchPinnedMessages()
                    .catch(() => [])) as { id: string }[];
                for (const m of pinned) fluxerPinnedIds.add(m.id);
            }

            const discordChannel = await discordEntityResolver
                .fetchChannel(
                    guildLink.discordGuildId,
                    channelLink.discordChannelId
                )
                .catch(() => null);
            const discordPinnedIds = new Set<string>();
            if (
                discordChannel &&
                typeof (
                    discordChannel as {
                        messages?: { fetchPinned?: () => Promise<unknown> };
                    }
                ).messages?.fetchPinned === 'function'
            ) {
                const pinned = await (
                    discordChannel as {
                        messages: {
                            fetchPinned: () => Promise<
                                Map<string, unknown> | unknown[]
                            >;
                        };
                    }
                ).messages
                    .fetchPinned()
                    .catch(() => null);
                if (pinned) {
                    if (pinned instanceof Map) {
                        for (const id of pinned.keys())
                            discordPinnedIds.add(id);
                    } else if (Array.isArray(pinned)) {
                        for (const m of pinned as { id: string }[])
                            discordPinnedIds.add(m.id);
                    }
                }
            }

            for (const link of links) {
                const sourcePinned = fluxerPinnedIds.has(link.fluxerMessageId);
                const targetPinned = discordPinnedIds.has(
                    link.discordMessageId
                );
                if (sourcePinned === targetPinned) continue;
                try {
                    const msg = await discordEntityResolver.fetchMessage(
                        guildLink.discordGuildId,
                        channelLink.discordChannelId,
                        link.discordMessageId
                    );
                    if (sourcePinned) await msg.pin();
                    else await msg.unpin();
                } catch {
                    // ignore
                }
            }
        } catch (err) {
            logger.debug('Fluxer pins mirror error:', err);
        }
    });

    // P4: channel structure sync (create/update/delete with admin-validated deletes)

    /**
     * Resolve the twin category on Discord for a Fluxer parent category,
     * mirroring the category first when it has no twin yet. Returns the twin
     * ID, `null` for "no parent", or `undefined` when it could not be resolved
     * (the caller then skips the parent change instead of detaching the twin).
     */
    const resolveDiscordParentId = async (
        guildLink: { id: string; discordGuildId: string },
        parent: { id: string; name: string } | null
    ): Promise<string | null | undefined> => {
        if (!parent) return null;
        const parentLink = await linkService
            .getStructureLinkByFluxerChannelId(parent.id)
            .catch(() => null);
        if (parentLink) return parentLink.discordChannelId;

        const discordGuild = await discordEntityResolver
            .fetchGuild(guildLink.discordGuildId)
            .catch(() => null);
        if (!discordGuild) return undefined;

        const parentNorm = normalizeChannelName(parent.name);
        const discordChannels = await discordGuild.channels
            .fetch()
            .catch(() => null);
        const existingParent = (
            discordChannels ? [...discordChannels.values()] : []
        ).find(
            (c) =>
                c !== null &&
                c.type === DiscordChannelType.GuildCategory &&
                normalizeChannelName(c.name) === parentNorm
        );
        if (existingParent) {
            await linkService
                .createStructureLink({
                    guildLinkId: guildLink.id,
                    discordChannelId: existingParent.id,
                    fluxerChannelId: parent.id,
                    kind: 'category',
                    origin: 'manual',
                })
                .catch(() => null);
            return existingParent.id;
        }

        const twinName = toDiscordChannelName(parent.name);
        syncEchoGuard.expect(
            structureCreateKey('discord', twinName, 'category')
        );
        const twinParent = await discordGuild.channels.create({
            name: twinName,
            type: DiscordChannelType.GuildCategory,
        });
        await linkService.createStructureLink({
            guildLinkId: guildLink.id,
            discordChannelId: twinParent.id,
            fluxerChannelId: parent.id,
            kind: 'category',
            origin: 'auto',
        });
        return twinParent.id;
    };

    client.on(Events.ChannelCreate, async (channel) => {
        try {
            const fluxerGuildId = (channel as { guildId?: string | null })
                .guildId;
            if (!fluxerGuildId) return;
            if (
                channel.type !== ChannelType.GuildText &&
                channel.type !== ChannelType.GuildCategory
            )
                return;
            const guildLink = await linkService
                .getGuildLinkForFluxerGuild(fluxerGuildId)
                .catch(() => null);
            if (!guildLink) return;
            const settings = await guildLinkSettingsRepo
                .getOrCreate(guildLink.id)
                .catch(() => null);
            if (!settings?.syncChannelStructure) return;

            const kind: StructureKind =
                channel.type === ChannelType.GuildCategory
                    ? 'category'
                    : 'text';
            const channelName =
                (channel as { name?: string | null }).name ?? '';
            if (
                syncEchoGuard.isEcho(
                    structureCreateKey('fluxer', channelName, kind)
                )
            )
                return;

            const existing = await linkService
                .getStructureLinkByFluxerChannelId(channel.id)
                .catch(() => null);
            if (existing) return;

            const channelParentId = (channel as { parentId?: string | null })
                .parentId;
            const parent = channelParentId
                ? await fluxerEntityResolver
                      .fetchChannel(fluxerGuildId, channelParentId)
                      .catch(() => null)
                : null;
            const parentDiscordId = await resolveDiscordParentId(
                guildLink,
                parent
                    ? {
                          id: parent.id,
                          name: (parent as { name?: string | null }).name ?? '',
                      }
                    : null
            );
            if (parentDiscordId === undefined) {
                logger.warn(
                    `Fluxer ChannelCreate: could not resolve twin category for #${channelName}`
                );
            }

            const twinName = toDiscordChannelName(channelName);
            syncEchoGuard.expect(structureCreateKey('discord', twinName, kind));
            const discordGuild = await discordEntityResolver
                .fetchGuild(guildLink.discordGuildId)
                .catch(() => null);
            if (!discordGuild) return;
            const twin = await discordGuild.channels.create({
                name: twinName,
                type:
                    kind === 'category'
                        ? DiscordChannelType.GuildCategory
                        : DiscordChannelType.GuildText,
                topic:
                    (channel as { topic?: string | null }).topic ?? undefined,
                nsfw: (channel as { nsfw?: boolean }).nsfw ?? undefined,
                rateLimitPerUser:
                    (channel as { rateLimitPerUser?: number | null })
                        .rateLimitPerUser ?? undefined,
                parent: parentDiscordId ?? undefined,
            });

            await linkService.createStructureLink({
                guildLinkId: guildLink.id,
                discordChannelId: twin.id,
                fluxerChannelId: channel.id,
                kind,
                origin: 'auto',
            });

            if (kind === 'text' && settings.autoLinkCreatedChannels) {
                try {
                    const discordWebhook =
                        await webhookService.createDiscordWebhook(
                            twin.id,
                            `Fluxer Bridge Webhook for channel ${twin.id}`
                        );
                    const fluxerWebhook =
                        await webhookService.createFluxerWebhook(
                            channel.id,
                            `Discord Bridge Webhook for channel ${channel.id}`
                        );
                    await linkService.createChannelLink({
                        guildLinkId: guildLink.id,
                        discordChannelId: twin.id,
                        fluxerChannelId: channel.id,
                        discordWebhookId: discordWebhook.id,
                        discordWebhookToken: discordWebhook.token,
                        fluxerWebhookId: fluxerWebhook.id,
                        fluxerWebhookToken: fluxerWebhook.token,
                    });
                } catch (err) {
                    logger.warn('Auto-link failed for mirrored channel:', err);
                }
            }

            await bridgeLogService.post(
                guildLink.id,
                'info',
                `➕ #${channelName} mirrored to Discord`
            );
        } catch (err) {
            logger.debug('Fluxer channel create mirror error:', err);
        }
    });

    client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
        try {
            const fluxerGuildId = (newChannel as { guildId?: string | null })
                .guildId;
            if (!fluxerGuildId) return;
            if (
                newChannel.type !== ChannelType.GuildText &&
                newChannel.type !== ChannelType.GuildCategory
            )
                return;
            const link = await linkService
                .getStructureLinkByFluxerChannelId(newChannel.id)
                .catch(() => null);
            if (!link) return;
            const guildLink = await linkService
                .getGuildLinkById(link.guildLinkId)
                .catch(() => null);
            if (!guildLink) return;
            const settings = await guildLinkSettingsRepo
                .getOrCreate(guildLink.id)
                .catch(() => null);
            if (!settings?.syncChannelStructure) return;

            const kind: StructureKind =
                newChannel.type === ChannelType.GuildCategory
                    ? 'category'
                    : 'text';
            const oldSnap = structureSnapshot(oldChannel);
            const newSnap = structureSnapshot(newChannel);
            const fields = fieldsForKind(
                changedStructureFields(oldSnap, newSnap),
                kind
            );
            if (fields.length === 0) return;

            // Our own mirrored edits echo back on this platform first.
            for (const field of fields) {
                if (
                    syncEchoGuard.isEcho(
                        structureUpdateKey(
                            'fluxer',
                            newChannel.id,
                            field,
                            newSnap[field]
                        )
                    )
                )
                    return;
            }

            // Twin values in Discord coordinates (what its echo event reports).
            const twinValues: Partial<
                Record<StructureField, StructureSnapshot[StructureField]>
            > = {};
            for (const field of fields) {
                switch (field) {
                    case 'parentId': {
                        const parent = newSnap.parentId
                            ? await fluxerEntityResolver
                                  .fetchChannel(fluxerGuildId, newSnap.parentId)
                                  .catch(() => null)
                            : null;
                        const twinParentId = await resolveDiscordParentId(
                            guildLink,
                            parent
                                ? {
                                      id: parent.id,
                                      name:
                                          (
                                              parent as {
                                                  name?: string | null;
                                              }
                                          ).name ?? '',
                                  }
                                : null
                        );
                        if (twinParentId === undefined) {
                            logger.warn(
                                `Fluxer channel update: could not resolve twin category for #${newSnap.name}`
                            );
                            continue;
                        }
                        twinValues.parentId = twinParentId;
                        break;
                    }
                    case 'name':
                        twinValues.name = toDiscordChannelName(newSnap.name);
                        break;
                    default:
                        twinValues[field] = newSnap[field];
                        break;
                }
            }
            if (Object.keys(twinValues).length === 0) return;

            for (const [field, value] of Object.entries(twinValues)) {
                syncEchoGuard.expect(
                    structureUpdateKey(
                        'discord',
                        link.discordChannelId,
                        field as StructureField,
                        value as StructureSnapshot[StructureField]
                    )
                );
            }

            const discordChannel = await discordEntityResolver
                .fetchChannel(guildLink.discordGuildId, link.discordChannelId)
                .catch(() => null);
            if (!discordChannel) return;
            // Canonical field names match discord.js, except `parent`.
            const edits: Record<string, unknown> = {};
            if ('name' in twinValues) edits.name = twinValues.name;
            if ('topic' in twinValues) edits.topic = twinValues.topic;
            if ('nsfw' in twinValues) edits.nsfw = twinValues.nsfw;
            if ('rateLimitPerUser' in twinValues)
                edits.rateLimitPerUser = twinValues.rateLimitPerUser;
            if ('parentId' in twinValues) edits.parent = twinValues.parentId;
            await (
                discordChannel as {
                    edit: (opts: unknown) => Promise<unknown>;
                }
            ).edit(edits);
        } catch (err) {
            logger.debug('Fluxer channel update mirror error:', err);
        }
    });

    client.on(Events.ChannelDelete, async (channel) => {
        try {
            const fluxerGuildId = (channel as { guildId?: string | null })
                .guildId;
            if (!fluxerGuildId) return;
            if (
                channel.type !== ChannelType.GuildText &&
                channel.type !== ChannelType.GuildCategory
            )
                return;
            if (syncEchoGuard.isEcho(structureDeleteKey('fluxer', channel.id)))
                return;
            const link = await linkService
                .getStructureLinkByFluxerChannelId(channel.id)
                .catch(() => null);
            if (!link) return;
            const guildLink = await linkService
                .getGuildLinkById(link.guildLinkId)
                .catch(() => null);
            if (!guildLink) return;
            const settings = await guildLinkSettingsRepo
                .getOrCreate(guildLink.id)
                .catch(() => null);
            if (!settings?.syncChannelStructure) return;

            const channelName =
                (channel as { name?: string | null }).name ?? channel.id;

            if (!settings.syncChannelDeletes) {
                await bridgeLogService.post(
                    guildLink.id,
                    'warn',
                    `Channel #${channelName} deleted on Fluxer; twin still exists on Discord (enable "Channel delete sync" to manage deletions)`
                );
                return;
            }

            const adminChannelId = settings.discordLogChannelId;
            if (!adminChannelId) {
                await bridgeLogService.post(
                    guildLink.id,
                    'warn',
                    `Channel #${channelName} deleted on Fluxer; twin still exists on Discord (no admin channel configured)`
                );
                return;
            }

            const token = createPendingStructureDelete({
                platform: 'fluxer',
                guildLinkId: guildLink.id,
                sourceChannelId: channel.id,
                twinChannelId: link.discordChannelId,
                structureLinkId: link.id,
                channelName,
            });

            const adminChannel = await discordEntityResolver
                .fetchChannel(guildLink.discordGuildId, adminChannelId)
                .catch(() => null);
            if (
                adminChannel &&
                (
                    adminChannel as { isTextBased?: () => boolean }
                ).isTextBased?.()
            ) {
                const { ActionRowBuilder, ButtonBuilder, ButtonStyle } =
                    await import('discord.js');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const row = new ActionRowBuilder<any>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`bifrost:structdelete:confirm:${token}`)
                        .setLabel('Delete twin')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId(`bifrost:structdelete:cancel:${token}`)
                        .setLabel('Keep')
                        .setStyle(ButtonStyle.Secondary)
                );
                await (
                    adminChannel as {
                        send: (opts: unknown) => Promise<unknown>;
                    }
                ).send({
                    content: `Channel **#${channelName}** was deleted on Fluxer. Delete its twin on Discord?`,
                    components: [row],
                });
            }
        } catch (err) {
            logger.debug('Fluxer channel delete mirror error:', err);
        }
    });

    await client.login(FLUXER_TOKEN);

    return client;
};

export default startFluxerClient;
