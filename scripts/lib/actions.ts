import { appendFileSync, readFileSync } from "node:fs";

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export interface ClientPayload {
  dispatch_id: string;
  worker: string;
  kind: "issue" | "review" | "command";
  repo: string;
  number: number;
}

export function clientPayload(): ClientPayload {
  const event = JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf8")) as { client_payload?: ClientPayload };
  const payload = event.client_payload;
  if (!payload || !/^[A-Za-z0-9_-]{16,64}$/.test(payload.dispatch_id) || !/^https:\/\/[^/\s]+$/.test(payload.worker)) {
    throw new Error("Invalid tidy dispatch payload");
  }
  return payload;
}

// Values go through a delimiter that cannot appear in them, so text cannot inject extra outputs.
export function setOutput(name: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`Output ${name} must be a single line`);
  appendFileSync(env("GITHUB_OUTPUT"), `${name}=${value}\n`);
}

export function mask(value: string): void {
  for (const line of value.split(/\r?\n/)) if (line.trim()) process.stdout.write(`::add-mask::${line}\n`);
}

export function notice(message: string): void {
  process.stdout.write(`::notice::${message.replace(/[\r\n%]/g, " ")}\n`);
}
