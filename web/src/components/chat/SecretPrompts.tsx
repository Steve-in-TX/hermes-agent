/**
 * Sudo password and secret prompts as bottom sheets.
 *
 * Close-is-refusal: every way of dismissing the sheet (backdrop, close
 * control, Cancel) sends an EMPTY answer, so silence is never mistaken for
 * consent — the backend treats an empty sudo password as a failed sudo and
 * runs nothing. The `submitting` guard stops a submit and the resulting
 * unmount from double-sending, and the typed value resets per request id so
 * a second prompt never inherits the first one's secret.
 */
import { useEffect, useState } from "react";

import { BottomSheet } from "@nous-research/ui/ui/components/bottom-sheet";
import { Button } from "@nous-research/ui/ui/components/button";

import type { SecretRequest, SudoRequest } from "@hermes/shared";

interface PromptSheetProps {
  requestId: string | null;
  title: string;
  description: string;
  label: string;
  onSubmit: (value: string) => Promise<void> | void;
}

function PromptSheet({ requestId, title, description, label, onSubmit }: PromptSheetProps) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    setValue("");
    setSubmitting(false);
  }, [requestId]);

  const send = async (answer: string) => {
    if (submitting || !requestId) return;
    setSubmitting(true);
    try {
      await onSubmit(answer);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <BottomSheet open={requestId !== null} onClose={() => void send("")} title={title} backdropDismissLabel="Cancel">
      <form
        className="flex flex-col gap-3 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]"
        onSubmit={(e) => {
          e.preventDefault();
          void send(value);
        }}
      >
        <div className="text-sm opacity-80">{description}</div>
        <label className="flex flex-col gap-1 text-sm">
          <span>{label}</span>
          <input
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="min-h-12 rounded border border-border bg-transparent px-3"
            value={value}
            disabled={submitting}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <div className="flex gap-2">
          <Button type="button" outlined className="min-h-12 flex-1" disabled={submitting} onClick={() => void send("")}>
            Cancel
          </Button>
          <Button type="submit" className="min-h-12 flex-1" disabled={submitting || !value}>
            Submit
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}

export interface SecretPromptsProps {
  sudo: SudoRequest | null;
  secret: SecretRequest | null;
  onSudo: (requestId: string, password: string) => Promise<void> | void;
  onSecret: (requestId: string, value: string) => Promise<void> | void;
}

export function SecretPrompts({ sudo, secret, onSudo, onSecret }: SecretPromptsProps) {
  return (
    <>
      <PromptSheet
        requestId={sudo?.requestId ?? null}
        title="Sudo password"
        description="The agent needs your password to run a command with sudo. Cancel runs nothing."
        label="Password"
        onSubmit={(password) => (sudo ? onSudo(sudo.requestId, password) : undefined)}
      />
      <PromptSheet
        requestId={secret?.requestId ?? null}
        title={secret?.envVar ? `Secret: ${secret.envVar}` : "Secret required"}
        description={secret?.prompt || "The agent needs a secret value. Cancel provides nothing."}
        label="Value"
        onSubmit={(value) => (secret ? onSecret(secret.requestId, value) : undefined)}
      />
    </>
  );
}
