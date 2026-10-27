import { get } from '../transport/request';

export const loadUser = (id: number) => get(`/users/${id}`, { active: true });
