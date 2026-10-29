import { randomUUID } from 'crypto';
import { StructureLinkRepository } from '../repositories/StructureLinkRepository';
import { StructureLinkModel } from '../models/StructureLinkModel';
import { StructureLink } from '../entities/StructureLink';

export class SequelizeStructureLinkRepository implements StructureLinkRepository {
    async create(params: {
        guildLinkId: string;
        discordChannelId: string;
        fluxerChannelId: string;
        kind: 'category' | 'text';
        origin: 'manual' | 'auto' | 'autolink';
    }): Promise<StructureLink> {
        const model = await StructureLinkModel.create({
            id: randomUUID(),
            guildLinkId: params.guildLinkId,
            discordChannelId: params.discordChannelId,
            fluxerChannelId: params.fluxerChannelId,
            kind: params.kind,
            origin: params.origin,
            createdAt: new Date(),
        });
        return model.toJSON() as StructureLink;
    }

    async findByDiscordChannelId(
        discordChannelId: string
    ): Promise<StructureLink | null> {
        const model = await StructureLinkModel.findOne({
            where: { discordChannelId },
        });
        if (!model) return null;
        return model.toJSON() as StructureLink;
    }

    async findByFluxerChannelId(
        fluxerChannelId: string
    ): Promise<StructureLink | null> {
        const model = await StructureLinkModel.findOne({
            where: { fluxerChannelId },
        });
        if (!model) return null;
        return model.toJSON() as StructureLink;
    }

    async findByGuildLinkId(guildLinkId: string): Promise<StructureLink[]> {
        const models = await StructureLinkModel.findAll({
            where: { guildLinkId },
        });
        return models.map((m) => m.toJSON() as StructureLink);
    }

    async deleteById(id: string): Promise<void> {
        await StructureLinkModel.destroy({ where: { id } });
    }

    async deleteByGuildLinkId(guildLinkId: string): Promise<void> {
        await StructureLinkModel.destroy({ where: { guildLinkId } });
    }
}