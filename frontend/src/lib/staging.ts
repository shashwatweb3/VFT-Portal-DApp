export const BETA_HOST = 'stg.tokenator.club'

export const STAGING_READ_ONLY_MESSAGE =
	'Tokenator beta is read-only. Transactions are disabled while staging uses production contracts.'

export const UNVERIFIED_ENVIRONMENT_MESSAGE =
	'Transactions are disabled because this environment could not be verified as production.'

const PRODUCTION_HOSTS = new Set(['tokenator.club', 'www.tokenator.club'])
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])
const STAGING_HOSTS = new Set([BETA_HOST, 'tokenator-stg.vercel.app'])

type HeaderReader = { get(name: string): string | null }

export const normalizeHost = (value: string | null | undefined) => {
	const host = value?.trim().toLowerCase().replace(/\.$/, '') ?? ''
	if (!host) return ''
	if (host.startsWith('[')) {
		const end = host.indexOf(']')
		return end === -1 ? host : host.slice(1, end)
	}
	const parts = host.split(':')
	return parts.length === 2 ? parts[0] : host
}

export const getRequestHost = (headers: HeaderReader) =>
	normalizeHost(
		headers.get('x-forwarded-host')?.split(',')[0] ?? headers.get('host')
	)

export const isStagingHost = (value: string | null | undefined) => {
	const host = normalizeHost(value)
	return STAGING_HOSTS.has(host) || host.startsWith('tokenator-stg-')
}

export const isWriteAllowedHost = (value: string | null | undefined) => {
	const host = normalizeHost(value)
	if (!host || isStagingHost(host)) return false
	return (
		PRODUCTION_HOSTS.has(host) ||
		LOCAL_HOSTS.has(host) ||
		host.endsWith('.vercel.app')
	)
}

const getClientHost = () => {
	if (typeof window === 'undefined') return ''
	try {
		return normalizeHost(window.location.hostname)
	} catch {
		return ''
	}
}

export const assertWritesEnabled = () => {
	const host = getClientHost()
	if (isStagingHost(host)) {
		throw new Error(STAGING_READ_ONLY_MESSAGE)
	}
	if (!isWriteAllowedHost(host)) {
		throw new Error(UNVERIFIED_ENVIRONMENT_MESSAGE)
	}
}
