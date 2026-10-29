import { HexString } from '@gear-js/api'
import { ZERO_ADDRESS } from 'sails-js'
import { UNITS, TOKEN, LP_DEAD, alice, bob, charlie, connect, ensureFunded, fmtTokens, fmtVara, hexOf, loadSails, readDeployed, send } from './lib.js'

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`ASSERT: ${msg}`)
}

async function main() {
	const d = readDeployed()
	const { api, parser } = await connect()
	const creator = await alice()
	const buyer = await bob()
	const sniper = await charlie()
	await ensureFunded(api, creator, buyer, 5_000n * UNITS)
	await ensureFunded(api, creator, sniper, 5_000n * UNITS)
	const lp = await loadSails(api, parser, 'launchpad.idl', d.launchpad)
	const factory = await loadSails(api, parser, 'rivr_factory.idl', d.rivrFactory)
	const Launchpad = lp.services.Launchpad

	// 1. Launch with a creator first buy of 10 VARA (voucher-less on devnet; creator pays gas).
	const name = `Smoke ${Date.now().toString(36)}`
	const meta = {
		name,
		symbol: 'SMK',
		description: 'devnet smoke token',
		image: 'ipfs://smoke',
		website: null,
		telegram: null,
		twitter: null,
		discord: null,
		tokenomics: null,
	}
	const termsHash = Array.from({ length: 32 }, () => 7)
	const launched: any = await send(Launchpad.functions.Launch(meta, termsHash, 0n), creator, 10n * UNITS)
	assert(launched.ok, `launch failed: ${JSON.stringify(launched)}`)
	const token = launched.ok as HexString
	console.log('launched', token)
	const vft = await loadSails(api, parser, 'tokenator_vft.idl', token)
	const q = (fn: string, ...args: unknown[]) => vft.services.Vft.queries[fn](...args).withAddress(ZERO_ADDRESS).call()
	assert(BigInt(await q('BalanceOf', hexOf(creator))) > 0n, 'creator got first-buy tokens')
	for (const role of ['Admins', 'Minters', 'Burners']) {
		const holders = (await q(role)) as string[]
		assert(holders.length === 1 && holders[0] === d.launchpad, `${role} == [launchpad]`)
	}

	// 2. Buyer buys 300 VARA, then sells a quarter back.
	const quote: any = await Launchpad.queries.QuoteBuy(token, 300n * UNITS).call()
	const bought: any = await send(Launchpad.functions.Buy(token, 0n, 4_294_967_295), buyer, 300n * UNITS)
	assert(bought.ok, `buy failed: ${JSON.stringify(bought)}`)
	assert(BigInt(bought.ok.tokens) === BigInt(quote.amount_out), 'buy matches quote')
	console.log('bought', fmtTokens(BigInt(bought.ok.tokens)), 'for', fmtVara(300n * UNITS))
	const quarter = BigInt(bought.ok.tokens) / 4n
	await send(vft.services.Vft.functions.Approve(d.launchpad, quarter), buyer)
	const sold: any = await send(Launchpad.functions.Sell(token, quarter, 0n, 4_294_967_295), buyer)
	assert(sold.ok, `sell failed: ${JSON.stringify(sold)}`)
	console.log('sold', fmtTokens(quarter), 'for', fmtVara(BigInt(sold.ok.vara)))

	// 3. A sniper completes the curve with an overpayment; excess is refunded, launch goes Ready.
	const before = (await api.balance.findOut(sniper.address)).toBigInt()
	const big: any = await send(Launchpad.functions.Buy(token, 0n, 4_294_967_295), sniper, 1_000n * UNITS)
	assert(big.ok?.completed_curve, 'last buy completes the curve')
	const after = (await api.balance.findOut(sniper.address)).toBigInt()
	console.log('curve completed; sniper net spend', fmtVara(before - after))
	let info: any = await Launchpad.queries.LaunchInfo(token).call()
	assert(info.state === 'Ready', `state Ready, got ${info.state}`)
	const poolVara = BigInt(info.pool_vara)
	const liabilitiesReady = BigInt(await Launchpad.queries.TotalLiabilities().call())

	// 4. Drive graduation; the voucher-server keeper may be doing the same, so a lost race is fine.
	const steps: string[] = []
	for (let i = 0; i < 60; i++) {
		const now: any = await Launchpad.queries.LaunchInfo(token).call()
		if (now.state === 'Graduated') break
		try {
			const r: any = await send(Launchpad.functions.Graduate(token), creator, 0n, 400_000_000_000n)
			if (r.ok) steps.push(r.ok)
		} catch {
			await new Promise((res) => setTimeout(res, 3000))
		}
	}
	console.log('graduation steps sent by this script', steps.join(' -> ') || '(keeper did them)')
	info = await Launchpad.queries.LaunchInfo(token).call()
	assert(info.state === 'Graduated', `state Graduated, got ${info.state}`)
	assert(info.roles_renounced, 'roles renounced')

	// 5. On-chain truth: the pair exists, holds the pool, LP sits at the dead address, roles gone.
	const pair = (await factory.services.Factory.queries.GetPair(d.wvara, token).call()) as HexString
	assert(pair === info.pair && !/^0x0+$/.test(pair), 'pair registered in factory')
	const pairSails = await loadSails(api, parser, 'rivr_pair.idl', pair)
	const [t0] = (await pairSails.services.Pair.queries.GetTokens().call()) as [string, string]
	const [r0, r1] = (await pairSails.services.Pair.queries.GetReserves().call()) as [string, string]
	const [wReserve, tReserve] = t0 === d.wvara ? [BigInt(r0), BigInt(r1)] : [BigInt(r1), BigInt(r0)]
	assert(wReserve === poolVara, `pool wVARA ${wReserve} == ${poolVara}`)
	assert(tReserve === 200_000_000n * TOKEN, 'pool holds 200M tokens')
	const lpDead = BigInt(await pairSails.services.Vft.queries.BalanceOf(LP_DEAD).call())
	const lpLaunchpad = BigInt(await pairSails.services.Vft.queries.BalanceOf(d.launchpad).call())
	assert(lpDead > 0n && lpLaunchpad === 0n, 'LP burned to dead address')
	for (const role of ['Admins', 'Minters', 'Burners']) {
		assert(((await q(role)) as string[]).length === 0, `${role} empty after graduation`)
	}
	// Liabilities are program-wide (other launches may be live), so check this launch's delta.
	const liabilities = BigInt(await Launchpad.queries.TotalLiabilities().call())
	assert(BigInt(info.escrow) === 0n, 'escrow fully settled')
	assert(liabilities === liabilitiesReady - poolVara - 1n * UNITS, `liabilities dropped by pool VARA + pair fee (${liabilities} vs ${liabilitiesReady})`)
	const programBalance = (await api.balance.findOut(d.launchpad)).toBigInt()
	assert(programBalance >= liabilities, 'program stays solvent')
	console.log('pool', fmtVara(wReserve), '+', fmtTokens(tReserve), '| LP burned', lpDead.toString(), '| this launch fees', fmtVara(BigInt(info.creator_fees) + BigInt(info.protocol_fees)))
	console.log('SMOKE OK')
	await api.disconnect()
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
