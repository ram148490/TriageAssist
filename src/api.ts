import type {
  CreateIntakeRequest,
  IntakeDetail,
  IntakeSubmission,
  OverrideRequest,
  StaffUser,
} from '../shared/types';

// The server gives the AI classifier up to 10s before falling back, then writes to the DB,
// so allow comfortably longer than that before giving up on a request.
const REQUEST_TIMEOUT_MS = 30_000;

let unauthorizedHandler: (() => void) | null = null;

/** Registers what to do when the server says the session is gone (expired, signed out elsewhere, server restarted). */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

async function request<T>(path: string, init?: RequestInit, opts: { expectAuth?: boolean } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> | undefined) },
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error('The server took too long to respond. Refresh the queue to check whether your change went through.');
    }
    throw new Error('Cannot reach the server. Check your connection and try again.');
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body (proxy error page, crashed server, ...). Handled below.
  }

  // A 401 anywhere except the sign-in form itself means the session ended: drop back to sign-in
  // (which also clears patient data from the screen).
  if (res.status === 401 && opts.expectAuth !== false) {
    unauthorizedHandler?.();
    throw new Error('Your session has ended. Please sign in again.');
  }

  if (!res.ok || !body || body.success === false) {
    throw new Error(body?.error || `Unexpected response from the server (status ${res.status}).`);
  }
  return body;
}

export function login(username: string, password: string) {
  return request<{ success: true; user: StaffUser }>(
    '/api/auth/login',
    { method: 'POST', body: JSON.stringify({ username, password }) },
    { expectAuth: false },
  );
}

export function logout() {
  return request<{ success: true }>('/api/auth/logout', { method: 'POST' }, { expectAuth: false });
}

/** Resolves to the signed-in user, or null when nobody is signed in. */
export async function fetchMe(): Promise<StaffUser | null> {
  try {
    const { user } = await request<{ success: true; user: StaffUser }>('/api/auth/me', undefined, { expectAuth: false });
    return user;
  } catch {
    return null;
  }
}

export function submitIntake(payload: CreateIntakeRequest) {
  return request<{ success: true; submission: IntakeSubmission; classificationUnavailable: boolean }>('/api/intake', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * `background: true` marks an automatic poll. The server then does not count it as user
 * activity, so polling can't keep an unattended workstation signed in past the idle timeout.
 */
export function fetchQueue(opts: { background?: boolean } = {}) {
  return request<{ success: true; submissions: IntakeSubmission[] }>('/api/queue', {
    headers: opts.background ? { 'X-Background-Poll': '1' } : undefined,
  });
}

export function fetchSubmissionDetail(id: string) {
  return request<{ success: true; detail: IntakeDetail }>(`/api/queue/${id}`);
}

// The server records the signed-in user as the reviewer; no name is sent.
export function confirmSubmission(id: string) {
  return request<{ success: true; submission: IntakeSubmission }>(`/api/queue/${id}/confirm`, { method: 'POST' });
}

export function overrideSubmission(id: string, payload: OverrideRequest) {
  return request<{ success: true; submission: IntakeSubmission }>(`/api/queue/${id}/override`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
