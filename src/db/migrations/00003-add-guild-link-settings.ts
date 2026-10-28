import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';
import { DEFAULT_GUILD_LINK_SETTINGS } from '../entities/GuildLinkSettings';

const BOOLEAN_COLUMNS = [
    'syncReactions',
    'syncTyping',
    'syncPins',
    'syncSystemMessages',
    'syncChannelStructure',
    'autoLinkCreatedChannels',
    'syncChannelDeletes',
    'syncRoleStructure',
    'syncRoleDeletes',
    'mirrorEmojis',
] as const;

export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.createTable('guild_link_settings', {
        guildLinkId: {
            type: DataTypes.UUID,
            primaryKey: true,
            references: { model: 'guild_links', key: 'id' },
            onDelete: 'CASCADE',
        },
        syncReactions: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: DEFAULT_GUILD_LINK_SETTINGS.syncReactions,
        },
        syncTyping: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: DEFAULT_GUILD_LINK_SETTINGS.syncTyping,
        },
        syncPins: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: DEFAULT_GUILD_LINK_SETTINGS.syncPins,
        },
        syncSystemMessages: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: DEFAULT_GUILD_LINK_SETTINGS.syncSystemMessages,
        },
        syncChannelStructure: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: DEFAULT_GUILD_LINK_SETTINGS.syncChannelStructure,
        },
        autoLinkCreatedChannels: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: DEFAULT_GUILD_LINK_SETTINGS.autoLinkCreatedChannels,
        },
        syncChannelDeletes: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: DEFAULT_GUILD_LINK_SETTINGS.syncChannelDeletes,
        },
        syncRoleStructure: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: DEFAULT_GUILD_LINK_SETTINGS.syncRoleStructure,
        },
        syncRoleDeletes: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: DEFAULT_GUILD_LINK_SETTINGS.syncRoleDeletes,
        },
        mirrorEmojis: {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: DEFAULT_GUILD_LINK_SETTINGS.mirrorEmojis,
        },
        discordLogChannelId: { type: DataTypes.STRING, allowNull: true },
        fluxerLogChannelId: { type: DataTypes.STRING, allowNull: true },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
    });

    // Backfill one settings row per existing guild link so reads never hit a
    // missing row. Column defaults carry the values.
    const [guildLinks] = await queryInterface.sequelize.query(
        'SELECT id FROM guild_links'
    );
    if (Array.isArray(guildLinks) && guildLinks.length > 0) {
        await queryInterface.bulkInsert(
            'guild_link_settings',
            guildLinks.map((row) => {
                const record: Record<string, unknown> = {
                    guildLinkId: (row as { id: string }).id,
                    updatedAt: new Date(),
                };
                for (const column of BOOLEAN_COLUMNS) {
                    record[column] = DEFAULT_GUILD_LINK_SETTINGS[column];
                }
                return record;
            })
        );
    }
};

export const down: Migration = async ({ context: queryInterface }) => {
    await queryInterface.dropTable('guild_link_settings');
};
