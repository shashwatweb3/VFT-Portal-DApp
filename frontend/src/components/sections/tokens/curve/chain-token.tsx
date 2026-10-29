'use client'

import { useQuery } from '@tanstack/react-query'
import { useApi } from '@gear-js/react-hooks'
import { HexString } from '@gear-js/api'
import { ZERO_ADDRESS } from 'sails-js'

import { BackButton } from '@/components/common/back-button'
import { SailsProgram as VftProgram } from '@/lib/sails/meme-ft'
import { CurveTokenView } from './curve-token-view'

/**
 * Token page for a curve token the indexer has not seen yet: header straight from the VFT,
 * curve block straight from the launchpad.
 */
export function ChainToken({ id }: { id: HexString }) {
	const { api, isApiReady } = useApi()
	const { data: meta, isLoading, isError } = useQuery({
		queryKey: ['vft-meta', id],
		enabled: isApiReady && !!api,
		staleTime: 60_000,
		queryFn: async () => {
			const vft = new VftProgram(api!, id).vft
			const q = <T,>(b: { withAddress: (a: string) => { call: () => Promise<T> } }) =>
				b.withAddress(ZERO_ADDRESS).call()
			const [name, symbol, description, links] = await Promise.all([
				q(vft.name()),
				q(vft.symbol()),
				q(vft.description()),
				q(vft.externalLinks()),
			])
			return { name, symbol, description, image: links.image }
		},
	})

	if (isError) {
		return (
			<section className="my-10 flex flex-col gap-4 font-poppins">
				<BackButton />
				<p className="text-[#FDFDFD]/80">This address is not a Tokenator token, or the network is unreachable.</p>
			</section>
		)
	}
	if (isLoading || !meta) {
		return (
			<section className="my-10 flex animate-pulse flex-col gap-8">
				<div className="h-10 w-28 rounded-lg bg-[#1D2C4B]" />
				<div className="h-40 rounded-lg bg-[#1D2C4B]" />
			</section>
		)
	}

	return <CurveTokenView token={id} meta={meta} />
}
