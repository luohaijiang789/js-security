import { loadUser } from '@/services';

export function useUser(id: number) {
  return () => loadUser(id);
}
