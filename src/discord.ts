import {
    Client,
    EmbedBuilder,
    Events,
    GatewayIntentBits,
    Partials,
    TextChannel,
} from 'discord.js';
import { COMMAND_PREFIX, DELETE_INVOCATION, DISCORD_TOKEN } from './utils/env';
import { EmbedColors } from './utils/embeds';
import logger from './utils/logging/logger';
import { isFluxerApiBlocked } from './utils/fluxerApiGuard';
import CommandRegistry from './commands/CommandRegistry';
import DiscordCommandHandler from './commands/discord/DiscordCommandHandler';
import {
    isCommandString,
    parseCommandString,
} from './commands/parseCommandString';
import { LinkService } from './services/LinkService';
import LinkDiscordCommandHandler from './commands/discord/handlers/LinkDiscordCommandHandler';
import UnlinkDiscordCommandHandler from './commands/discord/handlers/UnlinkDiscordCommandHandler';
import ListDiscordCommandHandler from './commands/discord/handlers/ListDiscordCommandHandler';
import { WebhookService } from './services/WebhookService';
import DiscordToFluxerMessageRelay from './services/messageRelay/DiscordToFluxerMessageRelay';
import HelpDiscordCommandHandler from './commands/discord/handlers/HelpDiscordCommandHandler';
import AutolinkDiscordCommandHandler from './commands/discord/handlers/AutolinkDiscordCommandHandler';
import HealthCheckService from './services/HealthCheckService';
import FluxerEntityResolver from './services/entityResolver/FluxerEntityResolver';
import DiscordEntityResolver from './services/entityResolver/DiscordEntityResolver';
import DiscordMessageTransformer from './services/messageTransformer/DiscordMessageTransformer';
import MetricsService from './services/MetricsService';
import MessageQueueService from './services/MessageQueueService';
import FluxerStatsService from './services/statsService/FluxerStatsService';
import DiscordStatsService from './services/statsService/DiscordStatsService';
import StatsDiscordCommandHandler from './commands/discord/handlers/StatsDiscordCommandHandler';
import { DbStatsService } from './services/DbStatsService';
import EmojiMapper from './services/emojiMapping/EmojiMapper';
import BridgeLogService from './services/BridgeLogService';
import ReactionSyncService, {
    discordReactionEmoji,
} from './services/reactionSync/ReactionSyncService';
import { GuildLinkSettingsRepository } from './db/repositories/GuildLinkSettingsRepository';
import { syncEchoGuard } from './services/SyncEchoGuard';
import { createPendingStructureDelete } from './commands/interactions/StructureDeleteStore';
import { ChannelType } from 'discord.js';
import { ChannelType as FluxerChannelType } from '@fluxerjs/core';
import InteractionRouter from './commands/interactions/InteractionRouter';
import {
    registerBridgeCommands,
    registerBridgeCommandsForGuild,
} from './commands/interactions/registerCommands';

const startDiscordClient = async ({
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
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.GuildMessageTyping,
        ],
        partials: [
            Partials.Message,
            Partials.Channel,
            Partials.Reaction,
            Partials.User,
        ],
        presence: {
            status: 'online',
            activities: [
                {
                    name: 'Bridging to Fluxer',
                    type: 0,
                },
            ],
        },
    });

    webhookService.setDiscordClient(client);
    healthCheckService.setDiscordClient(client);
    discordEntityResolver.setDiscordClient(client);
    discordStatsService.setClient(client);
    bridgeLogService.setDiscordClient(client);
    reactionSyncService.setDiscordClient(client);

    const messageTransformer = new DiscordMessageTransformer(emojiMapper);
    const messageRelay = new DiscordToFluxerMessageRelay({
        linkService,
        webhookService,
        messageTransformer,
        metricsService,
        queueService,
        fluxerEntityResolver,
    });

    const interactionRouter = new InteractionRouter(client, {
        linkService,
        webhookService,
        fluxerEntityResolver,
        discordEntityResolver,
        settingsRepo: guildLinkSettingsRepo,
        discordStatsService,
        fluxerStatsService,
        dbStatsService,
    });

    const commandRegistry = new CommandRegistry<DiscordCommandHandler>();
    commandRegistry.registerCommand(
        'help',
        new HelpDiscordCommandHandler(client)
    );
    commandRegistry.registerCommand(
        'stats',
        new StatsDiscordCommandHandler(
            client,
            discordStatsService,
            fluxerStatsService,
            dbStatsService
        )
    );
    commandRegistry.registerCommand(
        'link',
        new LinkDiscordCommandHandler(
            client,
            linkService,
            webhookService,
            fluxerEntityResolver
        )
    );
    commandRegistry.registerCommand(
        'unlink',
        new UnlinkDiscordCommandHandler(client, linkService, webhookService)
    );
    commandRegistry.registerCommand(
        'list',
        new ListDiscordCommandHandler(client, linkService, fluxerEntityResolver)
    );
    commandRegistry.registerCommand(
        'autolink',
        new AutolinkDiscordCommandHandler(
            client,
            linkService,
            webhookService,
            fluxerEntityResolver
        )
    );

    client.once(Events.ClientReady, () => {
        logger.info(`Discord bot logged in as ${client.user?.tag}`);

        registerBridgeCommands(client).catch((err) =>
            logger.error('Bridge command registration failed:', err)
        );

        if (queueService) {
            queueService
                .drain(webhookService, linkService)
                .catch((err) =>
                    logger.error('Startup queue drain error:', err)
                );
            queueService.startDrainInterval(webhookService, linkService);
        }

        healthCheckService.pushDiscordHealthStatus();
        setInterval(async () => {
            await healthCheckService.pushDiscordHealthStatus();
        }, 30_000);
    });

    client.on(Events.Error, (error) => {
        logger.error('Discord client error:', error);
    });

    client.on(Events.MessageDelete, async (message) => {
        if (!message.inGuild()) return;

        const messageLink = await linkService.getMessageLinkByDiscordMessageId(
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

        if (isFluxerApiBlocked()) return;

        const msg = await fluxerEntityResolver.fetchMessage(
            guildLink.fluxerGuildId,
            channelLink.fluxerChannelId,
            messageLink.fluxerMessageId
        );
        if (!msg) {
            logger.error(
                'Could not find linked Fluxer message to delete for Discord message ID:',
                message.id
            );
            return;
        }

        try {
            await msg.delete();
        } catch (error) {
            logger.error('Error deleting message from Fluxer:', error);
        }
    });

    client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
        if (newMessage.webhookId) return;

        const linkedMessage =
            await linkService.getMessageLinkByDiscordMessageId(newMessage.id);
        if (!linkedMessage) return;

        const linkedChannel = await linkService.getChannelLinkById(
            linkedMessage.channelLinkId
        );
        if (!linkedChannel) return;

        const guildLink = await linkService.getGuildLinkById(
            linkedChannel.guildLinkId
        );
        if (!guildLink) return;

        if (isFluxerApiBlocked()) return;

        const webhook = await webhookService.getFluxerWebhook(
            linkedChannel.fluxerWebhookId,
            linkedChannel.fluxerWebhookToken
        );
        if (!webhook) {
            logger.warn(
                `No webhook found for linked channel ${linkedChannel.linkId}, cannot relay message update`
            );
            return;
        }

        const fluxerEmojis = await fluxerEntityResolver.fetchEmojis(
            guildLink.fluxerGuildId
        );

        const newMsg = await messageTransformer.transformMessage(
            newMessage,
            fluxerEmojis
        );
        try {
            await webhookService.editMessageViaFluxerWebhook(
                webhook,
                linkedMessage.fluxerMessageId,
                newMsg
            );
        } catch (error) {
            logger.error('Error editing message via Fluxer webhook:', error);
        }
    });

    client.on(Events.MessageCreate, async (message) => {
        if (message.author.id === client.user?.id) return;

        if (message.inGuild() && message.webhookId) {
            const webhookLink =
                await linkService.getChannelLinkByDiscordChannelId(
                    message.channelId
                );
            if (
                webhookLink &&
                webhookLink.discordWebhookId === message.webhookId
            )
                return;
        }

        if (
            isCommandString(message.content, COMMAND_PREFIX) &&
            !message.author.bot
        ) {
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
                                text: `${message.author.username} used ${message.content}`,
                                iconURL: message.author.displayAvatarURL(),
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
                    `Error executing discord command "${command}":`,
                    error
                );
            }

            if (DELETE_INVOCATION && message.inGuild()) {
                message
                    .delete()
                    .catch((err) =>
                        logger.error(
                            'Failed to delete invocation message:',
                            err
                        )
                    );
            }
        }

        if (
            message.inGuild() &&
            message.channel instanceof TextChannel &&
            !isCommandString(message.content, COMMAND_PREFIX)
        ) {
            await messageRelay.relayMessage(message);
        }
    });

    client.on(Events.MessageReactionAdd, (reaction, user) => {
        reactionSyncService.handleEvent({
            platform: 'discord',
            kind: 'add',
            channelId: reaction.message.channelId,
            messageId: reaction.message.id,
            actorId: user.id,
            emoji: discordReactionEmoji(reaction),
        });
    });

    client.on(Events.MessageReactionRemove, (reaction, user) => {
        reactionSyncService.handleEvent({
            platform: 'discord',
            kind: 'remove',
            channelId: reaction.message.channelId,
            messageId: reaction.message.id,
            actorId: user.id,
            emoji: discordReactionEmoji(reaction),
        });
    });

    client.on(Events.MessageReactionRemoveEmoji, (reaction) => {
        reactionSyncService.handleEvent({
            platform: 'discord',
            kind: 'removeEmoji',
            channelId: reaction.message.channelId,
            messageId: reaction.message.id,
            actorId: null,
            emoji: discordReactionEmoji(reaction),
        });
    });

    client.on(Events.MessageReactionRemoveAll, (message) => {
        reactionSyncService.handleEvent({
            platform: 'discord',
            kind: 'removeAll',
            channelId: message.channelId,
            messageId: message.id,
            actorId: null,
            emoji: null,
        });
    });

    client.on(Events.GuildCreate, (guild) => {
        registerBridgeCommandsForGuild(guild.id).catch((err) =>
            logger.error('Bridge command registration failed:', err)
        );
    });

    client.on(Events.InteractionCreate, (interaction) => {
        interactionRouter
            .handle(interaction)
            .catch((err) => logger.error('Interaction router error:', err));
    });

    const typingThrottle = new Map<string, number>();

    client.on(Events.TypingStart, async (typing) => {
        try {
            if (!typing.inGuild()) return;
            const user = typing.user;
            if (!user || user.bot || user.id === client.user?.id) return;

            const channelLink = await linkService
                .getChannelLinkByDiscordChannelId(typing.channel.id)
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

            const key = `${channelLink.id}:${user.id}`;
            const nowTs = Date.now();
            const last = typingThrottle.get(key) ?? 0;
            if (nowTs - last < 8_000) return;
            typingThrottle.set(key, nowTs);

            const fluxerChannel = await fluxerEntityResolver
                .fetchChannel(
                    guildLink.fluxerGuildId,
                    channelLink.fluxerChannelId
                )
                .catch(() => null);
            if (
                fluxerChannel &&
                typeof (fluxerChannel as { sendTyping?: () => Promise<void> })
                    .sendTyping === 'function'
            ) {
                await (fluxerChannel as { sendTyping: () => Promise<void> })
                    .sendTyping()
                    .catch(() => {});
            }
        } catch (err) {
            logger.debug('Discord typing forward error:', err);
        }
    });

    // Bulk delete mirror
    client.on(Events.MessageBulkDelete, async (messages) => {
        try {
            const ids = [...messages.keys()];
            const links = (
                await Promise.all(
                    ids.map((id) =>
                        linkService
                            .getMessageLinkByDiscordMessageId(id)
                            .catch(() => null)
                    )
                )
            ).filter(Boolean) as Awaited<
                ReturnType<typeof linkService.getMessageLinkByDiscordMessageId>
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
                            const msg = await fluxerEntityResolver.fetchMessage(
                                guildLink.fluxerGuildId,
                                channelLink.fluxerChannelId,
                                link.fluxerMessageId
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
            logger.debug('Discord bulk delete mirror error:', err);
        }
    });

    // Pins reconciliation trigger
    client.on(Events.ChannelPinsUpdate, async (channel) => {
        try {
            if (
                !channel ||
                !('isTextBased' in channel) ||
                !channel.isTextBased()
            )
                return;
            const channelLink = await linkService
                .getChannelLinkByDiscordChannelId(channel.id)
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
            const discordPinnedIds = new Set<string>();
            if (
                channel &&
                (
                    channel as {
                        messages?: { fetchPinned?: () => Promise<unknown> };
                    }
                ).messages?.fetchPinned
            ) {
                const pinned = await (
                    channel as {
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

            for (const link of links) {
                const sourcePinned = discordPinnedIds.has(
                    link.discordMessageId
                );
                const targetPinned = fluxerPinnedIds.has(link.fluxerMessageId);
                if (sourcePinned === targetPinned) continue;
                try {
                    const msg = await fluxerEntityResolver.fetchMessage(
                        guildLink.fluxerGuildId,
                        channelLink.fluxerChannelId,
                        link.fluxerMessageId
                    );
                    if (sourcePinned) await msg.pin();
                    else await msg.unpin();
                } catch {
                    // ignore
                }
            }
        } catch (err) {
            logger.debug('Discord pins mirror error:', err);
        }
    });

    // P4: channel structure sync (create/update/delete with admin-validated deletion)
    const normalizeName = (name: string) =>
        name.toLowerCase().replace(/\\s+/g, '-');

    client.on(Events.ChannelCreate, async (channel) => {
        try {
            if (!('guild' in channel) || !channel.guild) return;
            if (
                channel.type !== ChannelType.GuildText &&
                channel.type !== ChannelType.GuildCategory
            )
                return;
            const guildLink = await linkService
                .getGuildLinkForDiscordGuild(channel.guild.id)
                .catch(() => null);
            if (!guildLink) return;
            const settings = await guildLinkSettingsRepo
                .getOrCreate(guildLink.id)
                .catch(() => null);
            if (!settings?.syncChannelStructure) return;

            const kind =
                channel.type === ChannelType.GuildCategory
                    ? 'category'
                    : 'text';
            const key = `discord:channel:create:${normalizeName(channel.name)}:${kind}`;
            if (syncEchoGuard.isEcho(key)) return;

            const existing = await linkService
                .getStructureLinkByDiscordChannelId(channel.id)
                .catch(() => null);
            if (existing) return;

            let parentFluxerId: string | null = null;
            if (channel.parentId) {
                const parentLink = await linkService
                    .getStructureLinkByDiscordChannelId(channel.parentId)
                    .catch(() => null);
                if (parentLink) {
                    parentFluxerId = parentLink.fluxerChannelId;
                } else {
                    const parent =
                        channel.parent ??
                        (await channel.guild.channels
                            .fetch(channel.parentId)
                            .catch(() => null));
                    if (parent) {
                        const fluxerGuild = await fluxerEntityResolver
                            .fetchGuild(guildLink.fluxerGuildId)
                            .catch(() => null);
                        if (fluxerGuild) {
                            const existingParent = (
                                await fluxerGuild
                                    .fetchChannels()
                                    .catch(() => [])
                            ).find(
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                (c: any) =>
                                    c.type === 4 &&
                                    normalizeName(c.name) ===
                                        normalizeName(parent.name)
                            );
                            if (existingParent) {
                                await linkService
                                    .createStructureLink({
                                        guildLinkId: guildLink.id,
                                        discordChannelId: parent.id,
                                        fluxerChannelId: existingParent.id,
                                        kind: 'category',
                                        origin: 'manual',
                                    })
                                    .catch(() => null);
                                parentFluxerId = existingParent.id;
                            } else {
                                const parentNorm = normalizeName(parent.name);
                                syncEchoGuard.expect(
                                    `fluxer:channel:create:${parentNorm}:category`
                                );
                                const twinParent =
                                    await fluxerGuild.createChannel({
                                        name: parent.name,
                                        type: FluxerChannelType.GuildCategory,
                                    });
                                await linkService.createStructureLink({
                                    guildLinkId: guildLink.id,
                                    discordChannelId: parent.id,
                                    fluxerChannelId: twinParent.id,
                                    kind: 'category',
                                    origin: 'auto',
                                });
                                parentFluxerId = twinParent.id;
                            }
                        }
                    }
                }
            }

            syncEchoGuard.expect(
                `fluxer:channel:create:${normalizeName(channel.name)}:${kind}`
            );
            const fluxerGuild = await fluxerEntityResolver
                .fetchGuild(guildLink.fluxerGuildId)
                .catch(() => null);
            if (!fluxerGuild) return;
            const twin = await fluxerGuild.createChannel({
                name: channel.name,
                type:
                    kind === 'category'
                        ? FluxerChannelType.GuildCategory
                        : FluxerChannelType.GuildText,
                topic: (channel as { topic?: string | null }).topic ?? null,
                nsfw: (channel as { nsfw?: boolean }).nsfw ?? false,
                rateLimitPerUser:
                    (channel as { rateLimitPerUser?: number | null })
                        .rateLimitPerUser ?? null,
                parentId: parentFluxerId,
            });

            await linkService.createStructureLink({
                guildLinkId: guildLink.id,
                discordChannelId: channel.id,
                fluxerChannelId: twin.id,
                kind,
                origin: 'auto',
            });

            if (kind === 'text' && settings.autoLinkCreatedChannels) {
                try {
                    const discordWebhook =
                        await webhookService.createDiscordWebhook(
                            channel.id,
                            `Fluxer Bridge Webhook for channel ${channel.id}`
                        );
                    const fluxerWebhook =
                        await webhookService.createFluxerWebhook(
                            twin.id,
                            `Discord Bridge Webhook for channel ${twin.id}`
                        );
                    await linkService.createChannelLink({
                        guildLinkId: guildLink.id,
                        discordChannelId: channel.id,
                        fluxerChannelId: twin.id,
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
                `➕ #${channel.name} mirrored to Fluxer`
            );
        } catch (err) {
            logger.debug('Discord channel create mirror error:', err);
        }
    });

    client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
        try {
            if (!('guild' in newChannel) || !newChannel.guild) return;
            if (
                newChannel.type !== ChannelType.GuildText &&
                newChannel.type !== ChannelType.GuildCategory
            )
                return;
            const link = await linkService
                .getStructureLinkByDiscordChannelId(newChannel.id)
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

            const changes: Record<string, unknown> = {};
            const oldName = (oldChannel as { name?: string }).name;
            const newName = (newChannel as { name?: string }).name;
            if (oldName !== newName) changes.name = newName;
            if (
                (oldChannel as { topic?: string | null }).topic !==
                (newChannel as { topic?: string | null }).topic
            )
                changes.topic =
                    (newChannel as { topic?: string | null }).topic ?? null;
            if (
                (oldChannel as { nsfw?: boolean }).nsfw !==
                (newChannel as { nsfw?: boolean }).nsfw
            )
                changes.nsfw = (newChannel as { nsfw?: boolean }).nsfw ?? false;
            if (
                (oldChannel as { rateLimitPerUser?: number | null })
                    .rateLimitPerUser !==
                (newChannel as { rateLimitPerUser?: number | null })
                    .rateLimitPerUser
            )
                changes.rateLimitPerUser =
                    (newChannel as { rateLimitPerUser?: number | null })
                        .rateLimitPerUser ?? null;
            const oldParentId = (oldChannel as { parentId?: string | null })
                .parentId;
            const newParentId = (newChannel as { parentId?: string | null })
                .parentId;
            if (oldParentId !== newParentId) {
                const parentLink = newParentId
                    ? await linkService
                          .getStructureLinkByDiscordChannelId(newParentId)
                          .catch(() => null)
                    : null;
                changes.parentId = parentLink
                    ? parentLink.fluxerChannelId
                    : null;
            }

            if (Object.keys(changes).length === 0) return;

            for (const [field, value] of Object.entries(changes)) {
                const key = `discord:channel:update:${newChannel.id}:${field}:${JSON.stringify(
                    value
                )}`;
                if (syncEchoGuard.isEcho(key)) return;
            }
            for (const [field, value] of Object.entries(changes)) {
                syncEchoGuard.expect(
                    `fluxer:channel:update:${link.fluxerChannelId}:${field}:${JSON.stringify(
                        value
                    )}`
                );
            }

            const fluxerChannel = await fluxerEntityResolver
                .fetchChannel(guildLink.fluxerGuildId, link.fluxerChannelId)
                .catch(() => null);
            if (!fluxerChannel) return;
            await (
                fluxerChannel as unknown as {
                    edit: (opts: unknown) => Promise<unknown>;
                }
            ).edit(changes);
        } catch (err) {
            logger.debug('Discord channel update mirror error:', err);
        }
    });

    client.on(Events.ChannelDelete, async (channel) => {
        try {
            if (!('guild' in channel) || !channel.guild) return;
            if (
                channel.type !== ChannelType.GuildText &&
                channel.type !== ChannelType.GuildCategory
            )
                return;
            const link = await linkService
                .getStructureLinkByDiscordChannelId(channel.id)
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

            const adminChannelId = settings.discordLogChannelId;
            const channelName =
                'name' in channel
                    ? String((channel as { name?: string }).name)
                    : (channel as { id: string }).id;

            if (!adminChannelId) {
                await bridgeLogService.post(
                    guildLink.id,
                    'warn',
                    `Channel #${channelName} deleted on Discord; twin still exists on Fluxer (no admin channel configured)`
                );
                return;
            }

            const token = createPendingStructureDelete({
                platform: 'discord',
                guildLinkId: guildLink.id,
                sourceChannelId: channel.id,
                twinChannelId: link.fluxerChannelId,
                structureLinkId: link.id,
                channelName,
            });

            const adminChannel = await client.channels
                .fetch(adminChannelId)
                .catch(() => null);
            if (adminChannel && adminChannel.isTextBased()) {
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
                    content: `Channel **#${channelName}** was deleted on Discord. Delete its twin on Fluxer?`,
                    components: [row],
                });
            }
        } catch (err) {
            logger.debug('Discord channel delete mirror error:', err);
        }
    });

    await client.login(DISCORD_TOKEN);

    return client;
};

export default startDiscordClient;
