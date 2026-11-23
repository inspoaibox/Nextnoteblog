import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useStatus } from '../App';
import { Field, toast } from '../components/ui';

function SiteTexts() {
  const { status } = useStatus();
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState({ siteName: '', tagline: '', description: '', footerText: '' });
  const lang = status.languages.find((l) => l.code === status.contentLocale);

  useEffect(() => {
    api('GET', '/site-texts')
      .then((d) => {
        setData(d);
        setForm({ siteName: '', tagline: '', description: '', footerText: '', ...d.texts });
      })
      .catch((e) => toast(e.message, 'error'));
  }, []);
  if (!data) return <div className="muted">加载中…</div>;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('PUT', '/site-texts', form);
      toast('已保存');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <>
      <header className="page-head">
        <h1>设置</h1>
      </header>
      <form className="panel form-narrow" onSubmit={save}>
        <h2>{lang?.name} 的站点文案</h2>
        <p className="muted">留空的项使用默认语言的内容（灰色文字）。时区、外观等与语言无关的设置，请把左侧“内容语言”切回默认语言后修改。</p>
        <Field label="站点名称">
          <input value={form.siteName} onChange={set('siteName')} placeholder={data.fallback.siteName} maxLength={100} />
        </Field>
        <Field label="标语">
          <input value={form.tagline} onChange={set('tagline')} placeholder={data.fallback.tagline} maxLength={200} />
        </Field>
        <Field label="站点介绍">
          <textarea rows={3} value={form.description} onChange={set('description')} placeholder={data.fallback.description} maxLength={500} />
        </Field>
        <Field label="页脚说明">
          <input value={form.footerText} onChange={set('footerText')} placeholder={data.fallback.footerText} maxLength={500} />
        </Field>
        <button className="btn btn-primary">保存</button>
      </form>
    </>
  );
}

export function Settings() {
  const { status } = useStatus();
  return status.contentLocale === status.site.defaultLocale ? <BaseSettings /> : <SiteTexts />;
}

function BaseSettings() {
  const { reload } = useStatus();
  const [form, setForm] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [pwd, setPwd] = useState({ current: '', next: '', confirm: '' });

  useEffect(() => {
    api('GET', '/settings')
      .then(setForm)
      .catch((e) => toast(e.message, 'error'));
  }, []);

  if (!form) return <div className="muted">加载中…</div>;
  const set = (k: string) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { siteName, tagline, description, siteUrl, timezone, appearance, icp, footerText, siteNoindex } = form;
      setForm(await api('PUT', '/settings', { siteName, tagline, description, siteUrl: siteUrl.replace(/\/+$/, ''), timezone, appearance, icp, footerText, siteNoindex: !!siteNoindex, postsPerPage: Number(form.postsPerPage) }));
      await reload();
      toast('设置已保存');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (pwd.next !== pwd.confirm) return toast('两次输入的新密码不一致', 'error');
    try {
      await api('POST', '/account/password', { current: pwd.current, next: pwd.next });
      setPwd({ current: '', next: '', confirm: '' });
      toast('密码已修改，其他设备上的登录已失效');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <>
      <header className="page-head">
        <h1>设置</h1>
      </header>

      <form className="panel form-narrow" onSubmit={save}>
        <h2>站点信息</h2>
        <Field label="站点名称">
          <input value={form.siteName} onChange={set('siteName')} required maxLength={100} />
        </Field>
        <Field label="标语">
          <input value={form.tagline} onChange={set('tagline')} maxLength={200} />
        </Field>
        <Field label="站点介绍" hint="显示在首页，并作为搜索引擎描述">
          <textarea rows={3} value={form.description} onChange={set('description')} maxLength={500} />
        </Field>
        <Field label="站点地址" hint="例如 https://example.com，用于生成规范链接；可留空">
          <input value={form.siteUrl} onChange={set('siteUrl')} placeholder="https://" />
        </Field>

        <h2>显示</h2>
        <Field label="外观模式" hint="由管理员统一决定，访客不能切换">
          <select value={form.appearance} onChange={set('appearance')}>
            <option value="auto">跟随访客系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </Field>
        <Field label="每页文章数">
          <input type="number" min={1} max={50} value={form.postsPerPage} onChange={set('postsPerPage')} required />
        </Field>
        <Field label="时区" hint="例如 Asia/Shanghai，用于前台日期显示">
          <input value={form.timezone} onChange={set('timezone')} required />
        </Field>

        <h2>搜索引擎</h2>
        <label className="check">
          <input type="checkbox" checked={!!form.siteNoindex} onChange={(e) => setForm({ ...form, siteNoindex: e.target.checked })} /> 不让搜索引擎收录整个站点
        </label>
        <p className="muted small" style={{ marginTop: -4 }}>建站初期内容还没准备好、或者是内部站点时使用。开启后 robots.txt 会禁止抓取，所有页面带上 noindex。</p>

        <h2>页脚</h2>
        <Field label="页脚说明">
          <input value={form.footerText} onChange={set('footerText')} maxLength={500} />
        </Field>
        <Field label="ICP 备案号" hint="填写后显示在页脚并链接到工信部备案查询">
          <input value={form.icp} onChange={set('icp')} maxLength={100} />
        </Field>
        <button className="btn btn-primary" disabled={saving}>
          {saving ? '保存中…' : '保存设置'}
        </button>
      </form>

      <form className="panel form-narrow" onSubmit={changePassword}>
        <h2>修改密码</h2>
        <Field label="当前密码">
          <input type="password" value={pwd.current} onChange={(e) => setPwd({ ...pwd, current: e.target.value })} required autoComplete="current-password" />
        </Field>
        <Field label="新密码" hint="至少 8 位">
          <input type="password" value={pwd.next} onChange={(e) => setPwd({ ...pwd, next: e.target.value })} required minLength={8} autoComplete="new-password" />
        </Field>
        <Field label="确认新密码">
          <input type="password" value={pwd.confirm} onChange={(e) => setPwd({ ...pwd, confirm: e.target.value })} required autoComplete="new-password" />
        </Field>
        <button className="btn">修改密码</button>
      </form>
    </>
  );
}
