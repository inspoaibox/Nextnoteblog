import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import TurndownService from 'turndown';
// @ts-expect-error 该包没有类型声明
import { gfm } from 'turndown-plugin-gfm';

export interface EditorHandle {
  getValue(): string;
  setValue(text: string): void;
  focus(): void;
  /** 用前后缀包裹选区（粗体、斜体、行内代码…） */
  wrap(before: string, after?: string, placeholder?: string): void;
  /** 给选中的每一行加前缀（标题、列表、引用…） */
  prefixLines(prefix: string | ((index: number) => string)): void;
  /** 作为独立的块插入（代码块、表格、分割线…） */
  insertBlock(text: string, selectFrom?: number, selectTo?: number): void;
  insertText(text: string): void;
  replaceText(search: string, replacement: string): void;
}

interface Props {
  initialValue: string;
  wrapLines: boolean;
  onChange(value: string): void;
  onSave(): void;
  onFiles(files: File[]): void;
  /** 编辑区顶部可见的行号（从 1 开始），用于同步预览滚动 */
  onTopLine?(line: number): void;
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', emDelimiter: '*', hr: '---' });
turndown.use(gfm);

const RICH_TAGS = /<(a|strong|b|em|i|h[1-6]|ul|ol|li|table|img|pre|blockquote)[\s>]/i;

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '15px' },
  '.cm-scroller': { fontFamily: '"JetBrains Mono", "Cascadia Code", "SF Mono", Consolas, monospace', lineHeight: '1.7' },
  '.cm-content': { padding: '16px 0 40vh' },
  '.cm-line': { padding: '0 20px 0 8px' },
  '.cm-gutters': { background: 'transparent', border: 'none', color: 'var(--muted)' },
  '&.cm-focused': { outline: 'none' },
});

export const MarkdownEditor = forwardRef<EditorHandle, Props>(function MarkdownEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const wrapCompartment = useRef(new Compartment());
  // 回调放进 ref，避免因为闭包变化重建编辑器
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => {
    const imageFiles = (list: FileList | undefined | null) => [...(list ?? [])].filter((f) => f.type.startsWith('image/'));

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.initialValue,
        extensions: [
          basicSetup,
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          wrapCompartment.current.of(props.wrapLines ? EditorView.lineWrapping : []),
          theme,
          keymap.of([
            indentWithTab,
            { key: 'Mod-s', preventDefault: true, run: () => (cb.current.onSave(), true) },
            { key: 'Mod-b', run: () => (api.wrap('**', '**', '粗体'), true) },
            { key: 'Mod-i', run: () => (api.wrap('*', '*', '斜体'), true) },
            { key: 'Mod-k', run: () => (api.wrap('[', '](https://)', '链接文字'), true) },
            { key: 'Mod-e', run: () => (api.wrap('`', '`', 'code'), true) },
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            paste(event, v) {
              const files = imageFiles(event.clipboardData?.files);
              if (files.length) {
                event.preventDefault();
                cb.current.onFiles(files);
                return true;
              }
              // 从网页等富文本来源粘贴时转成 Markdown；来自代码编辑器的内容按纯文本处理
              const html = event.clipboardData?.getData('text/html') ?? '';
              if (html && RICH_TAGS.test(html) && !/vscode-|data-vscode|monaco/i.test(html)) {
                event.preventDefault();
                const md = turndown.turndown(html).trim();
                v.dispatch(v.state.replaceSelection(md), { scrollIntoView: true, userEvent: 'input.paste' });
                return true;
              }
              return false;
            },
            drop(event, v) {
              const files = imageFiles(event.dataTransfer?.files);
              if (!files.length) return false;
              event.preventDefault();
              const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos != null) v.dispatch({ selection: { anchor: pos } });
              cb.current.onFiles(files);
              return true;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;

    const onScroll = () => {
      const top = view.scrollDOM.getBoundingClientRect().top;
      const block = view.lineBlockAtHeight(top - view.documentTop + 4);
      cb.current.onTopLine?.(view.state.doc.lineAt(block.from).number);
    };
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      view.scrollDOM.removeEventListener('scroll', onScroll);
      view.destroy();
      viewRef.current = null;
    };
    // 编辑器只创建一次，之后通过 handle 更新内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrapCompartment.current.reconfigure(props.wrapLines ? EditorView.lineWrapping : []) });
  }, [props.wrapLines]);

  const api: EditorHandle = {
    getValue: () => viewRef.current?.state.doc.toString() ?? '',
    setValue(text) {
      const view = viewRef.current;
      if (!view || view.state.doc.toString() === text) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } });
    },
    focus: () => viewRef.current?.focus(),
    wrap(before, after = before, placeholder = '') {
      const view = viewRef.current!;
      view.dispatch(
        view.state.changeByRange((range) => {
          const selected = view.state.sliceDoc(range.from, range.to);
          // 已经被同样的标记包裹则取消
          if (selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length) {
            const inner = selected.slice(before.length, selected.length - after.length);
            return { changes: { from: range.from, to: range.to, insert: inner }, range: EditorSelection.range(range.from, range.from + inner.length) };
          }
          const text = selected || placeholder;
          return {
            changes: { from: range.from, to: range.to, insert: before + text + after },
            range: EditorSelection.range(range.from + before.length, range.from + before.length + text.length),
          };
        }),
        { scrollIntoView: true, userEvent: 'input' },
      );
      view.focus();
    },
    prefixLines(prefix) {
      const view = viewRef.current!;
      const { state } = view;
      const changes: { from: number; to: number; insert: string }[] = [];
      for (const range of state.selection.ranges) {
        const first = state.doc.lineAt(range.from).number;
        const last = state.doc.lineAt(range.to).number;
        for (let n = first; n <= last; n++) {
          const line = state.doc.line(n);
          const p = typeof prefix === 'function' ? prefix(n - first) : prefix;
          // 替换已有的标题 / 列表 / 引用前缀，重复点击同一个按钮则取消
          const existing = /^(\s*)(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+|>\s?)/.exec(line.text);
          const indent = existing?.[1] ?? '';
          const old = existing?.[2] ?? '';
          const same = old === p || (/^\d+\.\s+$/.test(old) && /^\d+\.\s+$/.test(p));
          changes.push({ from: line.from + indent.length, to: line.from + indent.length + old.length, insert: same ? '' : p });
        }
      }
      view.dispatch({ changes, scrollIntoView: true, userEvent: 'input' });
      view.focus();
    },
    insertBlock(text, selectFrom, selectTo) {
      const view = viewRef.current!;
      const { state } = view;
      const range = state.selection.main;
      const line = state.doc.lineAt(range.from);
      const before = range.from > line.from || line.text.trim() ? '\n\n' : state.doc.lineAt(Math.max(0, line.from - 1)).text.trim() && line.from > 0 ? '\n' : '';
      const insertAt = line.text.trim() ? state.doc.lineAt(range.to).to : range.from;
      const insert = `${before}${text}\n`;
      const base = insertAt + before.length;
      view.dispatch({
        changes: { from: insertAt, to: insertAt, insert },
        selection: selectFrom != null ? EditorSelection.range(base + selectFrom, base + (selectTo ?? selectFrom)) : { anchor: base + text.length },
        scrollIntoView: true,
        userEvent: 'input',
      });
      view.focus();
    },
    insertText(text) {
      const view = viewRef.current!;
      view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: 'input' });
    },
    replaceText(search, replacement) {
      const view = viewRef.current!;
      const index = view.state.doc.toString().indexOf(search);
      if (index >= 0) view.dispatch({ changes: { from: index, to: index + search.length, insert: replacement } });
    },
  };
  useImperativeHandle(ref, () => api);

  return <div className="cm-host" ref={host} />;
});
