import { fetchUser } from "./userApi.js";
export function fetchUserLabel(id) {
  return fetchUser(id).then((user) => `${user.name} <${user.email}>`);
}
