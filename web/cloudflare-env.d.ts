interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results?: T[];
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<Record<string, unknown>>[]>;
}

interface R2HTTPMetadata {
  contentType?: string;
  cacheControl?: string;
}

interface R2ObjectBody {
  body: ReadableStream;
  httpEtag: string;
  httpMetadata?: R2HTTPMetadata;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: {
      httpMetadata?: R2HTTPMetadata;
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

declare module "cloudflare:workers" {
  export const env: {
    DB?: D1Database;
    VTH_SHARED_IMAGES?: R2Bucket;
    [key: string]: unknown;
  };
}
