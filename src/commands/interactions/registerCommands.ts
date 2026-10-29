import crypto from 'crypto';
import {
    PermissionFlagsBits,
    REST,
    Routes,
    SlashCommandBuilder,
} from 'discord.js';
import { DISCORD_APP_ID, DISCORD_TOKEN } from '../../utils/env';
import logger from '../../utils/logging/logger';

const COMMAND_DEFINITION = new SlashCommandBuilder()
    .setName('bridge')
    .setDescription('Bifröst management panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommandGroup((group) =>
        group
            .setName('link')
            .setDescription('Link this Discord server/channel to Fluxer')
            .addSubcommand((sub) =>
                sub
                    .setName('guild')
                    .setDescription(
                        'Bridge this Discord server to a Fluxer guild'
                    )
                    .addStringOption((opt) =>
                        opt
                            .setName('partner')
                            .setDescription('Fluxer guild ID')
                            .setRequired(true)
                    )
            )
            .addSubcommand((sub) =>
                sub
                    .setName('channel')
                    .setDescription(
                        'Link a Discord channel to a Fluxer channel'
                    )
                    .addStringOption((opt) =>
                        opt
                            .setName('fluxer_channel')
                            .setDescription('Fluxer channel (id or name)')
                            .setRequired(true)
                            .setAutocomplete(true)
                    )
                    .addChannelOption((opt) =>
                        opt
                            .setName('discord_channel')
                            .setDescription(
                                'Discord channel (defaults to current)'
                            )
                            .setRequired(false)
                    )
            )
    )
    .addSubcommand((sub) =>
        sub
            .setName('autolink')
            .setDescription('Fuzzy-match and link channels')
            .addBooleanOption((opt) =>
                opt
                    .setName('apply')
                    .setDescription('Apply proposed links immediately')
                    .setRequired(false)
            )
    )
    .addSubcommand((sub) =>
        sub.setName('unlink').setDescription('Unlink a guild or channel bridge')
    )
    .addSubcommand((sub) =>
        sub
            .setName('list')
            .setDescription('List channel links')
            .addBooleanOption((opt) =>
                opt
                    .setName('all')
                    .setDescription('List all guilds (owner only)')
                    .setRequired(false)
            )
            .addStringOption((opt) =>
                opt
                    .setName('server')
                    .setDescription('Server ID (owner only)')
                    .setRequired(false)
            )
    )
    .addSubcommand((sub) =>
        sub.setName('settings').setDescription('Interactive settings panel')
    )
    .addSubcommand((sub) =>
        sub.setName('status').setDescription('Bot status and health')
    )
    .addSubcommand((sub) =>
        sub
            .setName('log')
            .setDescription('Set or clear the bridge log channel')
            .addChannelOption((opt) =>
                opt
                    .setName('channel')
                    .setDescription('Log channel (omit to clear)')
                    .setRequired(false)
            )
    )
    .addSubcommand((sub) =>
        sub.setName('help').setDescription('List bridge commands')
    );

const META_KEYS = new Set([
    'id',
    'application_id',
    'guild_id',
    'version',
    'default_permission',
]);

function normalize(obj: unknown): unknown {
    if (Array.isArray(obj)) return obj.map(normalize);
    if (obj && typeof obj === 'object') {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(obj as Record<string, unknown>)) {
            if (META_KEYS.has(key)) continue;
            out[key] = normalize((obj as Record<string, unknown>)[key]);
        }
        return out;
    }
    return obj;
}

function canonical(obj: unknown): string {
    if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
    if (obj && typeof obj === 'object') {
        const keys = Object.keys(obj as Record<string, unknown>).sort();
        return (
            '{' +
            keys
                .map(
                    (k) =>
                        JSON.stringify(k) +
                        ':' +
                        canonical((obj as Record<string, unknown>)[k])
                )
                .join(',') +
            '}'
        );
    }
    return JSON.stringify(obj);
}

function hash(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

const DESIRED_HASH = hash(canonical(normalize(COMMAND_DEFINITION.toJSON())));

export async function registerBridgeCommandsForGuild(
    guildId: string
): Promise<void> {
    if (!DISCORD_APP_ID || !DISCORD_TOKEN) return;

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

    try {
        const existing = (await rest.get(
            Routes.applicationGuildCommands(DISCORD_APP_ID, guildId)
        )) as Array<{ name: string; [key: string]: unknown }>;

        const bridge = existing.find((c) => c.name === 'bridge');
        const existingHash = bridge ? hash(canonical(normalize(bridge))) : null;

        // Only skip if the registered bridge command is byte-identical to desired.
        if (existingHash === DESIRED_HASH) {
            return;
        }

        // Preserve other guild commands by filtering out old bridge, then PUT full list?
        // Simpler: PUT only bridge command (replaces all guild commands). To avoid clobbering,
        // merge: keep non-bridge commands.
        const others = existing.filter((c) => c.name !== 'bridge');
        const payload = [...others, COMMAND_DEFINITION.toJSON()];

        await rest.put(
            Routes.applicationGuildCommands(DISCORD_APP_ID, guildId),
            {
                body: payload,
            }
        );
        logger.info(`Registered /bridge slash command for guild ${guildId}`);
    } catch (err) {
        logger.error(`Failed to register /bridge for guild ${guildId}:`, err);
    }
}

export async function registerBridgeCommands(client: {
    guilds: { cache: Map<string, unknown> };
}): Promise<void> {
    const guildIds = [...client.guilds.cache.keys()];
    await Promise.all(guildIds.map((id) => registerBridgeCommandsForGuild(id)));
}
