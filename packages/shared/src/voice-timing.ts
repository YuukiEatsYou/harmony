/**
 * The timing contract around a dropped voice call. Both sides recover a call on
 * their own schedule, and the numbers only work together: the client leaves and
 * rejoins a call it believes is dead, and the server must not reap the member
 * first, or a call that was about to heal gets torn down (the "stuck on
 * Connecting" outage). They live here, in one place, so the relationship is
 * visible rather than spread across three files that each made sense alone.
 *
 * The ordering that has to hold:
 *   - a failed media connection is rebuilt by the client at once, so its rejoin
 *     cancels the server's failed-reap long before it fires;
 *   - a disconnected one gets the client's recovery grace plus every retry,
 *     which must stay under the server's disconnected-reap
 *     (grace + (attempts - 1) * delay = 14s, against a 20s reap);
 *   - a gateway drop is awaited for the offline grace, long enough for a phone
 *     changing networks to come back and ask for an ICE restart.
 *
 * Changing one of these means re-checking the others.
 */

/** Client: how long a `disconnected` connection is left before it is treated as lost. */
export const VOICE_RECOVER_GRACE_MS = 4_000;
/** Client: how long to wait between recovery attempts. */
export const VOICE_RECOVER_DELAY_MS = 2_500;
/** Client: how many recovery attempts before it gives up and says so. */
export const VOICE_MAX_RECOVER_ATTEMPTS = 5;

/** Server: how long a member keeps their seat after their last gateway socket drops. */
export const VOICE_OFFLINE_GRACE_MS = 10_000;
/** Server: how long a `failed` media connection is left before it is reaped. */
export const VOICE_REAP_FAILED_MS = 8_000;
/** Server: how long a `disconnected` media connection is left before it is reaped. */
export const VOICE_REAP_DISCONNECTED_MS = 20_000;
