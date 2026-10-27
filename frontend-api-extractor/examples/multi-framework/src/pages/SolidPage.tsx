import { createResource } from 'solid-js';
import { loadUser } from '@/services';

export const SolidPage = () => {
  createResource(() => loadUser(11));
  return <div>Solid user</div>;
};
