import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, fmtSize, fmtTime, uploadImage, type MediaItem } from '../api';
import { Field, Modal, Pager, confirmDialog, toast } from '../components/ui';

export function Media() {
  const [data, setData] = useState<{ items: MediaItem[]; total: number; page: number; pageSize: number } | null>(null);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [unused, setUnused] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [current, setCurrent] = useState<MediaItem | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setData(await api('GET', `/media?page=${page}&q=${encodeURIComponent(q)}${unused ? '&unused=1' : ''}`));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, [page, q, unused]);
  useEffect(() => void load(), [load]);

  const upload = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) return toast('请选择图片文件', 'error');
    setUploading(images.length);
    let failed = 0;
    for (const file of images) {
      try {
        const saved = await uploadImage(file);
        if (saved.duplicate) toast(`“${file.name}”已存在，未重复保存`);
      } catch (e) {
        failed++;
        toast(`“${file.name}”上传失败：${(e as Error).message}`, 'error');
      }
      setUploading((n) => n - 1);
    }
    if (failed < images.length) toast(`已上传 ${images.length - failed} 个文件`);
    setPage(1);
    await load();
  };

  const remove = async (m: MediaItem) => {
    try {
      const usages = await api<{ id: number; title: string; inPublished: boolean }[]>('GET', `/media/${m.id}/usages`);
      const ok = await confirmDialog({
        title: usages.length ? '该图片正在被文章使用' : '删除这张图片？',
        danger: true,
        confirmText: usages.length ? '仍然删除' : '删除',
        body: usages.length ? (
          <>
            <p>删除后，以下文章中的图片将无法显示：</p>
            <ul>
              {usages.map((u) => (
                <li key={u.id}>
                  {u.title || '（无标题）'}
                  {u.inPublished && <span className="badge badge-published">线上版本</span>}
                </li>
              ))}
            </ul>
          </>
        ) : (
          '文件将从服务器上移除，无法恢复。'
        ),
      });
      if (!ok) return;
      await api('DELETE', `/media/${m.id}?force=1`);
      toast('已删除');
      setCurrent(null);
      await load();
    } catch (e) {
      toast((e as ApiError).message, 'error');
    }
  };

  const copy = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    toast(`已复制${label}`);
  };

  return (
    <>
      <header className="page-head">
        <h1>媒体库</h1>
        <div className="row">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setPage(1);
              setQ(search.trim());
            }}
          >
            <input type="search" placeholder="搜索文件名…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="搜索媒体" />
          </form>
          <label className="check" style={{ margin: 0 }} title="没有被任何文章、页面、专题引用的图片">
            <input
              type="checkbox"
              checked={unused}
              onChange={(e) => {
                setPage(1);
                setUnused(e.target.checked);
              }}
            />
            只看未引用
          </label>
          <button className="btn btn-primary" onClick={() => fileInput.current?.click()} disabled={uploading > 0}>
            {uploading > 0 ? `上传中（剩余 ${uploading}）…` : '上传图片'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void upload([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </div>
      </header>

      <div
        className="dropzone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void upload([...e.dataTransfer.files]);
        }}
      >
        {!data ? (
          <div className="muted">加载中…</div>
        ) : data.items.length === 0 ? (
          <div className="empty">{unused ? '没有未引用的图片，所有图片都在使用中。' : q ? '没有匹配的文件' : '还没有图片。点击“上传图片”，或把图片拖到这里。支持 JPG、PNG、WebP、GIF、AVIF，单个不超过 10MB。'}</div>
        ) : (
          <div className="media-grid">
            {data.items.map((m) => (
              <button key={m.id} className="media-item" onClick={() => setCurrent(m)} title={m.originalName}>
                <img src={m.url} alt={m.alt} loading="lazy" />
                <span>{m.originalName}</span>
                {(m as any).used === false && <span className="badge badge-pending">未引用</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {data && <Pager page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} />}

      {current && (
        <Modal title="图片详情" onClose={() => setCurrent(null)} wide>
          <div className="media-detail">
            <img src={current.url} alt={current.alt} />
            <div>
              <p className="muted small">
                {current.originalName} · {current.width}×{current.height} · {fmtSize(current.size)} · {fmtTime(current.createdAt)}
              </p>
              <Field label="替代文字（Alt）" hint="描述图片内容，供读屏软件和图片加载失败时使用">
                <input
                  defaultValue={current.alt}
                  onBlur={async (e) => {
                    if (e.target.value === current.alt) return;
                    try {
                      const saved = await api<MediaItem>('PATCH', `/media/${current.id}`, { alt: e.target.value });
                      setCurrent(saved);
                      toast('已保存');
                      void load();
                    } catch (err) {
                      toast((err as Error).message, 'error');
                    }
                  }}
                />
              </Field>
              <Field label="地址">
                <input readOnly value={current.url} onFocus={(e) => e.target.select()} />
              </Field>
              <div className="row">
                <button className="btn" onClick={() => void copy(current.url, '地址')}>
                  复制地址
                </button>
                <button className="btn" onClick={() => void copy(`![${current.alt}](${current.url})`, ' Markdown')}>
                  复制 Markdown
                </button>
                <a className="btn" href={current.url} download>
                  下载
                </a>
                <button className="btn btn-danger" onClick={() => void remove(current)}>
                  删除
                </button>
              </div>
              <p className="muted small">
                要在文章里使用，可在 <Link to="/posts">编辑器</Link> 中直接粘贴或拖入图片。
              </p>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
