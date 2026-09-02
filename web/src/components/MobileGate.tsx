/**
 * Android shell gate: until a gateway is connected, the connection screen is
 * the whole app. Sits above the dashboard shell and its providers so none of
 * their boot-time requests (config, profiles, status polling) fire against a
 * target that does not exist yet. A no-op in the browser dashboard.
 */
import { Suspense, lazy, type ReactNode } from "react";

import { isMobileTarget } from "@/lib/hermes-target";
import { useMobileConnection } from "@/lib/mobile-connection";

const ConnectionPage = lazy(() => import("@/pages/ConnectionPage"));

export function MobileGate({ children }: { children: ReactNode }) {
  const connection = useMobileConnection();
  if (!isMobileTarget() || connection) return <>{children}</>;
  return (
    <Suspense fallback={null}>
      <ConnectionPage standalone />
    </Suspense>
  );
}
