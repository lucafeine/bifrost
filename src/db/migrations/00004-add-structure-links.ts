import { DataTypes } from 'sequelize';
import type { Migration } from '../migrator';

export const up: Migration = async ({ context: queryInterface }) => {
    await queryInterface.createTable('structure_links', {
        id: {
            type: DataTypes.UUID,
            primaryKey: true,
        },
        guildLinkId: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'guild_links', key: 'id' },
            onDelete: 'CASCADE',
        },
        discordChannelId: {
            type: DataTypes.STRING,
            allowNull: false,
            unique: true,
        },
        fluxerChannelId: {
            type: DataTypes.STRING,
            allowNull: false,
            unique: true,
        },
        kind: {
            type: DataTypes.ENUM('category', 'text'),
            allowNull: false,
        },
        origin: {
            type: DataTypes.ENUM('manual', 'auto', 'autolink'),
            allowNull: false,
            defaultValue: 'manual',
        },
        createdAt: {
            type: DataTypes.DATE,
            allowNull: false,
        },
    });

    await queryInterface.addIndex('structure_links', ['guildLinkId']);
};

export const down: Migration = async ({ context: queryInterface }) => {
    await queryInterface.dropTable('structure_links');
};