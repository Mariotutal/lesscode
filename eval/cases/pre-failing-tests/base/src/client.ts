export interface User { id: number; name: string; email: string; }
export interface HttpClient { get<T>(path: string): Promise<T>; }
