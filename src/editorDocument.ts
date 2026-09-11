export type EditorLanguage = "python" | "shell" | "text";
export type ChangeChoice = "save" | "discard" | "cancel";

export function inferLanguage(name: string): EditorLanguage {
  if (/\.py$/i.test(name)) return "python";
  if (/\.(sh|bash)$/i.test(name)) return "shell";
  return "text";
}

export function dirtyDocument(state: { openFile: string | null; fileContent: string; savedContent: string }): boolean {
  return state.openFile !== null && state.fileContent !== state.savedContent;
}

export function uploadBusy(state: { runs: Record<string, { state: string }> }): boolean {
  return Object.values(state.runs).some((run) => ["preparing", "syncing", "stopping"].includes(run.state));
}
