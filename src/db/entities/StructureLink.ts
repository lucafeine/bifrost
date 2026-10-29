export type StructureLinkKind = 'category' | 'text';
export type StructureLinkOrigin = 'manual' | 'auto' | 'autolink';

export interface StructureLink {
    id: string;
    guildLinkId: string;
    discordChannelId: string;
    fluxerChannelId: string;
    kind: StructureLinkKind;
    origin: StructureLinkOrigin;
    createdAt: Date;
}