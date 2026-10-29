/**
 * Number of real-user reactions behind an aggregate. The bridge bot's own
 * reaction is never part of the source set: ignoring it is what prevents
 * duplicate mirrors and makes removals converge.
 */
export function countUserReactions(count: number, me: boolean): number {
    return Math.max(0, count - (me ? 1 : 0));
}
