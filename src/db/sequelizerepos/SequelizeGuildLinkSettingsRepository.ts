import { UniqueConstraintError } from 'sequelize';
import {
    DEFAULT_GUILD_LINK_SETTINGS,
    GuildLinkSettings,
    GuildLinkSettingsUpdate,
} from '../entities/GuildLinkSettings';
import { GuildLinkSettingsModel } from '../models';
import { GuildLinkSettingsRepository } from '../repositories/GuildLinkSettingsRepository';

export class SequelizeGuildLinkSettingsRepository implements GuildLinkSettingsRepository {
    async findByGuildLinkId(guildLinkId: string) {
        const model = await GuildLinkSettingsModel.findOne({
            where: { guildLinkId },
        });

        if (!model) return null;

        return model.toJSON() as GuildLinkSettings;
    }

    async getOrCreate(guildLinkId: string) {
        const existing = await this.findByGuildLinkId(guildLinkId);
        if (existing) return existing;

        try {
            const model = await GuildLinkSettingsModel.create({
                guildLinkId,
                ...DEFAULT_GUILD_LINK_SETTINGS,
            });

            return model.toJSON() as GuildLinkSettings;
        } catch (error) {
            // Concurrent first access: the row now exists.
            if (error instanceof UniqueConstraintError) {
                const existing = await this.findByGuildLinkId(guildLinkId);
                if (existing) return existing;
            }
            throw error;
        }
    }

    async update(guildLinkId: string, changes: GuildLinkSettingsUpdate) {
        await this.getOrCreate(guildLinkId);

        await GuildLinkSettingsModel.update(changes, {
            where: { guildLinkId },
        });

        const updated = await this.findByGuildLinkId(guildLinkId);
        if (!updated) {
            throw new Error(
                `Guild link settings disappeared during update: ${guildLinkId}`
            );
        }

        return updated;
    }

    async deleteByGuildLinkId(guildLinkId: string) {
        await GuildLinkSettingsModel.destroy({
            where: { guildLinkId },
        });
    }
}
