import { EXPLORER } from '@/lib/consts'

/** Shared indexer helpers for the curve components. */
export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
	const res = await fetch(EXPLORER.BACK, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ query, variables }),
	})
	if (!res.ok) throw new Error(`Explorer responded ${res.status}`)
	const json = (await res.json()) as { data?: T; errors?: { message: string }[] }
	if (json.errors?.length || !json.data) throw new Error(json.errors?.[0]?.message ?? 'Explorer error')
	return json.data
}

export function timeAgo(iso: string) {
	const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000))
	if (s < 60) return `${s}s ago`
	if (s < 3600) return `${Math.floor(s / 60)}m ago`
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`
	return `${Math.floor(s / 86400)}d ago`
}
