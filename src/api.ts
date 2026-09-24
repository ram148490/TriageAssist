import type {
  CreateIntakeRequest,
  IntakeDetail,
  IntakeSubmission,
  OverrideRequest,
} from '../shared/types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = await res.json();
  if (!res.ok || body.success === false) {
    throw new Error(body.error || `Request to ${path} failed (${res.status}).`);
  }
  return body;
}

export function submitIntake(payload: CreateIntakeRequest) {
  return request<{ success: true; submission: IntakeSubmission }>('/api/intake', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchQueue() {
  return request<{ success: true; submissions: IntakeSubmission[] }>('/api/queue');
}

export function fetchSubmissionDetail(id: string) {
  return request<{ success: true; detail: IntakeDetail }>(`/api/queue/${id}`);
}

export function confirmSubmission(id: string, confirmedBy: string) {
  return request<{ success: true; submission: IntakeSubmission }>(`/api/queue/${id}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ confirmedBy }),
  });
}

export function overrideSubmission(id: string, payload: OverrideRequest) {
  return request<{ success: true; submission: IntakeSubmission }>(`/api/queue/${id}/override`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
