import { getJson } from "./client.js";
/** Single-use: only fetchUserLabel calls this. */
export function fetchUser(id) {
  return getJson(`/users/${id}`);
}
