import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export interface ChatGptSession {
  url: string;
  title?: string;
  savedAt: string;
}

export function sessionFile(workspaceId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(workspaceId)) {
    throw new Error("Invalid workspace id for ChatGPT session storage.");
  }
  return path.join(getStateDir(), "sessions", `${workspaceId}.json`);
}

export function readChatGptSession(workspaceId: string): ChatGptSession | null {
  const session = readJsonIfExists<ChatGptSession>(sessionFile(workspaceId));
  if (!session || typeof session.url !== "string") return null;
  try {
    const url = new URL(session.url);
    if (url.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(url.hostname)) {
      return null;
    }
  } catch {
    return null;
  }
  return session;
}

export function saveChatGptSession(
  workspaceId: string,
  session: Pick<ChatGptSession, "url" | "title">
): ChatGptSession {
  const url = new URL(session.url);
  if (url.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(url.hostname)) {
    throw new Error("ChatGPT session URL must use HTTPS on chatgpt.com or chat.openai.com.");
  }
  const saved: ChatGptSession = { ...session, url: url.toString(), savedAt: new Date().toISOString() };
  writeSecureJson(sessionFile(workspaceId), saved);
  return saved;
}
