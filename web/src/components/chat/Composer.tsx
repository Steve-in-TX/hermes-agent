/**
 * Phone composer: multi-line textarea, Send, Stop while a turn runs. Enter
 * inserts a newline on touch keyboards (send is the button); on a hardware
 * keyboard Ctrl/Cmd+Enter sends. Never submits while the IME is composing.
 */
import { useEffect, useRef, useState } from "react";
import { ImagePlus, Mic, SendHorizontal, Square, X } from "lucide-react";

import { Button } from "@nous-research/ui/ui/components/button";

import { SlashPopover, type SlashPopoverHandle } from "@/components/SlashPopover";
import type { GatewayClient } from "@/lib/gatewayClient";

export interface ComposerProps {
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  onSend: (text: string) => Promise<void> | void;
  onStop: () => Promise<void> | void;
  /** Speech-to-text; omitted when the platform has none. Resolves null when cancelled. */
  onDictate?: () => Promise<string | null>;
  /** Text handed in from outside (share target); a new nonce replaces the draft. */
  prefill?: { text: string; nonce: number } | null;
  /** Live gateway for slash completion; the popover shows while the draft starts with "/". */
  gateway?: Pick<GatewayClient, "request"> | null;
  /** A draft starting with "/" is a slash command; omitted → sent as text. */
  onSlash?: (command: string) => Promise<void> | void;
  /** Stage an image (base64 without the data: prefix) for the next message. */
  onAttach?: (base64: string, filename: string) => Promise<void> | void;
}

interface Attachment {
  name: string;
  size: number;
}

export function Composer({ busy, disabled = false, placeholder, onSend, onStop, onDictate, prefill, gateway, onSlash, onAttach }: ComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const slashRef = useRef<SlashPopoverHandle | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const isSlash = text.startsWith("/");

  const attach = async (file: File) => {
    if (!onAttach) return;
    setAttaching(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("read failed"));
        reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
        reader.readAsDataURL(file);
      });
      await onAttach(base64, file.name || "image.jpg");
      setAttachments((prev) => [...prev, { name: file.name || "image", size: file.size }]);
    } finally {
      setAttaching(false);
    }
  };

  useEffect(() => {
    if (prefill && prefill.text) setText(prefill.text);
  }, [prefill]);

  const dictate = async () => {
    if (!onDictate || listening) return;
    setListening(true);
    try {
      const heard = await onDictate();
      if (heard) setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${heard}` : heard));
    } finally {
      setListening(false);
    }
  };

  // Grow with content, capped.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending || disabled) return;
    setSending(true);
    try {
      if (value.startsWith("/") && onSlash) await onSlash(value);
      else await onSend(value);
      setText("");
      setAttachments([]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="relative border-t border-border bg-background px-2 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))]">
      {isSlash && gateway && (
        <SlashPopover
          ref={slashRef}
          input={text}
          gw={gateway}
          onApply={(next) => {
            setText(next);
            ref.current?.focus();
          }}
        />
      )}
      {attachments.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 pb-2">
          {attachments.map((a, i) => (
            <span key={`${a.name}-${i}`} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs">
              <ImagePlus className="size-3" />
              {a.name}
            </span>
          ))}
          <button type="button" className="p-1 opacity-60" onClick={() => setAttachments([])} aria-label="Clear attachment list">
            <X className="size-3" />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
      {onAttach && !busy && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void attach(file);
            }}
          />
          <Button
            type="button"
            ghost
            size="icon"
            className="min-h-12 min-w-12"
            aria-label="Attach image"
            disabled={disabled || attaching}
            onClick={() => fileRef.current?.click()}
          >
            <ImagePlus className="size-5" />
          </Button>
        </>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={placeholder ?? (busy ? "Send a follow-up…" : "Message the agent")}
        disabled={disabled}
        enterKeyHint="enter"
        autoCapitalize="sentences"
        className="min-h-12 max-h-40 flex-1 resize-none rounded-2xl border border-border bg-transparent px-3 py-3 text-base leading-5 outline-none"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (isSlash && slashRef.current?.handleKey(e)) return;
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {onDictate && !busy && (
        <Button
          type="button"
          ghost
          size="icon"
          className="min-h-12 min-w-12"
          aria-label="Dictate"
          disabled={disabled || listening}
          onClick={() => void dictate()}
        >
          <Mic className="size-5" />
        </Button>
      )}
      {busy ? (
        <Button
          type="button"
          outlined
          className="min-h-12 min-w-12"
          aria-label="Stop"
          onClick={() => void onStop()}
          prefix={<Square className="size-4" />}
        >
          Stop
        </Button>
      ) : (
        <Button
          type="button"
          className="min-h-12 min-w-12"
          aria-label="Send"
          disabled={disabled || sending || !text.trim()}
          onClick={() => void send()}
          prefix={<SendHorizontal className="size-4" />}
        >
          Send
        </Button>
      )}
      </div>
    </div>
  );
}
