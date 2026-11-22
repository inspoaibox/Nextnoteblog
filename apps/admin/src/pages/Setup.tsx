import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useStatus } from '../App';
import { Field } from '../components/ui';

export function Setup() {
  const { reload } = useStatus();
  const navigate = useNavigate();
  const [form, setForm] = useState({ siteName: '', username: '', password: '', confirm: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) return setError('两次输入的密码不一致');
    setBusy(true);
    setError('');
    try {
      const { confirm: _confirm, ...body } = form;
      await api('POST', '/setup', body);
      await reload();
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>安装向导</h1>
        <p className="muted">创建站点和管理员账号，完成后即可开始写作。</p>
        <Field label="站点名称">
          <input value={form.siteName} onChange={set('siteName')} required maxLength={100} autoFocus />
        </Field>
        <Field label="管理员用户名" hint="3–32 位字母、数字或 _ . -">
          <input value={form.username} onChange={set('username')} required autoComplete="username" />
        </Field>
        <Field label="密码" hint="至少 8 位">
          <input type="password" value={form.password} onChange={set('password')} required minLength={8} autoComplete="new-password" />
        </Field>
        <Field label="确认密码">
          <input type="password" value={form.confirm} onChange={set('confirm')} required autoComplete="new-password" />
        </Field>
        <Field label="时区" hint="用于前台日期显示">
          <input value={form.timezone} onChange={set('timezone')} required />
        </Field>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? '正在创建…' : '完成安装'}
        </button>
      </form>
    </div>
  );
}
