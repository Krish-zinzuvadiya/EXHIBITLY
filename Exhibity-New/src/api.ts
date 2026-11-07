export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isForm = options.body instanceof FormData
  const response = await fetch(`/api${path}`, { credentials: 'include', ...options, headers: { ...(isForm ? {} : { 'Content-Type': 'application/json' }), ...options.headers } })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(body?.message || `Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}
export const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
