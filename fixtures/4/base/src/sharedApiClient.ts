export interface RawClient { get<T>(path: string): Promise<T>; }
interface Envelope<T> { data: T; requestId: string; }
/**
 * Looks like a thin wrapper, but is load-bearing: it unwraps the API
 * envelope and normalises paths. Two features depend on both behaviours.
 */
export class SharedApiClient {
  constructor(private readonly raw: RawClient) {}
  async get<T>(path: string): Promise<T> {
    const normalised = path.startsWith("/") ? path : `/${path}`;
    const envelope = await this.raw.get<Envelope<T>>(normalised);
    return envelope.data;
  }
}
