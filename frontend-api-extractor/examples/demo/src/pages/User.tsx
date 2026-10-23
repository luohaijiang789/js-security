import { loadUser } from '../services/users';

export function User() {
  loadUser(42);
  return <div>User</div>;
}
