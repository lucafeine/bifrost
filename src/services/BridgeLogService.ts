import {
    Client as DiscordClient,
    EmbedBuilder as DiscordEmbedBuilder,
} from 'discord.js';
import {
    Client as FluxerClient,
    EmbedBuilder as FluxerEmbedBuilder,
} from '@fluxerjs/core';
import { GuildLinkSettingsRepository } from '../db/repositories/GuildLinkSettingsRepository';
import { EmbedColors } from '../utils/embeds';
import logger from '../utils/logging/logger';

export type BridgeLogLevel = 'info' | 'warn' | 'error';

const LEVEL_COLORS: Record<BridgeLogLevel, number> = {
    info: EmbedColors.Info,
    warn: EmbedColors.Warning,
    error: EmbedColors.Error,
};

const LEVEL_PREFIX: Record<BridgeLogLevel, string> = {
    info: 'ℹ️',
    warn: '⚠️',
    error: '❌',
};

/**
 * Posts compact sync-event embeds to the bridge log channels configured on a
 * guild link. Silent when no log channel is configured (the default).
 */
export default class BridgeLogService {
    private discordClient: DiscordClient | null = null;
    private fluxerClient: FluxerClient | null = null;

    constructor(private readonly settingsRepo: GuildLinkSettingsRepository) {}

    setDiscordClient(client: DiscordClient) {
        this.discordClient = client;
    }

    setFluxerClient(client: FluxerClient) {
        this.fluxerClient = client;
    }

    async post(
        guildLinkId: string,
        level: BridgeLogLevel,
        text: string
    ): Promise<void> {
        const settings = await this.settingsRepo
            .findByGuildLinkId(guildLinkId)
            .catch((err) => {
                logger.error('Bridge log settings lookup failed:', err);
                return null;
            });

        if (!settings) return;

        const jobs: Promise<void>[] = [];

        if (settings.discordLogChannelId && this.discordClient) {
            jobs.push(
                this.postDiscord(settings.discordLogChannelId, level, text)
            );
        }

        if (settings.fluxerLogChannelId && this.fluxerClient) {
            jobs.push(
                this.postFluxer(settings.fluxerLogChannelId, level, text)
            );
        }

        await Promise.allSettled(jobs);
    }

    private async postDiscord(
        channelId: string,
        level: BridgeLogLevel,
        text: string
    ): Promise<void> {
        try {
            const channel = await this.discordClient!.channels.fetch(channelId);
            if (!channel || !channel.isTextBased() || !('send' in channel))
                return;

            await channel.send({
                embeds: [
                    new DiscordEmbedBuilder()
                        .setDescription(`${LEVEL_PREFIX[level]} ${text}`)
                        .setColor(LEVEL_COLORS[level])
                        .setTimestamp(),
                ],
            });
        } catch (err) {
            logger.error('Bridge log post to Discord failed:', err);
        }
    }

    private async postFluxer(
        channelId: string,
        level: BridgeLogLevel,
        text: string
    ): Promise<void> {
        try {
            await this.fluxerClient!.channels.send(channelId, {
                embeds: [
                    new FluxerEmbedBuilder()
                        .setDescription(`${LEVEL_PREFIX[level]} ${text}`)
                        .setColor(LEVEL_COLORS[level])
                        .setTimestamp(),
                ],
            });
        } catch (err) {
            logger.error('Bridge log post to Fluxer failed:', err);
        }
    }
}
