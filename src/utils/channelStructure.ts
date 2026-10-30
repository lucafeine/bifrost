/**
 * Shared helpers for P4 channel structure sync: name shaping and the
 * `SyncEchoGuard` key scheme used to suppress mirrored create/update/delete
 * events (see `src/services/SyncEchoGuard.ts`).
 *
 * Echo keys are built from the values the *eventing platform* reports, in its
 * own coordinates: a mirror reserves the key its target event will carry, and
 * the target handler consumes it when the event arrives.
 */

export type StructureKind = 'category' | 'text';
export type StructurePlatform = 'discord' | 'fluxer';

export type StructureField =
    | 'name'
    | 'topic'
    | 'nsfw'
    | 'rateLimitPerUser'
    | 'parentId';

/**
 * Canonical P4 field values of a channel. Platform-agnostic except
 * `parentId`, which is the parent ID *on the same platform*.
 */
export interface StructureSnapshot {
    name: string;
    topic: string | null;
    nsfw: boolean;
    rateLimitPerUser: number;
    parentId: string | null;
}

/** Lowercase + dashes: normalized form used to match names across platforms. */
export function normalizeChannelName(name: string): string {
    return name.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Shape a channel name so the Discord API accepts it: Discord text channel
 * names are lowercase, whitespace becomes dashes and stray punctuation is
 * dropped (Fluxer allows nicer names).
 */
export function toDiscordChannelName(name: string): string {
    const shaped = name
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\p{L}\p{N}_-]/gu, '')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '');
    return shaped || 'channel';
}

/** Read the canonical P4 fields off a Discord or Fluxer channel object. */
export function structureSnapshot(channel: unknown): StructureSnapshot {
    const c = channel as {
        name?: string | null;
        topic?: string | null;
        nsfw?: boolean;
        rateLimitPerUser?: number | null;
        parentId?: string | null;
    };
    return {
        name: c.name ?? '',
        topic: c.topic ?? null,
        nsfw: c.nsfw ?? false,
        rateLimitPerUser: c.rateLimitPerUser ?? 0,
        parentId: c.parentId ?? null,
    };
}

/** Fields whose value changed between two snapshots. */
export function changedStructureFields(
    oldSnap: StructureSnapshot,
    newSnap: StructureSnapshot
): StructureField[] {
    return (Object.keys(newSnap) as StructureField[]).filter(
        (field) => oldSnap[field] !== newSnap[field]
    );
}

/** Fields meaningful for a given channel kind (categories have no topic etc.). */
export function fieldsForKind(
    fields: StructureField[],
    kind: StructureKind
): StructureField[] {
    if (kind === 'text') return fields;
    return fields.filter((f) => f === 'name' || f === 'parentId');
}

/** Echo key reserved/consumed for a mirrored channel create. */
export function structureCreateKey(
    platform: StructurePlatform,
    name: string,
    kind: StructureKind
): string {
    return `${platform}:channel:create:${normalizeChannelName(name)}:${kind}`;
}

/** Echo key reserved/consumed for a mirrored channel delete. */
export function structureDeleteKey(
    platform: StructurePlatform,
    channelId: string
): string {
    return `${platform}:channel:delete:${channelId}`;
}

/**
 * Echo key reserved/consumed for a mirrored channel update. `value` must be
 * the value the eventing platform reports after the mirror (its own
 * coordinates), so reserving and consuming line up on both sides.
 */
export function structureUpdateKey(
    platform: StructurePlatform,
    channelId: string,
    field: StructureField,
    value: StructureSnapshot[StructureField]
): string {
    return `${platform}:channel:update:${channelId}:${field}:${JSON.stringify(value)}`;
}
