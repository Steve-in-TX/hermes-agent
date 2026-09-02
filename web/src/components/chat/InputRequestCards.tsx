/**
 * Approval and clarify cards for the phone.
 *
 * Approval: the gateway's `choices` are rendered verbatim (never a hardcoded
 * four). Deny sits in the thumb-reachable position (last, right), buttons are
 * ≥48dp, and "Always allow" needs a second tap — it writes the gateway's
 * config permanently, so a mis-tap here is a security incident.
 *
 * Clarify: single question with choices (tap = answer), multi-select
 * (toggle + confirm), free text, or a batch of questions answered in order.
 * "Skip" sends an empty answer, which the tool reports as skipped.
 */
import { useEffect, useState } from "react";

import { Button } from "@nous-research/ui/ui/components/button";

import type { ApprovalChoice, ApprovalRequest, ClarifyRequest } from "@hermes/shared";
import { bareChoice } from "@hermes/shared";

import { cn } from "@/lib/utils";

const APPROVAL_LABEL: Record<ApprovalChoice, string> = {
  once: "Run once",
  session: "Allow session",
  always: "Always allow",
  deny: "Deny",
};

export interface ApprovalCardProps {
  request: ApprovalRequest;
  onRespond: (choice: ApprovalChoice) => Promise<void> | void;
}

export function ApprovalCard({ request, onRespond }: ApprovalCardProps) {
  const [busy, setBusy] = useState(false);
  const [confirmAlways, setConfirmAlways] = useState(false);
  useEffect(() => {
    setBusy(false);
    setConfirmAlways(false);
  }, [request.requestId]);

  const send = async (choice: ApprovalChoice) => {
    if (busy) return;
    setBusy(true);
    try {
      await onRespond(choice);
    } finally {
      setBusy(false);
    }
  };

  // Deny last so it lands under the thumb on a right-handed grip.
  const ordered = [...request.choices.filter((c) => c !== "deny"), ...(request.choices.includes("deny") ? ["deny" as const] : [])];

  return (
    <div role="group" aria-label="Approval required" className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 flex flex-col gap-3">
      <div className="text-sm font-medium">
        Approval required · <span className="opacity-80">{request.description}</span>
      </div>
      {request.command && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-foreground/5 p-2 font-mono text-xs">
          {request.command}
        </pre>
      )}
      {request.smartDenied && (
        <div className="text-xs opacity-70">The safety check declined this automatically; run it only if you are sure.</div>
      )}
      {confirmAlways ? (
        <div className="flex flex-col gap-2">
          <div className="text-xs">
            Always allow writes this pattern into the gateway's config and never asks again. Confirm?
          </div>
          <div className="flex gap-2">
            <Button outlined className="min-h-12 flex-1" disabled={busy} onClick={() => setConfirmAlways(false)}>
              Back
            </Button>
            <Button destructive className="min-h-12 flex-1" disabled={busy} onClick={() => void send("always")}>
              Yes, always allow
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {ordered.map((choice) => (
            <Button
              key={choice}
              outlined={choice !== "once"}
              destructive={choice === "deny"}
              className={cn("min-h-12 whitespace-normal leading-tight", ordered.length % 2 === 1 && choice === ordered[0] && "col-span-2")}
              disabled={busy}
              onClick={() => (choice === "always" ? setConfirmAlways(true) : void send(choice))}
            >
              {APPROVAL_LABEL[choice]}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface ClarifyCardProps {
  request: ClarifyRequest;
  onAnswer: (answer: string) => Promise<void> | void;
  onAnswerBatch: (answers: Array<{ qid: string; answer: string }>) => Promise<void> | void;
}

function SingleQuestion({
  question,
  choices,
  multiSelect,
  busy,
  onAnswer,
  skipLabel = "Skip",
}: {
  question: string;
  choices: string[] | null;
  multiSelect: boolean;
  busy: boolean;
  onAnswer: (answer: string) => void;
  skipLabel?: string;
}) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    setText("");
    setPicked(new Set());
  }, [question]);

  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium whitespace-pre-wrap">{question}</div>
      {choices && !multiSelect && (
        <div className="flex flex-col gap-2">
          {choices.map((choice) => (
            <Button key={choice} outlined className="min-h-12 justify-start text-left whitespace-normal" disabled={busy} onClick={() => onAnswer(bareChoice(choice))}>
              {choice}
            </Button>
          ))}
        </div>
      )}
      {choices && multiSelect && (
        <div className="flex flex-col gap-2">
          {choices.map((choice) => {
            const bare = bareChoice(choice);
            const on = picked.has(bare);
            return (
              <Button
                key={choice}
                outlined={!on}
                className="min-h-12 justify-start text-left whitespace-normal"
                aria-pressed={on}
                disabled={busy}
                onClick={() =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (next.has(bare)) next.delete(bare);
                    else next.add(bare);
                    return next;
                  })
                }
              >
                {choice}
              </Button>
            );
          })}
          <Button className="min-h-12" disabled={busy || picked.size === 0} onClick={() => onAnswer(JSON.stringify([...picked]))}>
            Confirm selection
          </Button>
        </div>
      )}
      <div className="flex gap-2">
        <input
          className="min-h-12 flex-1 rounded border border-border bg-transparent px-3 text-sm"
          placeholder={choices ? "Or type an answer" : "Type an answer"}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && text.trim()) onAnswer(text.trim());
          }}
        />
        <Button className="min-h-12" disabled={busy || !text.trim()} onClick={() => onAnswer(text.trim())}>
          Send
        </Button>
        <Button ghost className="min-h-12" disabled={busy} onClick={() => onAnswer("")}>
          {skipLabel}
        </Button>
      </div>
    </div>
  );
}

export function ClarifyCard({ request, onAnswer, onAnswerBatch }: ClarifyCardProps) {
  const [busy, setBusy] = useState(false);
  const [batchAnswers, setBatchAnswers] = useState<Record<string, string>>({});
  useEffect(() => {
    setBusy(false);
    setBatchAnswers(request.lockedAnswers ?? {});
  }, [request.requestId, request.lockedAnswers]);

  const run = async (fn: () => Promise<void> | void) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const questions = request.questions;
  if (questions && questions.length) {
    const next = questions.find((q) => !(q.qid in batchAnswers));
    const answered = questions.length - (next ? questions.filter((q) => !(q.qid in batchAnswers)).length : 0);
    return (
      <div role="group" aria-label="Question from the agent" className="rounded-lg border border-border p-3 flex flex-col gap-3">
        <div className="text-xs opacity-60">
          Question {Math.min(answered + 1, questions.length)} of {questions.length}
        </div>
        {next ? (
          <SingleQuestion
            key={next.qid}
            question={next.question}
            choices={next.choices}
            multiSelect={next.multiSelect}
            busy={busy}
            onAnswer={(answer) => {
              const all = { ...batchAnswers, [next.qid]: answer };
              setBatchAnswers(all);
              const remaining = questions.filter((q) => !(q.qid in all));
              if (remaining.length === 0) {
                void run(() =>
                  onAnswerBatch(
                    questions
                      .filter((q) => !(request.lockedAnswers && q.qid in request.lockedAnswers))
                      .map((q) => ({ qid: q.qid, answer: all[q.qid] ?? "" })),
                  ),
                );
              }
            }}
            skipLabel="Skip this one"
          />
        ) : (
          <div className="text-sm">Sending answers…</div>
        )}
      </div>
    );
  }

  return (
    <div role="group" aria-label="Question from the agent" className="rounded-lg border border-border p-3">
      <SingleQuestion
        question={request.question}
        choices={request.choices}
        multiSelect={request.multiSelect}
        busy={busy}
        onAnswer={(answer) => void run(() => onAnswer(answer))}
      />
    </div>
  );
}
