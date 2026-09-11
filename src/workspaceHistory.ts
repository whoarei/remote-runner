const STORAGE_KEY = "remote-runner.recent-workspaces.v1";
const MAX_RECENT_WORKSPACES = 10;

function normalizeHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((dir): dir is string =>
    typeof dir === "string" && dir.trim().length > 0
  ))].slice(0, MAX_RECENT_WORKSPACES);
}

export function loadWorkspaceHistory(): string[] {
  try {
    return normalizeHistory(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function saveWorkspaceHistory(directories: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(directories));
  } catch (error) {
    console.warn("Unable to save recent workspaces", error);
  }
}

export function rememberWorkspace(directories: string[], dir: string): string[] {
  return normalizeHistory([dir, ...directories]);
}
