export function getJson(path) {
  return fetch(path).then((res) => {
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return res.json();
  });
}
