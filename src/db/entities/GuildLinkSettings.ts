export interface GuildLinkSettings {
    guildLinkId: string;

    syncReactions: boolean;
    syncTyping: boolean;
    syncPins: boolean;
    syncSystemMessages: boolean;

    syncChannelStructure: boolean;
    autoLinkCreatedChannels: boolean;
    syncChannelDeletes: boolean;

    syncRoleStructure: boolean;
    syncRoleDeletes: boolean;

    mirrorEmojis: boolean;

    discordLogChannelId: string | null;
    fluxerLogChannelId: string | null;

    updatedAt: Date;
}

export type GuildLinkSettingsUpdate = Partial<
    Omit<GuildLinkSettings, 'guildLinkId' | 'updatedAt'>
>;

/**
 * Defaults rationale: non-destructive features (reactions, typing, pins, emojis)
 * default to on; anything that creates or deletes guild structure defaults to off
 * and is enabled from the management panel.
 */
export const DEFAULT_GUILD_LINK_SETTINGS: Omit<
    GuildLinkSettings,
    'guildLinkId' | 'updatedAt'
> = {
    syncReactions: true,
    syncTyping: true,
    syncPins: true,
    syncSystemMessages: true,

    syncChannelStructure: false,
    autoLinkCreatedChannels: true,
    syncChannelDeletes: false,

    syncRoleStructure: false,
    syncRoleDeletes: false,

    mirrorEmojis: true,

    discordLogChannelId: null,
    fluxerLogChannelId: null,
};
