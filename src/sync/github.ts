// Minimal GitHub Contents-API client — just enough to keep one JSON file in a private repo.
// No SDK: one file, two calls, small bundle, works offline-tolerantly.

const API = 'https://api.github.com'

export interface RepoRef {
  owner: string
  repo: string
  path: string
  branch?: string
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

/** "felipe/gastos-dados" or a full URL → {owner, repo}. Returns null when unparseable. */
export function parseRepo(input: string): { owner: string; repo: string } | null {
  const s = input.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '')
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(s)
  return m ? { owner: m[1], repo: m[2] } : null
}

export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

export function base64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function headers(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/** Turns a failed response into an error whose message the user can act on. */
async function fail(res: Response): Promise<never> {
  let detail = ''
  try {
    detail = ((await res.json()) as { message?: string }).message ?? ''
  } catch {
    /* body not JSON */
  }
  const hint =
    res.status === 401
      ? 'Token inválido ou expirado.'
      : res.status === 403
        ? 'Token sem permissão de escrita em Contents para este repositório.'
        : res.status === 404
          ? 'Repositório ou caminho não encontrado — confira o nome e se o token enxerga este repositório.'
          : res.status === 409
            ? 'O arquivo mudou no repositório desde a última leitura.'
            : undefined
  throw new GitHubError(detail || `HTTP ${res.status}`, res.status, hint)
}

export interface RemoteFile {
  text: string
  sha: string
}

/** Reads the file, or null when it does not exist yet. */
export async function getFile(ref: RepoRef, token: string, signal?: AbortSignal): Promise<RemoteFile | null> {
  const q = ref.branch ? `?ref=${encodeURIComponent(ref.branch)}` : ''
  const res = await fetch(`${API}/repos/${ref.owner}/${ref.repo}/contents/${encodeURIComponent(ref.path)}${q}`, {
    headers: headers(token),
    signal,
  })
  if (res.status === 404) return null
  if (!res.ok) await fail(res)
  const j = (await res.json()) as { content?: string; sha: string; encoding?: string }
  if (!j.content) throw new GitHubError('Arquivo grande demais para a API de conteúdo.', 422)
  return { text: base64ToUtf8(j.content), sha: j.sha }
}

/** Creates or replaces the file. Pass the sha from getFile when replacing. */
export async function putFile(
  ref: RepoRef,
  token: string,
  text: string,
  sha: string | undefined,
  message: string,
  signal?: AbortSignal,
): Promise<{ sha: string }> {
  const body: Record<string, unknown> = { message, content: utf8ToBase64(text) }
  if (sha) body.sha = sha
  if (ref.branch) body.branch = ref.branch
  const res = await fetch(`${API}/repos/${ref.owner}/${ref.repo}/contents/${encodeURIComponent(ref.path)}`, {
    method: 'PUT',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) await fail(res)
  const j = (await res.json()) as { content: { sha: string } }
  return { sha: j.content.sha }
}

/** Confirms the token can see the repo and that it is private. */
export async function checkRepo(ref: RepoRef, token: string, signal?: AbortSignal): Promise<{ private: boolean; permissions?: { push?: boolean } }> {
  const res = await fetch(`${API}/repos/${ref.owner}/${ref.repo}`, { headers: headers(token), signal })
  if (!res.ok) await fail(res)
  return (await res.json()) as { private: boolean; permissions?: { push?: boolean } }
}
