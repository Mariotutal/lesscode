import { getJson } from "./client.js";
export function fetchUserLabel(id) {
  return getJson(`/users/${id}`).then((user) => `${user.name} <${user.email}>`);
}
