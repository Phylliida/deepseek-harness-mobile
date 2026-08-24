/**
 * Coding-time tracker plugin, node half.
 *
 * Deliberately empty. The timer is a personal browser-side wellbeing
 * surface: its state lives in the client store's localStorage persistence,
 * never in the session log, and no model-facing tool reads it.
 */

/** Host plugin body — the timer has no host-side behavior. */
export function apply(): void {}
