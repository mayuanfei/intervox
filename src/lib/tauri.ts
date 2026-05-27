import { invoke } from "@tauri-apps/api/core";

export async function invokeOrFallback<T>(
  command: string,
  args: Record<string, unknown>,
  fallback: T,
): Promise<T> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return fallback;
  }

  return invoke<T>(command, args);
}
