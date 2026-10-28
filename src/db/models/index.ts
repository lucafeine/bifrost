import { GuildLinkModel } from './GuildLinkModel';
import { GuildLinkSettingsModel } from './GuildLinkSettingsModel';
import { ChannelLinkModel } from './ChannelLinkModel';
import { MessageLinkModel } from './MessageLinkModel';
import { QueuedMessageModel } from './QueuedMessageModel';

// Guild -> Settings
GuildLinkModel.hasOne(GuildLinkSettingsModel, {
    foreignKey: 'guildLinkId',
    as: 'settings',
    onDelete: 'CASCADE',
});

GuildLinkSettingsModel.belongsTo(GuildLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'guildLink',
});

// Guild -> Channel
GuildLinkModel.hasMany(ChannelLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'channelLinks',
    onDelete: 'CASCADE',
});

ChannelLinkModel.belongsTo(GuildLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'guildLink',
});

// Guild -> MessageLinks
GuildLinkModel.hasMany(MessageLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'messageLinks',
    onDelete: 'CASCADE',
});

MessageLinkModel.belongsTo(GuildLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'guildLink',
});

// Channel -> MessageLinks
ChannelLinkModel.hasMany(MessageLinkModel, {
    foreignKey: 'channelLinkId',
    as: 'messageLinks',
    onDelete: 'CASCADE',
});

MessageLinkModel.belongsTo(ChannelLinkModel, {
    foreignKey: 'channelLinkId',
    as: 'channelLink',
});

export {
    GuildLinkModel,
    GuildLinkSettingsModel,
    ChannelLinkModel,
    MessageLinkModel,
    QueuedMessageModel,
};
