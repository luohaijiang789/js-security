import { useEffect } from 'react';
import { useUser } from '@/hooks/use-user';

export function ReactPage() {
  const refresh = useUser(7);
  useEffect(() => { refresh(); }, []);
  return <div>User</div>;
}
