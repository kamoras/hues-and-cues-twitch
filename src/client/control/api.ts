import type {
  ApiErrorResponse,
  CreateRoomRequest,
  CreateRoomResponse,
  RoomInfoResponse,
} from '../../shared/protocol.js';

export class ApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  const body = (await response.json().catch(() => null)) as T | ApiErrorResponse | null;
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? body.error
        : `Request failed (${String(response.status)})`;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

export const api = {
  getConfig: () => request<{ accessCodeRequired: boolean }>('/api/config'),
  createRoom: (body: CreateRoomRequest) =>
    request<CreateRoomResponse>('/api/rooms', { method: 'POST', body: JSON.stringify(body) }),
  getRoom: (roomId: string) =>
    request<RoomInfoResponse>(`/api/rooms/${encodeURIComponent(roomId)}`),
};
