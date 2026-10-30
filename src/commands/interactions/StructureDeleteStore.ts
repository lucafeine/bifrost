import crypto from 'crypto';

export interface PendingStructureDelete {
    platform: 'discord' | 'fluxer';
    guildLinkId: string;
    sourceChannelId: string;
    twinChannelId: string;
    structureLinkId: string;
    channelName: string;
    expiresAt: number;
}

const store = new Map<string, PendingStructureDelete>();

export function createPendingStructureDelete(
    info: Omit<PendingStructureDelete, 'expiresAt'>
): string {
    const token = crypto.randomBytes(12).toString('hex');
    store.set(token, { ...info, expiresAt: Date.now() + 10 * 60 * 1000 });
    return token;
}

export function getPendingStructureDelete(
    token: string
): PendingStructureDelete | null {
    const entry = store.get(token);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
        store.delete(token);
        return null;
    }
    return entry;
}

export function deletePendingStructureDelete(token: string): void {
    store.delete(token);
}
