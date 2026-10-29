import {
	Token,
	type IToken,
} from '@/components/sections/tokens/single-token/single-token'
import { notFound } from 'next/navigation'
import { EXPLORER } from '@/lib/consts'
import { ChainToken } from '@/components/sections/tokens/curve/chain-token'
import { isValidHexString } from '@/lib/utils'
import { LAUNCHPAD } from '@/lib/consts'

async function getData(id: string) {
	const query = `query TokenById($id: String!) {
        coinById(id: $id) {
            description
            decimals
            distributed
            image
            id
            name
            symbol
			telegram
			twitter
			website
			discord
			tokenomics
			initialSupply
			maxSupply
			createdBy
			minted
			burned
			circulatingSupply
			holders
          }
      }`

	const options = {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ query, variables: { id } }),
	}

	const res = await fetch(EXPLORER.BACK, {
		...options,
		cache: 'no-store',
		next: { tags: ['balance', 'token'] },
	})

	if (!res.ok) {
		// This will activate the closest `error.js` Error Boundary
		throw new Error('Failed to fetch data')
	}

	return res.json()
}

type ITokenResponse = {
	data: {
		coinById: IToken
	}
}

export default async function Page(props: { params: Promise<{ id: string }> }) {
	const params = await props.params

	const { id } = params

	const curveEnabled = LAUNCHPAD.ADDRESS.length === 66
	// Without the launchpad, behave exactly as before (indexer errors surface to the error page).
	const data = (curveEnabled ? await getData(id).catch(() => null) : await getData(id)) as ITokenResponse | null

	if (!data || !data.data.coinById) {
		// Curve tokens exist on chain before the indexer has seen them.
		if (curveEnabled && isValidHexString(id) && id.length === 66) {
			return (
				<div className="container xl:max-w-[1440px]">
					<ChainToken id={id} />
				</div>
			)
		}
		return notFound()
	}

	const {
		data: { coinById },
	} = data

	return (
		<div className="container xl:max-w-[1440px]">
			<Token token={coinById} />
		</div>
	)
}
