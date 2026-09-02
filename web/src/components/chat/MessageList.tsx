/**
 * Transcript for the structured chat: user bubbles, assistant markdown,
 * collapsed reasoning, and tool cards. Follows the bottom while the user is
 * pinned there (30 Hz deltas) and stops following once they scroll up.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";

import { Spinner } from "@nous-research/ui/ui/components/spinner";

import { Markdown } from "@/components/Markdown";
import type { ChatMessage, MessagePart, ToolPart } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

const PIN_TOLERANCE_PX = 48;

function ToolCard({ part }: { part: ToolPart }) {
  const [open, setOpen] = useState(false);
  const running = part.status === "running";
  const argsText =
    part.context ||
    (part.args !== undefined ? safeJson(part.args) : "");
  return (
    <div
      className={cn(
        "rounded border text-xs",
        part.isError ? "border-red-500/40" : "border-border",
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-2 text-left min-h-11"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <Wrench className="size-3.5 shrink-0 opacity-70" />
        <span className="font-mono font-medium">{part.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono opacity-70">{argsText}</span>
        {running ? (
          <Spinner aria-label="running" role="status" />
        ) : (
          <span className={cn("shrink-0", part.isError ? "text-red-500" : "opacity-60")}>
            {part.isError ? "error" : "done"}
            {typeof part.durationS === "number" ? ` · ${part.durationS.toFixed(1)}s` : ""}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-border px-2 py-2 space-y-2">
          {part.args !== undefined && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono opacity-80">{safeJson(part.args)}</pre>
          )}
          {part.status === "complete" && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono">
              {part.resultText || "(no output)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs opacity-70">
      <button type="button" className="flex items-center gap-1 min-h-9" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        Reasoning
      </button>
      {open && <div className="whitespace-pre-wrap border-l pl-2">{text}</div>}
    </div>
  );
}

function Part({ part, streaming }: { part: MessagePart; streaming: boolean }) {
  switch (part.type) {
    case "text":
      return <Markdown content={part.text} streaming={streaming} />;
    case "reasoning":
      return <ReasoningBlock text={part.text} />;
    case "tool":
      return <ToolCard part={part} />;
  }
}

function MessageRow({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-foreground/10 px-3 py-2 text-sm">
          {message.parts.map((p, i) => (p.type === "text" ? <span key={i}>{p.text}</span> : null))}
        </div>
      </div>
    );
  }
  if (message.role === "system") {
    return (
      <div className="text-center text-xs opacity-60 whitespace-pre-wrap break-words px-4">
        {message.parts.map((p, i) => (p.type === "text" ? <span key={i}>{p.text}</span> : null))}
      </div>
    );
  }
  const lastIndex = message.parts.length - 1;
  return (
    <div className="flex flex-col gap-2 max-w-full">
      {message.parts.map((part, i) => (
        <Part key={i} part={part} streaming={!!message.pending && i === lastIndex && part.type === "text"} />
      ))}
      {message.pending && message.parts.length === 0 && (
        <span className="text-xs opacity-60">
          <Spinner aria-label="waiting" role="status" />
        </span>
      )}
      {message.status === "interrupted" && <div className="text-xs opacity-60">Interrupted.</div>}
      {message.error && <div className="text-xs text-red-500">{message.error}</div>}
    </div>
  );
}

export interface MessageListProps {
  messages: ChatMessage[];
  thinking: string | null;
  statusLine: string | null;
  busy: boolean;
  className?: string;
}

export function MessageList({ messages, thinking, statusLine, busy, className }: MessageListProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const handleScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.clientHeight - el.scrollTop <= PIN_TOLERANCE_PX;
  };

  // Follow new content only while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, thinking, statusLine, busy]);

  // A new session always starts pinned.
  const firstId = messages[0]?.id;
  useEffect(() => {
    pinnedRef.current = true;
  }, [firstId]);

  return (
    <div
      ref={scrollerRef}
      onScroll={handleScroll}
      className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-3 flex flex-col gap-4", className)}
      role="log"
      aria-live="polite"
    >
      {messages.length === 0 && !busy && (
        <div className="m-auto text-center text-sm opacity-60 px-6">
          Start a conversation. The agent runs on the gateway; approvals and questions show up here.
        </div>
      )}
      {messages.map((m) => (
        <MessageRow key={m.id} message={m} />
      ))}
      {(thinking || statusLine) && (
        <div className="text-xs opacity-60 flex items-center gap-2">
          <Spinner aria-label="working" role="status" />
          <span className="truncate">{statusLine ?? thinking}</span>
        </div>
      )}
    </div>
  );
}
