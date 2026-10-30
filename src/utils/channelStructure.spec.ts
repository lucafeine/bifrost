import { describe, expect, it } from 'vitest';
import {
    changedStructureFields,
    fieldsForKind,
    normalizeChannelName,
    structureCreateKey,
    structureDeleteKey,
    structureSnapshot,
    structureUpdateKey,
    toDiscordChannelName,
} from './channelStructure';

describe('normalizeChannelName', () => {
    it('lowercases and turns whitespace into dashes', () => {
        expect(normalizeChannelName('My Channel')).toBe('my-channel');
        expect(normalizeChannelName('  spaced   out  ')).toBe('spaced-out');
    });

    it('keeps existing dashes', () => {
        expect(normalizeChannelName('general-chat')).toBe('general-chat');
    });
});

describe('toDiscordChannelName', () => {
    it('shapes Fluxer names into Discord-safe names', () => {
        expect(toDiscordChannelName('My Channel')).toBe('my-channel');
        expect(toDiscordChannelName('Général')).toBe('général');
        expect(toDiscordChannelName('news & updates!')).toBe('news-updates');
    });

    it('never returns an empty name', () => {
        expect(toDiscordChannelName('!!!')).toBe('channel');
    });
});

describe('structureSnapshot', () => {
    it('canonicalizes missing fields', () => {
        expect(structureSnapshot({ name: 'general', parentId: null })).toEqual({
            name: 'general',
            topic: null,
            nsfw: false,
            rateLimitPerUser: 0,
            parentId: null,
        });
    });

    it('reads text channel fields', () => {
        expect(
            structureSnapshot({
                name: 'general',
                topic: 'hi',
                nsfw: true,
                rateLimitPerUser: 5,
                parentId: '123',
            })
        ).toEqual({
            name: 'general',
            topic: 'hi',
            nsfw: true,
            rateLimitPerUser: 5,
            parentId: '123',
        });
    });
});

describe('changedStructureFields / fieldsForKind', () => {
    const base = structureSnapshot({ name: 'general', parentId: '1' });

    it('detects changed fields only', () => {
        const next = structureSnapshot({
            name: 'general',
            topic: 'new topic',
            parentId: '1',
        });
        expect(changedStructureFields(base, next)).toEqual(['topic']);
    });

    it('drops text-only fields for categories', () => {
        expect(
            fieldsForKind(
                ['name', 'topic', 'nsfw', 'rateLimitPerUser'],
                'category'
            )
        ).toEqual(['name']);
        expect(
            fieldsForKind(['name', 'topic', 'parentId'], 'category')
        ).toEqual(['name', 'parentId']);
        expect(fieldsForKind(['topic', 'nsfw'], 'text')).toEqual([
            'topic',
            'nsfw',
        ]);
    });
});

describe('echo keys', () => {
    it('normalizes the name in create keys', () => {
        expect(structureCreateKey('fluxer', 'My Channel', 'text')).toBe(
            structureCreateKey('fluxer', 'my-channel', 'text')
        );
        expect(structureCreateKey('discord', 'My Channel', 'text')).not.toBe(
            structureCreateKey('discord', 'my-channel', 'category')
        );
    });

    it('scopes delete keys to the platform and channel', () => {
        expect(structureDeleteKey('discord', '42')).toBe(
            'discord:channel:delete:42'
        );
    });

    it('serializes update values identically for equal values', () => {
        expect(structureUpdateKey('fluxer', '1', 'topic', 'hello')).toBe(
            'fluxer:channel:update:1:topic:"hello"'
        );
        expect(structureUpdateKey('discord', '1', 'parentId', null)).toBe(
            structureUpdateKey('discord', '1', 'parentId', null)
        );
    });
});
