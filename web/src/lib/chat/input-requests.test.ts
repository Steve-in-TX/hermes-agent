/**
 * Contract tests for the shared input-request parser against every variant
 * `_approval_request_payload` (tui_gateway/server.py) and `_clarify_block`
 * can produce, plus the derivation used when an older gateway omits
 * `choices`.
 */
import { describe, expect, it } from "vitest";

import {
  approvalChoicesFromPayload,
  bareChoice,
  normalizeChoices,
  normalizeQuestions,
  parseInputRequest,
  readClarifyResult,
} from "@hermes/shared";

describe("approvalChoicesFromPayload", () => {
  it.each([
    ["default", { allow_permanent: true, allow_session: true }, ["once", "session", "always", "deny"]],
    ["smart_denied", { smart_denied: true, allow_permanent: true, allow_session: true }, ["once", "deny"]],
    ["allow_session:false", { allow_permanent: true, allow_session: false }, ["once", "deny"]],
    ["allow_permanent:false (tirith)", { allow_permanent: false, allow_session: true }, ["once", "session", "deny"]],
    ["explicit choices win", { allow_permanent: true, choices: ["once", "deny"] }, ["once", "deny"]],
    ["unknown strings dropped", { choices: ["once", "maybe", "deny"] }, ["once", "deny"]],
    ["empty explicit falls back to derivation", { choices: [], allow_session: true, allow_permanent: false }, ["once", "session", "deny"]],
  ])("%s", (_label, payload, expected) => {
    expect(approvalChoicesFromPayload(payload)).toEqual(expected);
  });
});

describe("parseInputRequest", () => {
  it("normalises the live approval payload", () => {
    const req = parseInputRequest(
      "approval.request",
      {
        command: "rm -rf /tmp/hermes-m3-approval-test",
        pattern_key: "delete in root path",
        pattern_keys: ["delete in root path"],
        description: "delete in root path",
        allow_permanent: true,
        allow_session: true,
        request_id: "b6ab9187",
        choices: ["once", "session", "always", "deny"],
      },
      "sid",
    );
    expect(req).toEqual({
      kind: "approval",
      sessionId: "sid",
      requestId: "b6ab9187",
      command: "rm -rf /tmp/hermes-m3-approval-test",
      description: "delete in root path",
      choices: ["once", "session", "always", "deny"],
      smartDenied: false,
      patternKeys: ["delete in root path"],
    });
  });

  it("defaults the description and ignores an approval without a request id", () => {
    expect(parseInputRequest("approval.request", { command: "x", request_id: "r" }, "s")).toMatchObject({ description: "dangerous command" });
    expect(parseInputRequest("approval.request", { command: "x" }, "s")).toBeNull();
  });

  it("parses a single clarify with choices", () => {
    const req = parseInputRequest("clarify.request", { question: "Proceed?", choices: ["Yes (Recommended)", "No"], request_id: "c1" }, "s", 2_000_000);
    expect(req).toMatchObject({ kind: "clarify", question: "Proceed?", choices: ["Yes (Recommended)", "No"], multiSelect: false, receivedAt: 2000 });
  });

  it("parses free-text and multi-select clarifies", () => {
    expect(parseInputRequest("clarify.request", { question: "Name?", choices: null, request_id: "c" }, "s")).toMatchObject({ choices: null });
    expect(parseInputRequest("clarify.request", { question: "Pick", choices: ["a", "b"], multi_select: true, request_id: "c" }, "s")).toMatchObject({ multiSelect: true });
  });

  it("parses a batch clarify with locked answers from a replay", () => {
    const req = parseInputRequest(
      "clarify.request",
      {
        request_id: "b",
        questions: [
          { qid: "q0", question: "One?", choices: ["x", "y"], multi_select: false },
          { qid: "q1", question: "Two?", choices: null, multi_select: false },
          { question: "no qid — dropped" },
        ],
        answers: { q0: "x", q9: 5 },
      },
      "s",
    );
    expect(req).toMatchObject({
      kind: "clarify",
      questions: [
        { qid: "q0", question: "One?", choices: ["x", "y"], multiSelect: false },
        { qid: "q1", question: "Two?", choices: null, multiSelect: false },
      ],
      lockedAnswers: { q0: "x" },
    });
  });

  it("parses sudo, secret, and expiries", () => {
    expect(parseInputRequest("sudo.request", { request_id: "su" }, "s")).toEqual({ kind: "sudo", sessionId: "s", requestId: "su" });
    expect(parseInputRequest("secret.request", { request_id: "se", env_var: "K", prompt: "P" }, "s")).toEqual({
      kind: "secret",
      sessionId: "s",
      requestId: "se",
      envVar: "K",
      prompt: "P",
    });
    expect(parseInputRequest("clarify.expire", { request_id: "c" }, "s")).toEqual({ kind: "expire", of: "clarify", sessionId: "s", requestId: "c" });
    expect(parseInputRequest("secret.expire", { request_id: "x" }, "s")).toMatchObject({ of: "secret" });
  });

  it("returns null for unrelated events", () => {
    expect(parseInputRequest("message.delta", { text: "x" }, "s")).toBeNull();
  });
});

describe("choice helpers", () => {
  it("strips the recommended suffix", () => {
    expect(bareChoice("Yes (Recommended)")).toBe("Yes");
    expect(bareChoice("  No ")).toBe("No");
  });

  it("drops blank, multi-line, and over-long choices", () => {
    expect(normalizeChoices(["ok", "  ", "two\nlines", "x".repeat(201), 5, `${"y".repeat(200)} (Recommended)`])).toEqual([
      "ok",
      `${"y".repeat(200)} (Recommended)`,
    ]);
    expect(normalizeChoices("nope")).toEqual([]);
  });

  it("normalises questions", () => {
    expect(normalizeQuestions([{ qid: "q0", question: "A", choices: ["1"] }, { qid: "q1", question: "B" }])).toEqual([
      { qid: "q0", question: "A", choices: ["1"], multiSelect: false },
      { qid: "q1", question: "B", choices: null, multiSelect: false },
    ]);
  });

  it("reads a settled clarify result", () => {
    expect(readClarifyResult({ question: "Proceed?", choices_offered: ["Yes", "No"], user_response: "Yes" })).toEqual({ question: "Proceed?", answer: "Yes" });
    expect(readClarifyResult({ output: "x" })).toBeNull();
  });
});
