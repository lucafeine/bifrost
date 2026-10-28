import NodeCache from 'node-cache';
import {
    GuildLinkSettings,
    GuildLinkSettingsUpdate,
} from '../entities/GuildLinkSettings';
import { GuildLinkSettingsRepository } from '../repositories/GuildLinkSettingsRepository';

/**
 * Settings are read on every relayed sync event, so reads go through a short
 * TTL cache. Writes go through the cache (write-through + invalidate) so the
 * management panel sees its own changes immediately; relays converge within
 * the TTL.
 */
export class CachedGuildLinkSettingsRepository implements GuildLinkSettingsRepository {
    private cache: NodeCache;

    constructor(
        private readonly repository: GuildLinkSettingsRepository,
        ttlSeconds: number
    ) {
        this.cache = new NodeCache({ stdTTL: ttlSeconds });
    }

    private key(guildLinkId: string) {
        return `settings:${guildLinkId}`;
    }

    async findByGuildLinkId(guildLinkId: string) {
        const cached = this.cache.get<GuildLinkSettings>(this.key(guildLinkId));
        if (cached) return cached;

        const result = await this.repository.findByGuildLinkId(guildLinkId);
        if (!result) return null;

        this.cache.set(this.key(guildLinkId), result);
        return result;
    }

    async getOrCreate(guildLinkId: string) {
        const cached = this.cache.get<GuildLinkSettings>(this.key(guildLinkId));
        if (cached) return cached;

        const result = await this.repository.getOrCreate(guildLinkId);
        this.cache.set(this.key(guildLinkId), result);
        return result;
    }

    async update(guildLinkId: string, changes: GuildLinkSettingsUpdate) {
        const updated = await this.repository.update(guildLinkId, changes);
        this.cache.set(this.key(guildLinkId), updated);
        return updated;
    }

    async deleteByGuildLinkId(guildLinkId: string) {
        await this.repository.deleteByGuildLinkId(guildLinkId);
        this.cache.del(this.key(guildLinkId));
    }
}
