import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, indentUnit, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { python } from "@codemirror/lang-python";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { useAppStore } from "../store";
import { dirtyDocument, EditorLanguage, uploadBusy } from "../editorDocument";

function languageExtension(language: EditorLanguage) {
  return [language === "python" ? python() : language === "shell" ? StreamLanguage.define(shell) : [],
    indentUnit.of(language === "shell" ? "  " : "    ")];
}

function CodeEditor({ language, locked, onCursor, focusToolbar }: {
  language: EditorLanguage; locked: boolean;
  onCursor: (position: string) => void; focusToolbar: () => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const languageConfig = useRef(new Compartment());
  const readOnlyConfig = useRef(new Compartment());

  useEffect(() => {
    if (!parent.current) return;
    const editor = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: useAppStore.getState().fileContent,
        extensions: [
          lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(),
          history(), indentOnInput(), bracketMatching(), closeBrackets(),
          search({ top: true }), highlightSelectionMatches(),
          syntaxHighlighting(oneDarkHighlightStyle),
          languageConfig.current.of(languageExtension(language)),
          readOnlyConfig.current.of(EditorState.readOnly.of(locked)),
          EditorState.changeFilter.of(() => {
            const state = useAppStore.getState();
            return !state.loading && !state.starting && !state.guarding;
          }),
          EditorView.contentAttributes.of({ "aria-label": "脚本内容编辑器", spellcheck: "false" }),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { void useAppStore.getState().saveFile(); return true; } },
            ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap,
            { key: "Escape", run: () => { focusToolbar(); return true; } }, indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) useAppStore.getState().editContent(update.state.doc.toString());
            if (update.docChanged || update.selectionSet) {
              const pos = update.state.selection.main.head;
              const line = update.state.doc.lineAt(pos);
              onCursor(`${line.number}:${pos - line.from + 1}`);
            }
          }),
          EditorView.theme({
            "&": { height: "100%", color: "#ddd", backgroundColor: "#17181c" },
            ".cm-scroller": { overflow: "auto", fontFamily: 'Consolas, "Cascadia Mono", monospace', fontSize: "13px", lineHeight: "1.5" },
            ".cm-content": { padding: "10px 0", caretColor: "#fff" },
            ".cm-cursor": { borderLeftColor: "#fff" },
            ".cm-gutters": { backgroundColor: "#17181c", color: "#7d8595", borderRight: "1px solid #2a2b30" },
            ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "#ffffff09" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "#324869" },
            ".cm-panels": { backgroundColor: "#23252d", color: "#ddd" },
          }, { dark: true }),
        ],
      }),
    });
    view.current = editor;
    onCursor("1:1");
    return () => { editor.destroy(); view.current = null; };
    // A document generation remounts this component; ordinary edits preserve history.
  }, []);

  useEffect(() => { view.current?.dispatch({ effects: languageConfig.current.reconfigure(languageExtension(language)) }); }, [language]);
  useEffect(() => { view.current?.dispatch({ effects: readOnlyConfig.current.reconfigure(EditorState.readOnly.of(locked)) }); }, [locked]);
  return <div className="code-editor" ref={parent} />;
}

export function Editor({ collapsed = false, onToggleCollapse }: { collapsed?: boolean; onToggleCollapse?: () => void }) {
  const state = useAppStore(useShallow((s) => ({ openFile: s.openFile, dirty: dirtyDocument(s),
    language: s.language, generation: s.documentGeneration, eol: s.eol, bom: s.bom,
    loading: s.loading, saving: s.saving, starting: s.starting, guarding: s.guarding,
    error: s.editorError, conflict: s.conflict, uploadBusy: uploadBusy(s) })));
  const [cursor, setCursor] = useState("1:1");
  const languageSelect = useRef<HTMLSelectElement>(null);
  const locked = state.loading || state.starting || state.guarding;
  return <div className={`editor${!state.openFile ? " empty" : ""}`}>
    {state.error && <div className="editor-error" role="alert">{state.error}
      {state.conflict && <button disabled={locked || state.saving} onClick={() => void useAppStore.getState().reloadFile()}>重新加载磁盘内容…</button>}
    </div>}
    {!state.openFile ? <p>{state.loading ? "正在打开…" : "在左侧 Workspace 中选择脚本文件，或用下方命令模式运行。"}</p> : <>
      <div className="editor-title">
        <button className="editor-collapse" aria-label={collapsed ? "展开编辑区" : "折叠编辑区"} aria-expanded={!collapsed}
          title={collapsed ? "展开编辑区" : "折叠编辑区"} onClick={onToggleCollapse}>{collapsed ? "▸" : "▾"}</button>
        <span className="editor-filename" title={state.openFile}>{state.openFile}{state.dirty ? " ●" : ""}</span>
        <select ref={languageSelect} aria-label="编辑器语言" value={state.language} disabled={locked}
          onChange={(event) => useAppStore.getState().setLanguage(event.target.value as EditorLanguage)}>
          <option value="python">Python</option><option value="shell">Shell</option><option value="text">纯文本</option>
        </select>
        <button disabled={locked || state.saving || !state.dirty || state.uploadBusy} title="保存到本地文件 (Ctrl+S)"
          onClick={() => void useAppStore.getState().saveFile()}>{state.saving ? "保存中…" : "保存"}</button>
      </div>
      {/* 折叠时编辑器保持挂载仅隐藏 DOM，保留撤销历史、滚动位置与选区 */}
      <div className={`editor-body${collapsed ? " collapsed" : ""}`}>
        <CodeEditor key={state.generation} language={state.language} locked={locked} onCursor={setCursor}
          focusToolbar={() => languageSelect.current?.focus()} />
        <div className="editor-status" role="status">
          <span>{state.loading ? "正在打开…" : state.starting ? "正在保存并启动…" : state.saving ? "保存中…" : state.error ? "操作失败" : state.dirty ? "未保存" : "已保存"}
            {state.uploadBusy ? " · 任务准备/同步/停止期间暂停保存" : ""}</span>
          <span>{cursor} · UTF-8{state.bom ? " BOM" : ""} · {state.eol.toUpperCase()} · Esc 返回工具栏</span>
        </div>
      </div>
    </>}
  </div>;
}
