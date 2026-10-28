import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// env.ts exits when tokens are missing and picks the sqlite storage path from
// BF_CONFIG_PATH, so both must be set before anything imports the DB layer.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-migration-'));
process.env.BF_DISCORD_TOKEN = 'test-token';
process.env.BF_FLUXER_TOKEN = 'test-token';
process.env.BF_DB_DIALECT = 'sqlite';
process.env.BF_CONFIG_PATH = tmpDir;

const { default: sequelize } = await import('../sequelize');
const { default: umzug } = await import('../migrator');
const baseline = await import('./00001-baseline');
const settingsMigration = await import('./00003-add-guild-link-settings');
const { SequelizeGuildLinkSettingsRepository } =
    await import('../sequelizerepos/SequelizeGuildLinkSettingsRepository');
const { GuildLinkModel } = await import('../models');

const queryInterface = sequelize.getQueryInterface();
const migrationContext = { context: queryInterface } as Parameters<
    typeof baseline.up
>[0];

describe('00003-add-guild-link-settings (sqlite)', () => {
    beforeAll(async () => {
        await sequelize.authenticate();
    });

    afterAll(async () => {
        await sequelize.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('is picked up by the migration runner', async () => {
        const pending = (await umzug.pending()).map((m) => m.name);
        expect(pending).toContain('00003-add-guild-link-settings.ts');
    });

    it('applies cleanly and backfills existing guild links', async () => {
        await baseline.up(migrationContext);

        await GuildLinkModel.create({
            id: '11111111-1111-1111-1111-111111111111',
            discordGuildId: 'discord-guild',
            fluxerGuildId: 'fluxer-guild',
        });

        await settingsMigration.up(migrationContext);

        const tables = (await queryInterface.showAllTables()).map((t) =>
            typeof t === 'string' ? t : t.tableName
        );
        expect(tables).toContain('guild_link_settings');

        const rows = await queryInterface.select(null, 'guild_link_settings', {
            where: { guildLinkId: '11111111-1111-1111-1111-111111111111' },
        });
        expect(rows).toHaveLength(1);

        const row = rows[0] as Record<string, unknown>;
        expect(row.syncReactions).toBeTruthy();
        expect(row.syncTyping).toBeTruthy();
        expect(row.syncPins).toBeTruthy();
        expect(row.syncSystemMessages).toBeTruthy();
        expect(row.syncChannelStructure).toBeFalsy();
        expect(row.syncChannelDeletes).toBeFalsy();
        expect(row.syncRoleStructure).toBeFalsy();
        expect(row.syncRoleDeletes).toBeFalsy();
        expect(row.mirrorEmojis).toBeTruthy();
    });

    it('supports reads and updates through the repository', async () => {
        const repo = new SequelizeGuildLinkSettingsRepository();
        const guildLinkId = '11111111-1111-1111-1111-111111111111';

        const existing = await repo.findByGuildLinkId(guildLinkId);
        expect(existing).not.toBeNull();
        expect(existing!.syncReactions).toBe(true);
        expect(existing!.syncChannelStructure).toBe(false);

        const updated = await repo.update(guildLinkId, {
            syncChannelStructure: true,
            discordLogChannelId: 'log-channel',
        });
        expect(updated.syncChannelStructure).toBe(true);
        expect(updated.discordLogChannelId).toBe('log-channel');
        expect(updated.syncReactions).toBe(true);

        // getOrCreate also creates missing rows for new guild links.
        await GuildLinkModel.create({
            id: '22222222-2222-2222-2222-222222222222',
            discordGuildId: 'discord-guild-2',
            fluxerGuildId: 'fluxer-guild-2',
        });
        const created = await repo.getOrCreate(
            '22222222-2222-2222-2222-222222222222'
        );
        expect(created.syncReactions).toBe(true);
        expect(created.fluxerLogChannelId).toBeNull();
    });

    it('rolls back cleanly', async () => {
        await settingsMigration.down(migrationContext);

        const tables = (await queryInterface.showAllTables()).map((t) =>
            typeof t === 'string' ? t : t.tableName
        );
        expect(tables).not.toContain('guild_link_settings');
    });
});
