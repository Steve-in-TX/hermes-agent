/**
 * `session.history` / `session.resume` records → `ChatMessage[]`.
 *
 * The gateway's history is a display projection (`_history_to_messages`):
 * user/assistant/system rows carry `text`; tool calls are separate
 * `{role:"tool", name, context, args}` rows with no id and no result. A tool
 * row is folded into the preceding assistant bubble as a completed tool part
 * (that is where the live stream would have put it); a tool row with no
 * assistant before it gets its own assistant bubble.
 */
import type { ChatMessage, HistoryRecord, ToolPart } from "./types";

export function messagesFromHistory(sessionId: string, records: readonly HistoryRecord[]): {
  messages: ChatMessage[];
  nextId: number;
} {
  const messages: ChatMessage[] = [];
  let nextId = 1;
  const newId = (prefix: string) => `${sessionId}-h${prefix}${nextId++}`;

  for (const rec of records) {
    if (!rec || typeof rec !== "object") continue;
    if (rec.display_kind === "hidden") continue;
    const role = rec.role;

    if (role === "tool") {
      const name = typeof rec.name === "string" ? rec.name : "tool";
      const part: ToolPart = {
        type: "tool",
        toolId: `${name}-${nextId++}`,
        name,
        context: typeof rec.context === "string" ? rec.context : "",
        args: rec.args,
        status: "complete",
      };
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant") {
        messages[messages.length - 1] = { ...last, parts: [...last.parts, part] };
      } else {
        messages.push({ id: newId("t"), role: "assistant", parts: [part], timestamp: rec.timestamp });
      }
      continue;
    }

    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    const text = typeof rec.text === "string" ? rec.text : "";
    const reasoning = typeof rec.reasoning === "string" ? rec.reasoning : "";
    if (!text && !reasoning) continue;
    messages.push({
      id: newId(role[0]),
      role,
      parts: [
        ...(reasoning ? [{ type: "reasoning" as const, text: reasoning }] : []),
        ...(text ? [{ type: "text" as const, text }] : []),
      ],
      timestamp: rec.timestamp,
      rowId: rec.row_id,
      status: role === "assistant" ? "complete" : undefined,
    });
  }

  return { messages, nextId };
}
