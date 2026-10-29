import { DataTypes, Model } from 'sequelize';
import sequelize from '../sequelize';
import { randomUUID } from 'crypto';

export class StructureLinkModel extends Model {}

StructureLinkModel.init(
    {
        id: {
            type: DataTypes.UUID,
            primaryKey: true,
            defaultValue: () => randomUUID(),
        },
        guildLinkId: {
            type: DataTypes.UUID,
            allowNull: false,
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
            defaultValue: DataTypes.NOW,
        },
    },
    {
        sequelize,
        modelName: 'StructureLink',
        tableName: 'structure_links',
        timestamps: false,
    }
);