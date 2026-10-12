import { useEffect, useState } from 'react';
import type { User } from '../../../web/projects/shared/src/api-types';
import { api } from './api';
import { Login } from './Login';
import { Main } from './MainView';

export function App() {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    api.onSessionEnd = () => setUser(null);
    api.init().then((u) => {
      setUser(u);
      setReady(true);
    });
  }, []);

  if (!ready) return <div className="center"><div className="spinner" aria-label="Loading" /></div>;
  return user ? <Main user={user} onLogout={() => setUser(null)} /> : <Login onLogin={setUser} />;
}
