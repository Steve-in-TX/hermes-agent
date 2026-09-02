import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "./index.css";
import App from "./App";
import { MobileGate } from "./components/MobileGate";
import { SystemActionsProvider } from "./contexts/SystemActions";
import { I18nProvider } from "./i18n";
import { exposePluginSDK } from "./plugins";
import { ThemeProvider } from "./themes";
import { HERMES_BASE_PATH } from "./lib/api";
import { isMobileTarget } from "./lib/hermes-target";
import { bootstrapMobileConnection } from "./lib/mobile-connection";
import { installNativeAuthIfAvailable } from "./lib/native-auth-capacitor";
import { installNativeShellIfAvailable } from "./lib/native-shell-capacitor";
import { installNativeTransportIfAvailable } from "./lib/transport";

async function boot(): Promise<void> {
  if (isMobileTarget()) {
    // Android shell: swap fetch/WebSocket for the native OkHttp plugins and
    // restore the saved gateway connection before anything can request.
    await installNativeTransportIfAvailable();
    await installNativeAuthIfAvailable();
    await installNativeShellIfAvailable();
    await bootstrapMobileConnection();
  }

  // Expose the plugin SDK before rendering so plugins loaded via <script>
  // can access React, components, etc. immediately.
  exposePluginSDK();

  createRoot(document.getElementById("root")!).render(
    <BrowserRouter basename={HERMES_BASE_PATH || undefined}>
      <I18nProvider>
        <ThemeProvider>
          <MobileGate>
            <SystemActionsProvider>
              <App />
            </SystemActionsProvider>
          </MobileGate>
        </ThemeProvider>
      </I18nProvider>
    </BrowserRouter>,
  );
}

void boot();
