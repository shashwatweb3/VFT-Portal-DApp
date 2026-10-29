import { useEffect, useState } from 'react'
import { HexString } from '@gear-js/api'
import { EXPLORER, LAUNCHPAD } from '@/lib/consts'

const endpoint = EXPLORER.BACK

export interface Token {
	description: string
	decimals: number
	distributed: string
	image: string
	id: `0x${string}`
	name: string
	symbol: string
	initialSupply: string
	maxSupply: string
	admins: HexString[]
	holders: string
	circulatingSupply: string
	kind?: 'CLASSIC' | 'CURVE'
	curveLaunch?: { status: string; progressBps: number } | null
}

export type CoinFilter = 'all' | 'curve' | 'graduated' | 'classic'

/** Curve fields exist only on indexers that run the launchpad migration. */
const curveFieldsEnabled = () => LAUNCHPAD.ADDRESS.length === 66

const FILTER_WHERE: Record<CoinFilter, string> = {
	all: '',
	curve: 'kind_eq: CURVE, curveLaunch: { status_in: [TRADING, STUCK, READY, GRADUATING] }',
	graduated: 'curveLaunch: { status_eq: GRADUATED }',
	classic: 'kind_eq: CLASSIC',
}

export const useFetchCoins = (limit = 20, offset = 0, searchQuery = '', filter: CoinFilter = 'all') => {
	const [totalCoins, setTotalCoins] = useState(0)
	const [tokenData, setTokenData] = useState<Token[]>([])

	const normalizedSearchQuery = searchQuery.trim()
	const hasSearchQuery = normalizedSearchQuery.length > 0
	const searchDefinition = hasSearchQuery ? ', $search: String!' : ''
	const curve = curveFieldsEnabled()
	const conditions = [
		hasSearchQuery ? 'name_containsInsensitive: $search' : '',
		curve ? FILTER_WHERE[filter] : '',
	].filter(Boolean)
	const whereClause = conditions.length ? `, where: { ${conditions.join(', ')} }` : ''
	const curveFields = curve ? 'kind\n            curveLaunch { status progressBps }' : ''

	const query = `query FetchCoins($limit: Int!, $offset: Int!${searchDefinition}) {
        coins(limit: $limit, offset: $offset, orderBy: id_ASC${whereClause}) {
            description
            decimals
            distributed
            image
            id
            name
            symbol
            initialSupply
            maxSupply
            admins
            holders
            circulatingSupply
            ${curveFields}
        }
		coinsConnection(orderBy: id_ASC${whereClause}) {
			totalCount
		}
    }`
	const variables = hasSearchQuery
		? { limit, offset, search: normalizedSearchQuery }
		: { limit, offset }

	const options = {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ query, variables }),
	}

	useEffect(() => {
		const fetchCoins = async () => {
			try {
				const response = await fetch(endpoint, options)
				const { data } = await response.json()

				setTotalCoins(data.coinsConnection.totalCount)
				setTokenData(data.coins)
			} catch (error) {
				console.error('Failed to fetch coins:', error)
			}
		}

		fetchCoins()
	}, [searchQuery, limit, offset, filter])

	return { tokenData, totalCoins }
}
