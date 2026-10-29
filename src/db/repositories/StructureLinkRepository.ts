import { StructureLink, StructureLinkKind, StructureLinkOrigin } from '../entities/StructureLink';

export interface StructureLinkRepository {
    create(params: {
        guildLinkId: string;
        discordChannelId: string;
        fluxerChannelId: string;
        kind: StructureLinkKind;
        origin: StructureLinkOrigin;
    }): Promise<StructureLink>;

    findByDiscordChannelId(
        discordChannelId: string
    ): Promise<StructureLink | null>;

    findByFluxerChannelId(
        fluxerChannelId: string
    ): Promise<StructureLink | null>;

    findByGuildLinkId(guildLinkId: string): Promise<StructureLink[]>;

    deleteById(id: string): Promise<void>;

    deleteByGuildLinkId(guildLinkId: string): Promise<void>;
}