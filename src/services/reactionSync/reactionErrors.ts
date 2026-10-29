/**
 * Discord numeric error codes for "the target state is already gone or
 * unreachable" (message deleted, emoji removed, ...).
 */
const DISCORD_TOLERABLE_CODES = new Set<number>([
    10001, // Unknown Guild
    10003, // Unknown Channel
    10008, // Unknown Message
    10014, // Unknown Emoji
    50001, // Missing Access
    50013, // Missing Permissions
]);

/** Fluxer string error codes for the same conditions. */
const FLUXER_TOLERABLE_CODES = new Set<string>([
    'GUILD_NOT_FOUND',
    'CHANNEL_NOT_FOUND',
    'MESSAGE_NOT_FOUND',
    'EMOJI_NOT_FOUND',
    'REACTION_NOT_FOUND',
]);

/**
 * Whether a reaction API failure just means the target state changed under us
 * (already-removed reaction, deleted message, gone emoji). Those are expected
 * during bursts and must never abort the rest of a reconcile plan.
 */
export function isTolerableReactionError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;

    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') return DISCORD_TOLERABLE_CODES.has(code);
    if (typeof code === 'string') return FLUXER_TOLERABLE_CODES.has(code);

    const status = (error as { status?: unknown }).status;
    return status === 404;
}
