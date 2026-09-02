/**
 * Structured chat over the JSON-RPC gateway (mobile build).
 *
 * One `ChatController` per app lifetime keeps the socket alive across route
 * changes; this page renders the active session, the composer, and whatever
 * the agent is waiting on (approval, question, sudo password, secret).
 *
 * `?resume=<stored id>` picks a session (the same URL contract
 * `ChatSessionList` already uses); with no param the last active session is
 * kept, and the first message creates a session lazily.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { List, Plus } from "lucide-react";

import { Badge } from "@nous-research/ui/ui/components/badge";
import { BottomSheet } from "@nous-research/ui/ui/components/bottom-sheet";
import { Button } from "@nous-research/ui/ui/components/button";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";

import { ChatSessionList } from "@/components/ChatSessionList";
import { Composer } from "@/components/chat/Composer";
import { ApprovalCard, ClarifyCard } from "@/components/chat/InputRequestCards";
import { MessageList } from "@/components/chat/MessageList";
import { SecretPrompts } from "@/components/chat/SecretPrompts";
import { usePageHeader } from "@/contexts/usePageHeader";
import { ChatController } from "@/lib/chat/controller";
import { useChatShell, useSessionChat } from "@/lib/chat/store";
import { GatewayClient } from "@/lib/gatewayClient";

let controller: ChatController | null = null;

/** App-lifetime controller; the socket survives navigating away and back. */
export function getChatController(): ChatController {
  if (!controller) {
    controller = new ChatController({ createClient: () => new GatewayClient() });
  }
  return controller;
}

const CONNECTION_TONE = {
  idle: "secondary",
  connecting: "warning",
  open: "success",
  closed: "warning",
  error: "destructive",
} as const;

export default function GatewayChatPage() {
  const ctl = useMemo(getChatController, []);
  const shell = useChatShell();
  const session = useSessionChat(shell.activeSessionId);
  const [searchParams, setSearchParams] = useSearchParams();
  const resumeParam = searchParams.get("resume");
  const { toast, showToast } = useToast();
  const { setTitle, setEnd } = usePageHeader();
  const [pickerOpen, setPickerOpen] = useState(false);
  const lastResumeRef = useRef<string | null>(null);

  // Connect once; reconnect immediately when the app returns to the foreground.
  useEffect(() => {
    void ctl.connect();
    const onVisible = () => {
      if (document.visibilityState === "visible") ctl.reconnectNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [ctl]);

  // ?resume=<id> → resume that session (once per value, once connected).
  useEffect(() => {
    if (!resumeParam || shell.connection !== "open") return;
    if (lastResumeRef.current === resumeParam) return;
    lastResumeRef.current = resumeParam;
    ctl.resumeSession(resumeParam).catch((err: unknown) => {
      showToast(err instanceof Error ? err.message : String(err), "error");
    });
  }, [ctl, resumeParam, shell.connection, showToast]);

  useEffect(() => {
    setTitle(session.title || (shell.activeSessionId ? "Chat" : "New chat"));
    return () => setTitle(null);
  }, [session.title, setTitle, shell.activeSessionId]);

  const startNew = useCallback(() => {
    setPickerOpen(false);
    lastResumeRef.current = null;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("resume");
        return next;
      },
      { replace: true },
    );
    ctl.createSession().catch((err: unknown) => showToast(err instanceof Error ? err.message : String(err), "error"));
  }, [ctl, setSearchParams, showToast]);

  useEffect(() => {
    setEnd(
      <div className="flex items-center gap-1">
        <Badge tone={CONNECTION_TONE[shell.connection]} className="text-xs">
          {shell.connection === "open" ? (session.model ?? "connected") : shell.connection}
        </Badge>
        <Button ghost size="icon" aria-label="Sessions" onClick={() => setPickerOpen(true)}>
          <List className="size-5" />
        </Button>
        <Button ghost size="icon" aria-label="New chat" onClick={startNew}>
          <Plus className="size-5" />
        </Button>
      </div>,
    );
    return () => setEnd(null);
  }, [setEnd, shell.connection, session.model, startNew]);

  const report = (err: unknown) => showToast(err instanceof Error ? err.message : String(err), "error");
  const sid = shell.activeSessionId;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toast toast={toast} />
      {shell.connection !== "open" && (
        <div className="px-2 py-1 text-xs text-center opacity-70">
          {shell.connection === "connecting" ? "Connecting to the gateway…" : `Disconnected — retrying (${shell.reconnectAttempt})`}
          {shell.error ? ` · ${shell.error}` : ""}
        </div>
      )}
      {session.reclaimed && (
        <div className="px-2 py-1 text-xs text-center text-amber-600 dark:text-amber-400">
          The gateway closed this session while the app was away; your next message resumes it.
        </div>
      )}
      {session.lastError && !session.busy && (
        <div role="alert" className="px-2 py-1 text-xs text-center text-red-600 dark:text-red-400">
          {session.lastError}
        </div>
      )}

      <MessageList messages={session.messages} thinking={session.thinking} statusLine={session.statusLine} busy={session.busy} />

      {sid && session.approval && (
        <div className="px-2 pb-2">
          <ApprovalCard
            request={session.approval}
            onRespond={(choice) => ctl.respondApproval(sid, session.approval!.requestId, choice).catch(report)}
          />
        </div>
      )}
      {sid && session.clarify && (
        <div className="px-2 pb-2">
          <ClarifyCard
            request={session.clarify}
            onAnswer={(answer) => ctl.respondClarify(sid, session.clarify!.requestId, answer).catch(report)}
            onAnswerBatch={(answers) => ctl.respondClarifyBatch(sid, session.clarify!.requestId, answers).catch(report)}
          />
        </div>
      )}

      <Composer
        busy={session.busy}
        disabled={shell.connection !== "open"}
        onSend={(text) => ctl.submit(text).catch(report)}
        onStop={() => ctl.interrupt().catch(report)}
      />

      {sid && (
        <SecretPrompts
          sudo={session.sudo}
          secret={session.secret}
          onSudo={(requestId, password) => ctl.respondSudo(sid, requestId, password).catch(report)}
          onSecret={(requestId, value) => ctl.respondSecret(sid, requestId, value).catch(report)}
        />
      )}

      <BottomSheet open={pickerOpen} onClose={() => setPickerOpen(false)} title="Sessions" backdropDismissLabel="Close">
        <div className="p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))]">
          <ChatSessionList activeSessionId={session.storedSessionId} onPicked={() => setPickerOpen(false)} onNewChat={startNew} />
        </div>
      </BottomSheet>
    </div>
  );
}
