import { desc, eq } from "drizzle-orm";
import {
  MAX_AGENT_SELECTED_REFERENCES,
  type AgentConversation,
  type AgentConversationContextSnapshot,
  type AgentConversationMessage,
  type AgentConversationMessageRole,
  type AgentConversationSummary,
  type AgentTraceDirection,
  type AgentTraceEntry,
  type AgentTracePhase,
  type GenerationPlan
} from "../contracts.js";
import { db } from "../../infrastructure/database.js";
import { agentConversations } from "../../infrastructure/schema.js";

const AGENT_CONVERSATION_HISTORY_LIMIT = 20;
const AGENT_CONVERSATION_QUERY_LIMIT = 50;
const MAX_AGENT_CONVERSATION_MESSAGES = 200;
const MAX_AGENT_CONVERSATION_TITLE_LENGTH = 120;
const MAX_AGENT_CONVERSATION_PREVIEW_LENGTH = 160;
const MAX_AGENT_TRACE_ENTRIES = 1000;
const MAX_AGENT_TRACE_STRING_LENGTH = 20_000;
const AGENT_CONVERSATION_ROLES: readonly AgentConversationMessageRole[] = [
  "user",
  "assistant",
  "thinking",
  "system",
  "error",
  "question",
  "plan"
];
const AGENT_TRACE_DIRECTIONS: readonly AgentTraceDirection[] = ["client", "server", "local"];
const AGENT_TRACE_PHASES: readonly AgentTracePhase[] = [
  "connection",
  "planning",
  "execution",
  "tool_call",
  "stream",
  "error",
  "system"
];

const emptyContext: AgentConversationContextSnapshot = {
  previousOutputs: []
};

export function getAgentConversationSummaries(): AgentConversationSummary[] {
  return db
    .select()
    .from(agentConversations)
    .orderBy(desc(agentConversations.updatedAt))
    .limit(AGENT_CONVERSATION_QUERY_LIMIT)
    .all()
    .map((row) => toAgentConversationSummary(row))
    .filter((summary) => summary.messageCount > 0)
    .slice(0, AGENT_CONVERSATION_HISTORY_LIMIT);
}

export function getAgentConversation(conversationId: string): AgentConversation | undefined {
  const row = getAgentConversationRow(conversationId);
  return row ? toAgentConversation(row) : undefined;
}

export function getAgentConversationContext(conversationId: string | undefined): AgentConversationContextSnapshot | undefined {
  const id = normalizeConversationId(conversationId);
  if (!id) {
    return undefined;
  }

  const row = getAgentConversationRow(id);
  return row ? parseContext(row.contextJson) : undefined;
}

export function saveAgentConversation(input: {
  id: string;
  title?: string;
  messages: AgentConversationMessage[];
  trace?: AgentTraceEntry[];
}): AgentConversation {
  const id = normalizeConversationId(input.id);
  if (!id) {
    throw new Error("Agent conversation id is required.");
  }

  const existing = getAgentConversationRow(id);
  const createdAt = existing?.createdAt ?? nowIso();
  const updatedAt = nowIso();
  const messages = sanitizeMessages(input.messages);
  const trace = sanitizeTrace(input.trace);
  const title = normalizeTitle(input.title) ?? inferConversationTitle(messages) ?? existing?.title ?? "Agent conversation";
  const messagesJson = JSON.stringify({ messages, trace });
  const contextJson = existing?.contextJson ?? JSON.stringify(emptyContext);

  if (existing) {
    db.update(agentConversations)
      .set({
        title,
        messagesJson,
        contextJson,
        updatedAt
      })
      .where(eq(agentConversations.id, id))
      .run();
  } else {
    db.insert(agentConversations)
      .values({
        id,
        title,
        messagesJson,
        contextJson,
        createdAt,
        updatedAt
      })
      .run();
  }

  return getAgentConversation(id) ?? {
    id,
    title,
    messages,
    trace,
    createdAt,
    updatedAt
  };
}

export function saveAgentConversationContext(
  conversationId: string | undefined,
  context: AgentConversationContextSnapshot | undefined
): void {
  const id = normalizeConversationId(conversationId);
  if (!id || !context) {
    return;
  }

  const existing = getAgentConversationRow(id);
  const createdAt = existing?.createdAt ?? nowIso();
  const updatedAt = nowIso();
  const contextJson = JSON.stringify(sanitizeContext(context));

  if (existing) {
    db.update(agentConversations)
      .set({
        contextJson,
        updatedAt
      })
      .where(eq(agentConversations.id, id))
      .run();
    return;
  }

  db.insert(agentConversations)
    .values({
      id,
      title: "Agent conversation",
      messagesJson: "[]",
      contextJson,
      createdAt,
      updatedAt
    })
    .run();
}

function getAgentConversationRow(conversationId: string): (typeof agentConversations.$inferSelect) | undefined {
  return db.select().from(agentConversations).where(eq(agentConversations.id, conversationId)).get();
}

function toAgentConversation(row: typeof agentConversations.$inferSelect): AgentConversation {
  const payload = parseConversationPayload(row.messagesJson);
  return {
    id: row.id,
    title: row.title,
    messages: payload.messages,
    trace: payload.trace,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function toAgentConversationSummary(row: typeof agentConversations.$inferSelect): AgentConversationSummary {
  const messages = parseConversationPayload(row.messagesJson).messages;
  return {
    id: row.id,
    title: row.title,
    messageCount: messages.length,
    lastMessagePreview: lastMessagePreview(messages),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function parseConversationPayload(messagesJson: string): { messages: AgentConversationMessage[]; trace?: AgentTraceEntry[] } {
  try {
    const parsed = JSON.parse(messagesJson) as unknown;
    if (Array.isArray(parsed)) {
      return {
        messages: sanitizeMessages(parsed)
      };
    }

    if (isRecord(parsed)) {
      const trace = sanitizeTrace(parsed.trace);
      return {
        messages: sanitizeMessages(parsed.messages),
        trace: trace.length > 0 ? trace : undefined
      };
    }

    return {
      messages: []
    };
  } catch {
    return {
      messages: []
    };
  }
}

function parseContext(contextJson: string): AgentConversationContextSnapshot {
  try {
    return sanitizeContext(JSON.parse(contextJson) as unknown);
  } catch {
    return { ...emptyContext };
  }
}

function sanitizeMessages(input: unknown): AgentConversationMessage[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.slice(0, MAX_AGENT_CONVERSATION_MESSAGES).flatMap((message) => {
    const normalized = sanitizeMessage(message);
    return normalized ? [normalized] : [];
  });
}

function sanitizeTrace(input: unknown): AgentTraceEntry[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.slice(0, MAX_AGENT_TRACE_ENTRIES).flatMap((entry) => {
    const normalized = sanitizeTraceEntry(entry);
    return normalized ? [normalized] : [];
  });
}

function sanitizeTraceEntry(input: unknown): AgentTraceEntry | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const id = stringValue(input.id);
  const timestamp = stringValue(input.timestamp);
  const direction = isTraceDirection(input.direction) ? input.direction : undefined;
  const phase = isTracePhase(input.phase) ? input.phase : undefined;
  const eventType = stringValue(input.eventType);
  const label = stringValue(input.label);
  if (!id || !timestamp || !direction || !phase || !eventType || !label) {
    return undefined;
  }

  const durationMs = typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0
    ? Math.round(input.durationMs)
    : undefined;

  return {
    id,
    timestamp,
    direction,
    phase,
    eventType,
    label: truncate(label, MAX_AGENT_TRACE_STRING_LENGTH),
    requestId: stringValue(input.requestId),
    runId: stringValue(input.runId),
    toolName: stringValue(input.toolName),
    status: stringValue(input.status),
    durationMs,
    summary: input.summary ? truncate(String(input.summary), MAX_AGENT_TRACE_STRING_LENGTH) : undefined,
    payload: sanitizeTracePayload(input.payload, 0)
  };
}

function sanitizeTracePayload(input: unknown, depth: number): unknown {
  if (input === undefined) {
    return undefined;
  }

  if (input === null || typeof input === "number" || typeof input === "boolean") {
    return input;
  }

  if (typeof input === "string") {
    return truncate(input, MAX_AGENT_TRACE_STRING_LENGTH);
  }

  if (depth >= 8) {
    return "[truncated]";
  }

  if (Array.isArray(input)) {
    return input.slice(0, 100).map((item) => sanitizeTracePayload(item, depth + 1));
  }

  if (!isRecord(input)) {
    return undefined;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input).slice(0, 100)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === "dataurl" ||
      normalizedKey === "bytes" ||
      normalizedKey.includes("apikey") ||
      normalizedKey.includes("secret") ||
      normalizedKey.includes("token") ||
      normalizedKey === "authorization"
    ) {
      sanitized[key] = "[redacted]";
      continue;
    }

    sanitized[key] = sanitizeTracePayload(value, depth + 1);
  }

  return sanitized;
}

function sanitizeMessage(input: unknown): AgentConversationMessage | undefined {
  if (!isRecord(input) || !isAgentConversationRole(input.role) || typeof input.content !== "string") {
    return undefined;
  }

  const id = stringValue(input.id);
  const timestamp = stringValue(input.timestamp);
  if (!id || !timestamp) {
    return undefined;
  }

  const details = stringValue(input.details);
  const runId = stringValue(input.runId);
  const previews = sanitizeAssetPreviews(input.previews);
  const plan = stripPersistentDataUrls(input.plan);
  return {
    id,
    role: input.role,
    content: input.content,
    details,
    timestamp,
    runId,
    plan,
    previews
  };
}

function sanitizeAssetPreviews(input: unknown): AgentConversationMessage["previews"] {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const previews = input.flatMap((preview) => {
    if (!isRecord(preview)) {
      return [];
    }

    const id = stringValue(preview.id);
    const assetId = stringValue(preview.assetId);
    const jobId = stringValue(preview.jobId);
    const url = stringValue(preview.url);
    if (!id || !assetId || !jobId || !url) {
      return [];
    }

    return [
      {
        id,
        assetId,
        jobId,
        outputId: stringValue(preview.outputId),
        planId: stringValue(preview.planId),
        shapeId: stringValue(preview.shapeId),
        url
      }
    ];
  });

  return previews.length > 0 ? previews : undefined;
}

function sanitizeContext(input: unknown): AgentConversationContextSnapshot {
  if (!isRecord(input)) {
    return { ...emptyContext };
  }

  const previousUserText = stringValue(input.previousUserText);
  const pendingUserText = stringValue(input.pendingUserText);
  return {
    previousUserText,
    pendingUserText,
    previousPlan: isRecord(input.previousPlan) ? (stripPersistentDataUrls(input.previousPlan) as GenerationPlan) : undefined,
    previousOutputs: sanitizeConversationOutputs(input.previousOutputs)
  };
}

function sanitizeConversationOutputs(input: unknown): AgentConversationContextSnapshot["previousOutputs"] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.slice(0, MAX_AGENT_SELECTED_REFERENCES).flatMap((output) => {
    if (!isRecord(output)) {
      return [];
    }

    const index = positiveIntegerValue(output.index);
    const assetId = stringValue(output.assetId);
    if (!index || !assetId) {
      return [];
    }

    return [
      {
        index,
        assetId,
        label: stringValue(output.label),
        width: positiveIntegerValue(output.width),
        height: positiveIntegerValue(output.height),
        mimeType: stringValue(output.mimeType),
        planId: stringValue(output.planId),
        jobId: stringValue(output.jobId),
        outputId: stringValue(output.outputId)
      }
    ];
  });
}

function stripPersistentDataUrls(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map(stripPersistentDataUrls);
  }

  if (!isRecord(input)) {
    return input;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "dataUrl") {
      continue;
    }
    sanitized[key] = stripPersistentDataUrls(value);
  }

  return sanitized;
}

function inferConversationTitle(messages: AgentConversationMessage[]): string | undefined {
  const firstUserMessage = messages.find((message) => message.role === "user" && message.content.trim());
  return normalizeTitle(firstUserMessage?.content);
}

function lastMessagePreview(messages: AgentConversationMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content.trim();
    if (content) {
      return truncate(content, MAX_AGENT_CONVERSATION_PREVIEW_LENGTH);
    }
  }

  return undefined;
}

function normalizeTitle(value: string | undefined): string | undefined {
  const title = value?.trim().replace(/\s+/gu, " ");
  return title ? truncate(title, MAX_AGENT_CONVERSATION_TITLE_LENGTH) : undefined;
}

function normalizeConversationId(value: string | undefined): string | undefined {
  const id = value?.trim();
  return id && /^[a-zA-Z0-9:_-]{1,120}$/u.test(id) ? id : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function isAgentConversationRole(value: unknown): value is AgentConversationMessageRole {
  return typeof value === "string" && (AGENT_CONVERSATION_ROLES as readonly string[]).includes(value);
}

function isTraceDirection(value: unknown): value is AgentTraceDirection {
  return typeof value === "string" && (AGENT_TRACE_DIRECTIONS as readonly string[]).includes(value);
}

function isTracePhase(value: unknown): value is AgentTracePhase {
  return typeof value === "string" && (AGENT_TRACE_PHASES as readonly string[]).includes(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string" || !/^\d+$/u.test(value.trim())) {
    return undefined;
  }

  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
