// Readers for the fields of a YAML file the user wrote: each one names the
// field in its error, so a mistake points at the line to fix.
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { UserError } from "./errors.js";

export type ObjectValue = Record<string, unknown>;

/** `~` is the home directory; a relative path is relative to the file that wrote it. */
export function resolvePath(path: string, baseDir: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
}

export function requireObject(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserError(`${label} must be an object`);
  }
  return value as ObjectValue;
}

export function optionalObject(value: unknown, label: string): ObjectValue {
  return value === undefined ? {} : requireObject(value, label);
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new UserError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireString(value, label);
}

export function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new UserError(`${label} must be a list of non-empty strings`);
  }
  return value.map((item) => String(item).trim());
}

export function optionalStringArray(value: unknown, label: string): string[] {
  return value === undefined ? [] : requireStringArray(value, label);
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new UserError(`${label} must be true or false`);
  return value;
}

export function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
