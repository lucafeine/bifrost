import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ChannelType,
    ChatInputCommandInteraction,
    Client,
    EmbedBuilder,
    PermissionFlagsBits,
    StringSelectMenuInteraction,
    AutocompleteInteraction,
} from 'discord.js';
import { LinkService } from '../../services/LinkService';
import { WebhookService } from '../../services/WebhookService';
import FluxerEntityResolver from '../../services/entityResolver/FluxerEntityResolver';
import { GuildLinkSettingsRepository } from '../../db/repositories/GuildLinkSettingsRepository';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { GuildLinkSettingsUpdate } from '../../db/entities/GuildLinkSettings';
import LinkDiscordCommandHandler from '../discord/handlers/LinkDiscordCommandHandler';
import UnlinkDiscordCommandHandler from '../discord/handlers/UnlinkDiscordCommandHandler';
import ListDiscordCommandHandler from '../discord/handlers/ListDiscordCommandHandler';
import AutolinkDiscordCommandHandler from '../discord/handlers/AutolinkDiscordCommandHandler';
import StatsDiscordCommandHandler from '../discord/handlers/StatsDiscordCommandHandler';
import { EmbedColors } from '../../utils/embeds';
import logger from '../../utils/logging/logger';
import { matchChannels, ChannelInfo } from '../../utils/channelMatcher';
import crypto from 'crypto';

type PendingLinkGuild = {
    type: 'guild';
    userId: string;
    guildId: string;
    fluxerGuildId: string;
    guildName: string;
    expiresAt: number;
};

type PendingLinkChannel = {
    type: 'channel';
    userId: string;
    guildId: string;
    fluxerChannelId: string;
    channelName: string;
    guildLinkId: string;
    discordChannelId: string;
    expiresAt: number;
};

type PendingUnlink = {
    type: 'guild' | 'channel';
    userId: string;
    guildId: string;
    fluxerGuildId?: string;
    linkId?: string;
    fluxerChannelId?: string;
    discordChannelId?: string;
    discordWebhookId?: string;
    discordWebhookToken?: string;
    fluxerWebhookId?: string;
    fluxerWebhookToken?: string;
    expiresAt: number;
};

type Pending = PendingLinkGuild | PendingLinkChannel | PendingUnlink;

const TTL_MS = 5 * 60 * 1000;

function now() {
    return Date.now();
}

function newToken() {
    return crypto.randomBytes(12).toString('hex');
}

const TOGGLE_KEYS: { key: keyof GuildLinkSettingsUpdate; label: string }[] = [
    { key: 'syncReactions', label: 'Reactions sync' },
    { key: 'syncTyping', label: 'Typing indicators' },
    { key: 'syncPins', label: 'Pins' },
    { key: 'syncSystemMessages', label: 'System messages' },
    { key: 'syncChannelStructure', label: 'Channel structure sync' },
    { key: 'autoLinkCreatedChannels', label: 'Auto-link created channels' },
    { key: 'syncChannelDeletes', label: 'Channel delete sync' },
    { key: 'syncRoleStructure', label: 'Role structure sync' },
    { key: 'syncRoleDeletes', label: 'Role delete sync' },
    { key: 'mirrorEmojis', label: 'Emoji mirror' },
];

export class InteractionRouter {
    private pending = new Map<string, Pending>();
    private client: Client;

    private linkHandler: LinkDiscordCommandHandler;
    private unlinkHandler: UnlinkDiscordCommandHandler;
    private listHandler: ListDiscordCommandHandler;
    private autolinkHandler: AutolinkDiscordCommandHandler;
    private statsHandler: StatsDiscordCommandHandler;

    constructor(
        client: Client,
        private deps: {
            linkService: LinkService;
            webhookService: WebhookService;
            fluxerEntityResolver: FluxerEntityResolver;
            settingsRepo: GuildLinkSettingsRepository;
            discordStatsService: any;
            fluxerStatsService: any;
            dbStatsService: any;
        }
    ) {
        this.client = client;
        this.linkHandler = new LinkDiscordCommandHandler(
            client,
            deps.linkService,
            deps.webhookService,
            deps.fluxerEntityResolver
        );
        this.unlinkHandler = new UnlinkDiscordCommandHandler(
            client,
            deps.linkService,
            deps.webhookService
        );
        this.listHandler = new ListDiscordCommandHandler(
            client,
            deps.linkService,
            deps.fluxerEntityResolver
        );
        this.autolinkHandler = new AutolinkDiscordCommandHandler(
            client,
            deps.linkService,
            deps.webhookService,
            deps.fluxerEntityResolver
        );
        this.statsHandler = new StatsDiscordCommandHandler(
            client,
            deps.discordStatsService,
            deps.fluxerStatsService,
            deps.dbStatsService
        );
    }

    private cleanupPending() {
        const t = now();
        for (const [token, p] of this.pending) {
            if (p.expiresAt < t) this.pending.delete(token);
        }
    }

    private getPending(token: string): Pending | null {
        this.cleanupPending();
        const p = this.pending.get(token);
        if (!p) return null;
        if (p.expiresAt < now()) {
            this.pending.delete(token);
            return null;
        }
        return p;
    }

    async handle(interaction: any) {
        try {
            if (interaction.isAutocomplete?.()) {
                await this.handleAutocomplete(interaction);
                return;
            }
            if (interaction.isChatInputCommand?.()) {
                if (interaction.commandName === 'bridge') {
                    await this.handleSlash(interaction);
                }
                return;
            }
            if (interaction.isButton?.()) {
                await this.handleButton(interaction);
                return;
            }
            if (interaction.isStringSelectMenu?.()) {
                await this.handleSelect(interaction);
                return;
            }
        } catch (err) {
            logger.error('Interaction handling error:', err);
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.followUp({
                        content: 'An error occurred.',
                        ephemeral: true,
                    });
                } else {
                    await interaction.reply({
                        content: 'An error occurred.',
                        ephemeral: true,
                    });
                }
            } catch {
                // ignore
            }
        }
    }

    // ---------- Autocomplete ----------
    private async handleAutocomplete(interaction: AutocompleteInteraction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'fluxer_channel') {
            await interaction.respond([]);
            return;
        }
        const guildId = interaction.guildId;
        if (!guildId) {
            await interaction.respond([]);
            return;
        }
        const guildLink = await this.deps.linkService
            .getGuildLinkForDiscordGuild(guildId)
            .catch(() => null);
        if (!guildLink) {
            await interaction.respond([]);
            return;
        }
        const fluxerGuild = await this.deps.fluxerEntityResolver
            .fetchGuild(guildLink.fluxerGuildId)
            .catch(() => null);
        if (!fluxerGuild) {
            await interaction.respond([]);
            return;
        }
        const channels = await (fluxerGuild as any)
            .fetchChannels()
            .catch(() => []);
        const query = String(focused.value ?? '').toLowerCase();
        const choices = (channels as any[])
            .filter((ch) => ch.isTextBased?.() !== false)
            .filter(
                (ch) => !query || String(ch.name).toLowerCase().includes(query)
            )
            .slice(0, 25)
            .map((ch) => ({ name: `#${ch.name}`, value: String(ch.id) }));
        await interaction.respond(choices);
    }

    // ---------- Slash ----------
    private async handleSlash(interaction: ChatInputCommandInteraction) {
        const subGroup = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();

        if (subGroup === 'link') {
            if (sub === 'guild') return this.linkGuildSlash(interaction);
            if (sub === 'channel') return this.linkChannelSlash(interaction);
        }
        if (sub === 'autolink') return this.autolinkSlash(interaction);
        if (sub === 'unlink') return this.unlinkSlash(interaction);
        if (sub === 'list') return this.listSlash(interaction);
        if (sub === 'settings') return this.settingsSlash(interaction);
        if (sub === 'status') return this.statusSlash(interaction);
        if (sub === 'log') return this.logSlash(interaction);

        await interaction.reply({
            content: 'Unknown subcommand.',
            ephemeral: true,
        });
    }

    private async ensureGuild(
        interaction: ChatInputCommandInteraction
    ): Promise<string | null> {
        if (!interaction.inGuild() || !interaction.guildId) {
            await interaction.reply({
                content: 'This command must be used in a server.',
                ephemeral: true,
            });
            return null;
        }
        return interaction.guildId;
    }

    private hasManageGuild(
        interaction:
            | ChatInputCommandInteraction
            | ButtonInteraction
            | StringSelectMenuInteraction
    ): boolean {
        const member = interaction.member;
        const perms = (member as any)?.permissions;
        if (perms && typeof perms.has === 'function') {
            return perms.has(PermissionFlagsBits.ManageGuild);
        }
        return false;
    }

    private hasManageWebhooks(interaction: any): boolean {
        const member = interaction.member;
        const perms = (member as any)?.permissions;
        if (perms && typeof perms.has === 'function') {
            return perms.has(PermissionFlagsBits.ManageWebhooks);
        }
        return false;
    }

    private async linkGuildSlash(interaction: ChatInputCommandInteraction) {
        const guildId = await this.ensureGuild(interaction);
        if (!guildId) return;
        if (!this.hasManageGuild(interaction)) {
            await interaction.reply({
                content: 'You need Manage Guild permission.',
                ephemeral: true,
            });
            return;
        }
        const partner = interaction.options.getString('partner', true).trim();
        const fluxerGuild = await this.deps.fluxerEntityResolver
            .fetchGuild(partner)
            .catch(() => null);
        if (!fluxerGuild) {
            await interaction.reply({
                content: `Could not find Fluxer guild \`${partner}\`.`,
                ephemeral: true,
            });
            return;
        }
        const guildName = (fluxerGuild as { name?: string }).name ?? partner;

        await interaction.deferReply({ ephemeral: true });

        const token = newToken();
        this.pending.set(token, {
            type: 'guild',
            userId: interaction.user.id,
            guildId,
            fluxerGuildId: partner,
            guildName,
            expiresAt: now() + TTL_MS,
        });

        const embed = new EmbedBuilder()
            .setDescription(
                `Found Fluxer guild **${guildName}**.\nClick Confirm to bridge this Discord server to it.`
            )
            .setColor(EmbedColors.Warning)
            .setTimestamp();
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } =
            await import('discord.js');
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`bifrost:linkguild:confirm:${token}`)
                .setLabel('Confirm')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`bifrost:linkguild:cancel:${token}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary)
        );
        await interaction.editReply({
            embeds: [embed],
            components: [row],
        });
    }

    private async linkChannelSlash(interaction: ChatInputCommandInteraction) {
        const guildId = await this.ensureGuild(interaction);
        if (!guildId) return;
        if (!this.hasManageWebhooks(interaction)) {
            await interaction.reply({
                content: 'You need Manage Webhooks permission.',
                ephemeral: true,
            });
            return;
        }
        const guildLink = await this.deps.linkService
            .getGuildLinkForDiscordGuild(guildId)
            .catch(() => null);
        if (!guildLink) {
            await interaction.reply({
                content:
                    'This server is not linked to a Fluxer guild yet. Use `/bridge link guild` first.',
                ephemeral: true,
            });
            return;
        }
        const discordChannel =
            interaction.options.getChannel('discord_channel');
        const discordChannelId =
            (discordChannel?.id as string) ?? interaction.channelId;
        const fluxerChannelId = interaction.options
            .getString('fluxer_channel', true)
            .trim();

        const fluxerChannel = await this.deps.fluxerEntityResolver
            .fetchChannel(guildLink.fluxerGuildId, fluxerChannelId)
            .catch(() => null);
        if (!fluxerChannel) {
            await interaction.reply({
                content: `Could not find Fluxer channel \`${fluxerChannelId}\`.`,
                ephemeral: true,
            });
            return;
        }
        const channelName =
            (fluxerChannel as { name?: string }).name ?? fluxerChannelId;

        await interaction.deferReply({ ephemeral: true });

        const token = newToken();
        this.pending.set(token, {
            type: 'channel',
            userId: interaction.user.id,
            guildId,
            fluxerChannelId,
            channelName,
            guildLinkId: guildLink.id,
            discordChannelId,
            expiresAt: now() + TTL_MS,
        });

        const embed = new EmbedBuilder()
            .setDescription(
                `Link <#${discordChannelId}> ↔ **#${channelName}**?\nClick Confirm to create the bridge.`
            )
            .setColor(EmbedColors.Warning)
            .setTimestamp();
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } =
            await import('discord.js');
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`bifrost:linkchannel:confirm:${token}`)
                .setLabel('Confirm')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`bifrost:linkchannel:cancel:${token}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary)
        );
        await interaction.editReply({
            embeds: [embed],
            components: [row],
        });
    }

    private async autolinkSlash(interaction: ChatInputCommandInteraction) {
        const guildId = await this.ensureGuild(interaction);
        if (!guildId) return;
        if (!this.hasManageWebhooks(interaction)) {
            await interaction.reply({
                content: 'You need Manage Webhooks permission.',
                ephemeral: true,
            });
            return;
        }
        const apply = interaction.options.getBoolean('apply') ?? false;

        await interaction.deferReply({ ephemeral: true });
        const adapter = this.makeAdapter(
            interaction,
            apply ? 'autolink confirm' : 'autolink'
        );
        await this.autolinkHandler.handleCommand(
            adapter as any,
            'autolink',
            ...(apply ? ['confirm'] : [])
        );

        if (!apply && interaction.guildId) {
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(
                        `bifrost:autolink:apply:${interaction.guildId}`
                    )
                    .setLabel('Apply')
                    .setStyle(ButtonStyle.Primary)
            );
            const msg = await interaction.fetchReply();
            await msg.edit({ components: [row] });
        }
    }

    private async unlinkSlash(interaction: ChatInputCommandInteraction) {
        const guildId = await this.ensureGuild(interaction);
        if (!guildId) return;

        const guildLink = await this.deps.linkService
            .getGuildLinkForDiscordGuild(guildId)
            .catch(() => null);
        if (!guildLink) {
            await interaction.reply({
                content: 'No guild bridge found for this server.',
                ephemeral: true,
            });
            return;
        }
        const channelLinks = await this.deps.linkService
            .getChannelLinksForDiscordGuild(guildId)
            .catch(() => []);

        const { ActionRowBuilder, StringSelectMenuBuilder } =
            await import('discord.js');
        const options: any[] = [];
        options.push({
            label: 'Guild bridge (all channels)',
            description: `Fluxer guild ${guildLink.fluxerGuildId}`,
            value: 'guild',
        });
        for (const cl of channelLinks) {
            options.push({
                label: `Channel link ${cl.linkId}`,
                description: `${cl.discordChannelId} ↔ ${cl.fluxerChannelId}`,
                value: `channel:${cl.linkId}`,
            });
        }
        if (options.length === 1 && channelLinks.length === 0) {
            // only guild
        }
        const select = new StringSelectMenuBuilder()
            .setCustomId('bifrost:unlink:select')
            .setPlaceholder('Select a link to unlink')
            .addOptions(options.slice(0, 25));
        const row = new ActionRowBuilder<any>().addComponents(select);
        const embed = new EmbedBuilder()
            .setDescription(
                'Select a bridge to unlink. You will be asked to confirm.'
            )
            .setColor(EmbedColors.Info)
            .setTimestamp();
        await interaction.reply({
            embeds: [embed],
            components: [row],
            ephemeral: true,
        });
    }

    private async listSlash(interaction: ChatInputCommandInteraction) {
        const guildId = await this.ensureGuild(interaction);
        if (!guildId) return;
        const all = interaction.options.getBoolean('all') ?? false;
        const server = interaction.options.getString('server');
        const args: string[] = [];
        if (all) args.push('all');
        if (server) args.push(server);
        await interaction.deferReply({ ephemeral: true });
        const adapter = this.makeAdapter(interaction, '/bridge list');
        await this.listHandler.handleCommand(adapter as any, 'list', ...args);
    }

    private async statusSlash(interaction: ChatInputCommandInteraction) {
        const guildId = await this.ensureGuild(interaction);
        if (!guildId) return;
        await interaction.deferReply({ ephemeral: true });
        const adapter = this.makeAdapter(interaction, '/bridge status');
        await this.statsHandler.handleCommand(adapter as any);
    }

    private async logSlash(interaction: ChatInputCommandInteraction) {
        const guildId = await this.ensureGuild(interaction);
        if (!guildId) return;
        if (!this.hasManageGuild(interaction)) {
            await interaction.reply({
                content: 'You need Manage Guild permission.',
                ephemeral: true,
            });
            return;
        }
        const guildLink = await this.deps.linkService
            .getGuildLinkForDiscordGuild(guildId)
            .catch(() => null);
        if (!guildLink) {
            await interaction.reply({
                content: 'No guild bridge found for this server.',
                ephemeral: true,
            });
            return;
        }
        const channel = interaction.options.getChannel('channel');
        const changes: GuildLinkSettingsUpdate = {};
        if (channel) {
            changes.discordLogChannelId = channel.id;
        } else {
            changes.discordLogChannelId = null;
        }
        await this.deps.settingsRepo.update(guildLink.id, changes);
        await interaction.reply({
            content: channel
                ? `Bridge log channel set to <#${channel.id}>.`
                : 'Bridge log channel cleared.',
            ephemeral: true,
        });
    }

    private async settingsSlash(interaction: ChatInputCommandInteraction) {
        const guildId = await this.ensureGuild(interaction);
        if (!guildId) return;
        if (!this.hasManageGuild(interaction)) {
            await interaction.reply({
                content: 'You need Manage Guild permission.',
                ephemeral: true,
            });
            return;
        }
        const guildLink = await this.deps.linkService
            .getGuildLinkForDiscordGuild(guildId)
            .catch(() => null);
        if (!guildLink) {
            await interaction.reply({
                content: 'No guild bridge found for this server.',
                ephemeral: true,
            });
            return;
        }
        const settings = await this.deps.settingsRepo.getOrCreate(guildLink.id);
        const { embed, components } = this.buildSettings(
            guildLink.id,
            settings
        );
        await interaction.reply({
            embeds: [embed],
            components,
            ephemeral: true,
        });
    }

    private buildSettings(
        guildLinkId: string,
        settings: any
    ): { embed: EmbedBuilder; components: any[] } {
        const lines = TOGGLE_KEYS.map((t) => {
            const val = settings[t.key];
            return `${val ? '✅' : '⬜'} ${t.label}`;
        });
        const embed = new EmbedBuilder()
            .setTitle('Bifröst Settings')
            .setDescription(lines.join('\n'))
            .setColor(EmbedColors.Info)
            .setTimestamp();

        const components: any[] = [];
        // two rows of 5 toggles
        for (let i = 0; i < TOGGLE_KEYS.length; i += 5) {
            const chunk = TOGGLE_KEYS.slice(i, i + 5);
            const row = new (ActionRowBuilder as any)();
            for (const t of chunk) {
                const val = settings[t.key];
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(
                            `bifrost:settings:toggle:${guildLinkId}:${t.key}`
                        )
                        .setLabel(`${t.label}: ${val ? 'ON' : 'OFF'}`)
                        .setStyle(
                            val ? ButtonStyle.Success : ButtonStyle.Secondary
                        )
                );
            }
            components.push(row);
        }
        return { embed, components };
    }

    // ---------- Buttons ----------
    private async handleButton(interaction: ButtonInteraction) {
        const id = interaction.customId;
        if (id.startsWith('bifrost:linkguild:confirm:')) {
            const token = id.split(':').slice(3).join(':');
            await this.confirmLinkGuild(interaction, token);
            return;
        }
        if (id.startsWith('bifrost:linkguild:cancel:')) {
            const token = id.split(':').slice(3).join(':');
            this.pending.delete(token);
            await interaction.update({
                content: 'Cancelled.',
                embeds: [],
                components: [],
            });
            return;
        }
        if (id.startsWith('bifrost:linkchannel:confirm:')) {
            const token = id.split(':').slice(3).join(':');
            await this.confirmLinkChannel(interaction, token);
            return;
        }
        if (id.startsWith('bifrost:linkchannel:cancel:')) {
            const token = id.split(':').slice(3).join(':');
            this.pending.delete(token);
            await interaction.update({
                content: 'Cancelled.',
                embeds: [],
                components: [],
            });
            return;
        }
        if (id.startsWith('bifrost:autolink:apply:')) {
            await this.applyAutolink(interaction);
            return;
        }
        if (id.startsWith('bifrost:unlink:confirm:')) {
            const token = id.split(':').slice(3).join(':');
            await this.confirmUnlink(interaction, token);
            return;
        }
        if (id.startsWith('bifrost:unlink:cancel:')) {
            const token = id.split(':').slice(3).join(':');
            this.pending.delete(token);
            await interaction.update({
                content: 'Cancelled.',
                embeds: [],
                components: [],
            });
            return;
        }
        if (id.startsWith('bifrost:settings:toggle:')) {
            const parts = id.split(':');
            // bifrost:settings:toggle:<guildLinkId>:<key>
            const guildLinkId = parts[3];
            const key = parts[4] as keyof GuildLinkSettingsUpdate;
            await this.toggleSetting(interaction, guildLinkId, key);
            return;
        }
    }

    private async confirmLinkGuild(
        interaction: ButtonInteraction,
        token: string
    ) {
        const pending = this.getPending(token) as PendingLinkGuild | null;
        if (!pending || pending.type !== 'guild') {
            await interaction.reply({
                content: 'Expired or invalid action.',
                ephemeral: true,
            });
            return;
        }
        if (pending.userId !== interaction.user.id) {
            await interaction.reply({
                content: 'Not your action.',
                ephemeral: true,
            });
            return;
        }
        if (!interaction.guildId || interaction.guildId !== pending.guildId) {
            await interaction.reply({
                content: 'Wrong server.',
                ephemeral: true,
            });
            return;
        }
        if (!this.hasManageGuild(interaction)) {
            await interaction.reply({
                content: 'You need Manage Guild permission.',
                ephemeral: true,
            });
            return;
        }
        await interaction.deferUpdate();
        try {
            await this.deps.linkService.createGuildLink(
                pending.guildId,
                pending.fluxerGuildId
            );
            const embed = new EmbedBuilder()
                .setDescription(
                    `This Discord server is now bridged with Fluxer guild **${pending.guildName}**.`
                )
                .setColor(EmbedColors.Success)
                .setTimestamp();
            await interaction.editReply({ embeds: [embed], components: [] });
        } catch (err: unknown) {
            const embed = new EmbedBuilder()
                .setDescription(
                    `Failed to link guild: ${(err as Error).message}`
                )
                .setColor(EmbedColors.Error)
                .setTimestamp();
            await interaction.editReply({ embeds: [embed], components: [] });
        }
        this.pending.delete(token);
    }

    private async confirmLinkChannel(
        interaction: ButtonInteraction,
        token: string
    ) {
        const pending = this.getPending(token) as PendingLinkChannel | null;
        if (!pending || pending.type !== 'channel') {
            await interaction.reply({
                content: 'Expired or invalid action.',
                ephemeral: true,
            });
            return;
        }
        if (pending.userId !== interaction.user.id) {
            await interaction.reply({
                content: 'Not your action.',
                ephemeral: true,
            });
            return;
        }
        if (!interaction.guildId || interaction.guildId !== pending.guildId) {
            await interaction.reply({
                content: 'Wrong server.',
                ephemeral: true,
            });
            return;
        }
        if (!this.hasManageWebhooks(interaction)) {
            await interaction.reply({
                content: 'You need Manage Webhooks permission.',
                ephemeral: true,
            });
            return;
        }
        await interaction.deferUpdate();
        try {
            const discordWebhook =
                await this.deps.webhookService.createDiscordWebhook(
                    pending.discordChannelId,
                    `Fluxer Bridge Webhook for channel ${pending.discordChannelId}`
                );
            const fluxerWebhook =
                await this.deps.webhookService.createFluxerWebhook(
                    pending.fluxerChannelId,
                    `Discord Bridge Webhook for channel ${pending.fluxerChannelId}`
                );
            await this.deps.linkService.createChannelLink({
                guildLinkId: pending.guildLinkId,
                discordChannelId: pending.discordChannelId,
                fluxerChannelId: pending.fluxerChannelId,
                discordWebhookId: discordWebhook.id,
                discordWebhookToken: discordWebhook.token,
                fluxerWebhookId: fluxerWebhook.id,
                fluxerWebhookToken: fluxerWebhook.token,
            });
            const embed = new EmbedBuilder()
                .setDescription(
                    `Linked <#${pending.discordChannelId}> ↔ **#${pending.channelName}** successfully.`
                )
                .setColor(EmbedColors.Success)
                .setTimestamp();
            await interaction.editReply({ embeds: [embed], components: [] });
        } catch (err: unknown) {
            const embed = new EmbedBuilder()
                .setDescription(
                    `Failed to link channel: ${(err as Error).message}`
                )
                .setColor(EmbedColors.Error)
                .setTimestamp();
            await interaction.editReply({ embeds: [embed], components: [] });
        }
        this.pending.delete(token);
    }

    private async applyAutolink(interaction: ButtonInteraction) {
        // Recompute proposals and link all, mirroring AutolinkDiscordCommandHandler confirm.
        if (!interaction.guildId) {
            await interaction.reply({
                content: 'Wrong context.',
                ephemeral: true,
            });
            return;
        }
        if (!this.hasManageWebhooks(interaction)) {
            await interaction.reply({
                content: 'You need Manage Webhooks permission.',
                ephemeral: true,
            });
            return;
        }
        await interaction.deferUpdate();

        // We'll reuse existing handler by synthesizing? Instead recompute here.
        const guildLink = await this.deps.linkService
            .getGuildLinkForDiscordGuild(interaction.guildId)
            .catch(() => null);
        if (!guildLink) {
            await interaction.editReply({
                content: 'Guild not linked.',
                embeds: [],
                components: [],
            });
            return;
        }
        // Fetch channels
        const existingLinks = await this.deps.linkService
            .getChannelLinksForDiscordGuild(interaction.guildId)
            .catch(() => []);
        const linkedDiscordIds = new Set(
            existingLinks.map((l: any) => l.discordChannelId)
        );
        const linkedFluxerIds = new Set(
            existingLinks.map((l: any) => l.fluxerChannelId)
        );

        const allDiscordChannels = await interaction.guild!.channels.fetch();
        const discordTextChannels: ChannelInfo[] = [];
        for (const [, ch] of allDiscordChannels) {
            if (
                ch &&
                ch.type === ChannelType.GuildText &&
                !linkedDiscordIds.has(ch.id)
            ) {
                discordTextChannels.push({ id: ch.id, name: ch.name });
            }
        }
        const fluxerGuild = await this.deps.fluxerEntityResolver.fetchGuild(
            guildLink.fluxerGuildId
        );
        if (!fluxerGuild) {
            await interaction.editReply({
                content: 'Could not fetch Fluxer guild.',
                embeds: [],
                components: [],
            });
            return;
        }
        const allFluxerChannels: any[] = await (fluxerGuild as any)
            .fetchChannels()
            .catch(() => []);
        const fluxerTextChannels: ChannelInfo[] = allFluxerChannels
            .filter((ch) => ch.isTextBased() && !linkedFluxerIds.has(ch.id))
            .map((ch) => ({ id: ch.id, name: ch.name as string }));

        const proposals = matchChannels(
            discordTextChannels,
            fluxerTextChannels
        );

        let successCount = 0;
        const errors: string[] = [];
        for (const proposal of proposals) {
            try {
                const discordWebhook =
                    await this.deps.webhookService.createDiscordWebhook(
                        proposal.discord.id,
                        `Fluxer Bridge Webhook for channel ${proposal.discord.id}`
                    );
                const fluxerWebhook =
                    await this.deps.webhookService.createFluxerWebhook(
                        proposal.fluxer.id,
                        `Discord Bridge Webhook for channel ${proposal.fluxer.id}`
                    );
                await this.deps.linkService.createChannelLink({
                    guildLinkId: guildLink.id,
                    discordChannelId: proposal.discord.id,
                    fluxerChannelId: proposal.fluxer.id,
                    discordWebhookId: discordWebhook.id,
                    discordWebhookToken: discordWebhook.token,
                    fluxerWebhookId: fluxerWebhook.id,
                    fluxerWebhookToken: fluxerWebhook.token,
                });
                successCount++;
            } catch (err: unknown) {
                errors.push(
                    `#${proposal.discord.name} ↔ #${proposal.fluxer.name}: ${(err as Error).message}`
                );
            }
        }
        const summaryLine = `Successfully linked **${successCount}** of **${proposals.length}** proposed channel pair${proposals.length !== 1 ? 's' : ''}.`;
        const embed = new EmbedBuilder()
            .setDescription(
                errors.length
                    ? `${summaryLine}\nFailures:\n${errors.map((e) => `> ${e}`).join('\n')}`
                    : summaryLine
            )
            .setColor(errors.length ? EmbedColors.Warning : EmbedColors.Success)
            .setTimestamp();
        await interaction.editReply({ embeds: [embed], components: [] });
    }

    private async toggleSetting(
        interaction: ButtonInteraction,
        guildLinkId: string,
        key: keyof GuildLinkSettingsUpdate
    ) {
        if (!this.hasManageGuild(interaction)) {
            await interaction.reply({
                content: 'You need Manage Guild permission.',
                ephemeral: true,
            });
            return;
        }
        await interaction.deferUpdate();
        const settings = await this.deps.settingsRepo.getOrCreate(guildLinkId);
        const current = (settings as any)[key];
        const updated = await this.deps.settingsRepo.update(guildLinkId, {
            [key]: !current,
        } as any);
        const { embed, components } = this.buildSettings(guildLinkId, updated);
        await interaction.editReply({ embeds: [embed], components });
    }

    private async confirmUnlink(interaction: ButtonInteraction, token: string) {
        const pending = this.getPending(token) as PendingUnlink | null;
        if (
            !pending ||
            (pending.type !== 'guild' && pending.type !== 'channel')
        ) {
            await interaction.reply({
                content: 'Expired or invalid action.',
                ephemeral: true,
            });
            return;
        }
        if (pending.userId !== interaction.user.id) {
            await interaction.reply({
                content: 'Not your action.',
                ephemeral: true,
            });
            return;
        }
        if (!interaction.guildId || interaction.guildId !== pending.guildId) {
            await interaction.reply({
                content: 'Wrong server.',
                ephemeral: true,
            });
            return;
        }
        await interaction.deferUpdate();

        if (pending.type === 'guild') {
            if (!this.hasManageGuild(interaction)) {
                await interaction.editReply({
                    content: 'You need Manage Guild permission.',
                    embeds: [],
                    components: [],
                });
                return;
            }
            try {
                const channelLinks = await this.deps.linkService
                    .getChannelLinksForDiscordGuild(interaction.guildId!)
                    .catch(() => []);
                for (const link of channelLinks) {
                    await this.deps.webhookService
                        .deleteDiscordWebhook(
                            link.discordWebhookId,
                            link.discordWebhookToken
                        )
                        .catch(() => {});
                    await this.deps.webhookService
                        .deleteFluxerWebhook(
                            link.fluxerWebhookId,
                            link.fluxerWebhookToken
                        )
                        .catch(() => {});
                }
                await this.deps.linkService.removeGuildLinkFromDiscord(
                    interaction.guildId!
                );
                const embed = new EmbedBuilder()
                    .setDescription(
                        'Server bridge removed. All channel links have been deleted.'
                    )
                    .setColor(EmbedColors.Success)
                    .setTimestamp();
                await interaction.editReply({
                    embeds: [embed],
                    components: [],
                });
            } catch (err: unknown) {
                const embed = new EmbedBuilder()
                    .setDescription(
                        `Failed to unlink guild: ${(err as Error).message}`
                    )
                    .setColor(EmbedColors.Error)
                    .setTimestamp();
                await interaction.editReply({
                    embeds: [embed],
                    components: [],
                });
            }
        } else {
            if (!this.hasManageWebhooks(interaction)) {
                await interaction.editReply({
                    content: 'You need Manage Webhooks permission.',
                    embeds: [],
                    components: [],
                });
                return;
            }
            try {
                await this.deps.webhookService
                    .deleteDiscordWebhook(
                        pending.discordWebhookId!,
                        pending.discordWebhookToken!
                    )
                    .catch(() => {});
                await this.deps.webhookService
                    .deleteFluxerWebhook(
                        pending.fluxerWebhookId!,
                        pending.fluxerWebhookToken!
                    )
                    .catch(() => {});
                await this.deps.linkService.removeChannelLinkForDiscord(
                    interaction.guildId!,
                    pending.linkId!
                );
                const embed = new EmbedBuilder()
                    .setDescription('Channel bridge removed.')
                    .setColor(EmbedColors.Success)
                    .setTimestamp();
                await interaction.editReply({
                    embeds: [embed],
                    components: [],
                });
            } catch (err: unknown) {
                const embed = new EmbedBuilder()
                    .setDescription(
                        `Failed to unlink channel: ${(err as Error).message}`
                    )
                    .setColor(EmbedColors.Error)
                    .setTimestamp();
                await interaction.editReply({
                    embeds: [embed],
                    components: [],
                });
            }
        }
        this.pending.delete(token);
    }

    // ---------- Select ----------
    private async handleSelect(interaction: StringSelectMenuInteraction) {
        if (interaction.customId !== 'bifrost:unlink:select') return;
        const value = interaction.values?.[0];
        if (!value) return;
        if (!interaction.guildId) return;

        const guildLink = await this.deps.linkService
            .getGuildLinkForDiscordGuild(interaction.guildId)
            .catch(() => null);
        if (!guildLink) {
            await interaction.reply({
                content: 'No guild bridge found.',
                ephemeral: true,
            });
            return;
        }

        let pending: PendingUnlink;
        if (value === 'guild') {
            pending = {
                type: 'guild',
                userId: interaction.user.id,
                guildId: interaction.guildId,
                fluxerGuildId: guildLink.fluxerGuildId,
                expiresAt: now() + TTL_MS,
            };
        } else if (value.startsWith('channel:')) {
            const linkId = value.slice('channel:'.length);
            const channelLinks = await this.deps.linkService
                .getChannelLinksForDiscordGuild(interaction.guildId)
                .catch(() => []);
            const cl = channelLinks.find((c: any) => c.linkId === linkId);
            if (!cl) {
                await interaction.reply({
                    content: 'Link not found.',
                    ephemeral: true,
                });
                return;
            }
            pending = {
                type: 'channel',
                userId: interaction.user.id,
                guildId: interaction.guildId,
                linkId: cl.linkId,
                fluxerChannelId: cl.fluxerChannelId,
                discordChannelId: cl.discordChannelId,
                discordWebhookId: cl.discordWebhookId,
                discordWebhookToken: cl.discordWebhookToken,
                fluxerWebhookId: cl.fluxerWebhookId,
                fluxerWebhookToken: cl.fluxerWebhookToken,
                expiresAt: now() + TTL_MS,
            };
        } else {
            return;
        }

        const token = newToken();
        this.pending.set(token, pending);

        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } =
            await import('discord.js');
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`bifrost:unlink:confirm:${token}`)
                .setLabel('Confirm')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`bifrost:unlink:cancel:${token}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary)
        );
        const desc =
            pending.type === 'guild'
                ? `This will remove the bridge between this Discord server and Fluxer guild \`${pending.fluxerGuildId}\`, including **all** channel links.\nClick Confirm to proceed.`
                : `This will remove the channel bridge for Fluxer channel \`${pending.fluxerChannelId}\` ↔ <#${pending.discordChannelId}>.\nClick Confirm to proceed.`;
        const embed = new EmbedBuilder()
            .setDescription(desc)
            .setColor(EmbedColors.Warning)
            .setTimestamp();
        await interaction.update({ embeds: [embed], components: [row] });
    }

    // ---------- Adapter for legacy handlers ----------
    private makeAdapter(
        interaction: ChatInputCommandInteraction,
        content: string
    ): any {
        let replied = false;
        const adapter: any = {
            client: interaction.client,
            author: interaction.user,
            user: interaction.user,
            guild: interaction.guild,
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            channel: interaction.channel,
            inGuild: () => interaction.inGuild(),
            content,
            footer: () => null,
            reply: async (payload: any) => {
                if (!replied) {
                    replied = true;
                    await interaction.editReply(payload);
                } else {
                    await interaction.followUp({ ...payload, ephemeral: true });
                }
            },
            createDM: async () => interaction.user.createDM(),
        };
        // defer now
        return adapter;
    }
}

export default InteractionRouter;
