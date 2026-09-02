/**
 * Phone composer: multi-line textarea, Send, Stop while a turn runs. Enter
 * inserts a newline on touch keyboards (send is the button); on a hardware
 * keyboard Ctrl/Cmd+Enter sends. Never submits while the IME is composing.
 */
import { useEffect, useRef, useState } from "react";
import { Mic, SendHorizontal, Square } from "lucide-react";

import { Button } from "@nous-research/ui/ui/components/button";

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
}

export function Composer({ busy, disabled = false, placeholder, onSend, onStop, onDictate, prefill }: ComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

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
      await onSend(value);
      setText("");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex items-end gap-2 border-t border-border bg-background px-2 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))]">
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
  );
}
