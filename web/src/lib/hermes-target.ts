/**
 * Build target of this bundle. ``__HERMES_TARGET__`` is injected by vite
 * ``define`` (``HERMES_TARGET=mobile`` → ``"mobile"``, else ``"browser"``)
 * and is absent under vitest, hence the ``typeof`` guard.
 *
 * The mobile build trims navigation to what the phone can do, never mounts
 * the xterm chat page, and disables the same-origin plugin slot system.
 */
let override: boolean | null = null;

export function isMobileTarget(): boolean {
  if (override !== null) return override;
  return typeof __HERMES_TARGET__ !== "undefined" && __HERMES_TARGET__ === "mobile";
}

/** Test hook: force the target, or ``null`` to read the build constant again. */
export function setMobileTargetForTests(value: boolean | null): void {
  override = value;
}
