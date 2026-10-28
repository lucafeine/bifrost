import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';
import { DEFAULT_GUILD_LINK_SETTINGS } from '../entities/GuildLinkSettings';

export class GuildLinkSettingsModel extends Model {}

GuildLinkSettingsModel.init(
    {
        guildLinkId: {
            type: DataTypes.UUID,
            primaryKey: true,
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
        discordLogChannelId: {
            type: DataTypes.STRING,
            allowNull: true,
        },
        fluxerLogChannelId: {
            type: DataTypes.STRING,
            allowNull: true,
        },
    },
    {
        sequelize,
        tableName: 'guild_link_settings',
        createdAt: false,
        updatedAt: 'updatedAt',
    }
);
