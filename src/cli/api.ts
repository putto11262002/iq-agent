import { hc } from "hono/client";
import type { AppType } from "../server/app.ts";

const baseUrl = process.env.API_URL || "http://localhost:4400";
export const api = hc<AppType>(baseUrl);

/** Helper for JSON POST/PATCH/PUT calls where hc doesn't infer body types */
export async function apiFetch(path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
