export interface FetchMessageOptions {
    /** Bypass the message cache and fetch fresh state from the API. */
    force?: boolean;
}

export default interface EntityResolver<Guild, Channel, Message, Emoji> {
    fetchGuild(guildId: string): Promise<Guild | null>;
    fetchChannel(
        guildId: string | Guild,
        channelId: string
    ): Promise<Channel | null>;
    fetchMessage(
        guildId: string | Guild,
        channelId: string | Channel,
        messageId: string,
        options?: FetchMessageOptions
    ): Promise<Message>;
    fetchEmojis(guildId: string | Guild): Promise<Emoji[]>;
}
