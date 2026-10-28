import {
    GuildLinkSettings,
    GuildLinkSettingsUpdate,
} from '../entities/GuildLinkSettings';

export interface GuildLinkSettingsRepository {
    findByGuildLinkId(guildLinkId: string): Promise<GuildLinkSettings | null>;

    /**
     * Returns the settings for a guild link, creating the row with defaults on
     * first access.
     */
    getOrCreate(guildLinkId: string): Promise<GuildLinkSettings>;

    update(
        guildLinkId: string,
        changes: GuildLinkSettingsUpdate
    ): Promise<GuildLinkSettings>;

    deleteByGuildLinkId(guildLinkId: string): Promise<void>;
}
