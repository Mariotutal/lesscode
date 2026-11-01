export interface Envelope<T> { data: T; requestId: string; }
export interface RawClient { get<T>(path: string): Promise<Envelope<T>>; }
export class SharedApiClient {
  constructor(private readonly raw: RawClient) {}
  async get<T>(path: string): Promise<T> {
    const clean = path.startsWith("/") ? path : `/${path}`;
    const env = await this.raw.get<T>(clean);
    return env.data;
  }
}
