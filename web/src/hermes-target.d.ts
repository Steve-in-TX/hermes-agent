/**
 * Build-time constant injected by vite ``define`` (see ``vite.config.ts``).
 * Absent under vitest — read it only through ``isMobileTarget()``, which
 * guards with ``typeof``.
 */
declare const __HERMES_TARGET__: "browser" | "mobile";
