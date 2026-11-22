import { useEffect, useMemo, useState } from 'react';
import { diffLines } from 'diff';
import { api, fmtTime } from '../api';
import { Modal, confirmDialog, toast } from './ui';

const KIND: Record<string, string> = { auto: '自动保存', manual: '手动保存', publish: '发布', restore: '恢复' };

export function DiffView({ before, after, beforeLabel, afterLabel }: { before: string; after: string; beforeLabel: string; afterLabel: string }) {
  const parts = useMemo(() => diffLines(before, after), [before, after]);
  const changed = parts.some((p) => p.added || p.removed);
  return (
    <div className="diff">
      <div className="diff-legend">
        <span className="diff-del">－ {beforeLabel}</span>
        <span className="diff-add">＋ {afterLabel}</span>
      </div>
      {!changed ? (
        <p className="muted">正文内容完全相同。</p>
      ) : (
        <pre>
          {parts.map((part, i) => {
            const lines = part.value.replace(/\n$/, '').split('\n');
            // 没有变化的长段落只保留首尾几行
            if (!part.added && !part.removed && lines.length > 8) {
              return (
                <span key={i}>
                  {lines.slice(0, 3).map((l, j) => (
                    <span key={j} className="diff-line">{`  ${l}\n`}</span>
                  ))}
                  <span className="diff-line diff-skip">{`  … 省略 ${lines.length - 6} 行未变化内容 …\n`}</span>
                  {lines.slice(-3).map((l, j) => (
                    <span key={`e${j}`} className="diff-line">{`  ${l}\n`}</span>
                  ))}
                </span>
              );
            }
            return lines.map((l, j) => (
              <span key={`${i}-${j}`} className={`diff-line${part.added ? ' diff-add' : part.removed ? ' diff-del' : ''}`}>{`${part.added ? '+' : part.removed ? '-' : ' '} ${l}\n`}</span>
            ));
          })}
        </pre>
      )}
    </div>
  );
}

export function Revisions({ postId, currentMarkdown, dirty, onClose, onRestored }: { postId: number; currentMarkdown: string; dirty: boolean; onClose: () => void; onRestored: () => void }) {
  const [list, setList] = useState<any[] | null>(null);
  const [selected, setSelected] = useState<any>(null);

  useEffect(() => {
    api('GET', `/posts/${postId}/revisions`)
      .then(setList)
      .catch((e) => toast(e.message, 'error'));
  }, [postId]);

  const select = async (id: number) => {
    try {
      setSelected(await api('GET', `/posts/${postId}/revisions/${id}`));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const restore = async () => {
    const ok = await confirmDialog({
      title: '恢复到这个版本？',
      body: (
        <>
          <p>该版本的内容会成为新的草稿，线上内容不受影响，需要你再次确认发布后才会更新。</p>
          {dirty && <p className="form-error">当前有尚未保存的修改，恢复后这些修改会丢失。</p>}
        </>
      ),
      confirmText: '恢复为草稿',
    });
    if (!ok) return;
    try {
      await api('POST', `/posts/${postId}/revisions/${selected.id}/restore`, {});
      toast('已恢复为草稿，确认无误后请重新发布');
      onRestored();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Modal title="版本历史" onClose={onClose} wide>
      <div className="revisions">
        <ul className="revision-list">
          {!list && <li className="muted">加载中…</li>}
          {list?.map((r) => (
            <li key={r.id}>
              <button className={selected?.id === r.id ? 'active' : ''} onClick={() => void select(r.id)}>
                <strong>{fmtTime(r.updatedAt)}</strong>
                <span className="muted small">
                  {KIND[r.kind] ?? r.kind}
                  {r.author ? ` · ${r.author}` : ''} · {r.length} 字符
                </span>
                {r.note && <span className="small">{r.note}</span>}
                <span>
                  {r.isPublished && <span className="badge badge-published">线上版本</span>}
                  {r.isDraft && <span className="badge">当前草稿</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="revision-detail">
          {!selected ? (
            <p className="muted">从左侧选择一个版本，查看它与当前编辑内容的差异。</p>
          ) : (
            <>
              <div className="row between">
                <strong>{selected.title || '（无标题）'}</strong>
                <button className="btn btn-primary" onClick={() => void restore()}>
                  恢复这个版本
                </button>
              </div>
              <DiffView before={selected.markdown} after={currentMarkdown} beforeLabel="所选版本" afterLabel="当前编辑内容" />
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
