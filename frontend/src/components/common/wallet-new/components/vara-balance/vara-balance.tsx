'use client'

import {
	useAccount,
	useApi,
	useBalanceFormat,
	useDeriveBalancesAll,
} from '@gear-js/react-hooks'
import styles from './vara-balance.module.scss'
import { cn } from '@/lib/utils'

type Props = {
	className?: string
}

export function VaraBalance({ className }: Props) {
	const { account } = useAccount()
	const { isApiReady } = useApi()
	const { isAccountReady } = useAccount()

	const { getFormattedBalance } = useBalanceFormat()
	const { data: balances } = useDeriveBalancesAll({
		address: account?.decodedAddress,
		watch: true,
	})
	const balance =
		isApiReady && balances
			? getFormattedBalance(
					(balances.transferable || balances.availableBalance).toString()
				)
			: undefined

	return isAccountReady && balance ? (
		<div className={cn(styles.balance, className)}>
			<p className={styles.text}>
				<span className={styles.value}>{balance.value}</span>
				<span className={styles.unit}>VARA</span>
			</p>
		</div>
	) : null
}
