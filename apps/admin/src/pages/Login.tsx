import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useStatus } from '../App';
import { Field } from '../components/ui';

export function Login() {
  const { status, reload } = useStatus();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('POST', '/login', { username, password });
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>{status.site.name}</h1>
        <p className="muted">登录管理后台</p>
        <Field label="用户名">
          <input value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus autoComplete="username" />
        </Field>
        <Field label="密码">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </Field>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
