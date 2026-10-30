export interface User { id: number; name: string; email: string; }
export interface HttpClient { get<T>(path: string): Promise<T>; }
export class FetchHttpClient implements HttpClient {
  async get<T>(path: string): Promise<T> {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return (await res.json()) as T;
  }
}
