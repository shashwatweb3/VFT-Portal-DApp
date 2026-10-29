import { HexString } from '@gear-js/api'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, UNITS, TOKEN, LP_DEAD, alice, connect, deploy, hexOf, loadSails, send, uploadCode, wasm, writeDeployed } from './lib.js'

const GAS = {
	gas_for_vft_init: 60_000_000_000n,
	gas_for_token_ops: 20_000_000_000n,
	gas_for_reply_deposit: 20_000_000_000n,
	reply_timeout: 100,
	gas_for_create_pair: 320_000_000_000n,
	gas_for_add_liquidity: 220_000_000_000n,
}

async function main() {
	const { api, parser } = await connect()
	const admin = await alice()
	const treasury = ('0x' + 'aa'.repeat(32)) as HexString
	console.log('node', api.runtimeVersion.specName.toString(), 'spec', api.runtimeVersion.specVersion.toString())

	// 1. wVARA stand-in (awesome-sails test app): constructor New(), then allocate the first shards.
	const wvaraSails = await loadSails(api, parser, 'wvara.idl')
	const DEPLOY_GAS = 400_000_000_000n
	// Fund the keeper account (Bob on the dev chain) so it is separate from the issuer.
	const wvara = await deploy(wvaraSails.ctors.New.fromCode(wasm('wvara.opt.wasm')), admin, DEPLOY_GAS)
	wvaraSails.setProgramId(wvara)
	await send(wvaraSails.services.VftExtension.functions.AllocateNextBalancesShard(), admin, 0n, 700_000_000_000n)
	await send(wvaraSails.services.VftExtension.functions.AllocateNextAllowancesShard(), admin, 0n, 700_000_000_000n)
	console.log('wVARA', wvara)

	// 2. RivrDEX: Pair code, then Factory.
	const rivrPairCode = await uploadCode(api, admin, wasm('rivr_pair.opt.wasm'))
	console.log('RivrDEX pair code', rivrPairCode)
	const factorySails = await loadSails(api, parser, 'rivr_factory.idl')
	const factoryConfig = {
		gas_for_token_ops: 20_000_000_000n,
		gas_for_reply_deposit: 20_000_000_000n,
		reply_timeout: 100,
		gas_for_full_tx: 100_000_000_000n,
		gas_for_pair_creation: 200_000_000_000n,
		gas_to_change_fee_to: 20_000_000_000n,
	}
	const rivrFactory = await deploy(
		factorySails.ctors.New.fromCode(
			wasm('rivr_factory.opt.wasm'),
			rivrPairCode,
			hexOf(admin),
			hexOf(admin),
			factoryConfig,
			treasury
		),
		admin,
		DEPLOY_GAS
	)
	console.log('RivrDEX factory', rivrFactory)

	// 3. Tokenator VFT code (ported build) and the launchpad.
	const vftCode = await uploadCode(api, admin, wasm('tokenator_vft.opt.wasm'))
	console.log('VFT code', vftCode)
	const lpSails = await loadSails(api, parser, 'launchpad.idl')
	const config = {
		vft_code_id: vftCode,
		addrs: { rivr_factory: rivrFactory, wvara, lp_dead: LP_DEAD, treasury },
		raise_target_vara: 600n * UNITS,
		graduation_fee_vara: 3n * UNITS,
		pair_creation_fee_vara: 1n * UNITS,
		total_supply: 1_000_000_000n * TOKEN,
		curve_supply: 800_000_000n * TOKEN,
		token_decimals: 18,
		fee_bps: 100,
		creator_fee_bps: 50,
		min_trade_vara: 1n * UNITS,
		min_free_balance: 5n * UNITS,
		graduation_timeout_blocks: 1_000,
		launch_cooldown_blocks: 20,
		gas: GAS,
	}
	const launchpad = await deploy(lpSails.ctors.New.fromCode(wasm('launchpad.opt.wasm'), config), admin, DEPLOY_GAS)
	lpSails.setProgramId(launchpad)
	await send(lpSails.services.Launchpad.functions.TopUpReserve(), admin, 50n * UNITS)
	const free = await lpSails.services.Launchpad.queries.FreeBalance().call()
	console.log('launchpad', launchpad, 'free balance', free)

	const deployed = {
		node: api.provider.endpoint as string,
		wvara,
		rivrFactory,
		rivrPairCode,
		vftCode,
		launchpad,
		treasury,
	}
	writeDeployed(deployed)
	writeFileSync(
		join(ROOT, '..', 'frontend', '.env.local'),
		[
			`NEXT_PUBLIC_NODE_ADDRESS=${deployed.node}`,
			`NEXT_PUBLIC_LAUNCHPAD_ADDRESS=${deployed.launchpad}`,
			`NEXT_PUBLIC_RIVRDEX_FACTORY=${deployed.rivrFactory}`,
			`NEXT_PUBLIC_WVARA_ADDRESS=${deployed.wvara}`,
			`NEXT_PUBLIC_RIVRDEX_APP=https://app.rivrdex.io`,
			`NEXT_PUBLIC_VOUCHER_API=http://localhost:4010`,
			`NEXT_PUBLIC_EXPLORER=http://localhost:4350/graphql`,
			'',
		].join('\n')
	)
	console.log('wrote deployed.json and frontend/.env.local')
	await api.disconnect()
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
