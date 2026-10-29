import Identicon from '@polkadot/react-identicon'
import cx from 'clsx'

import styles from './account-button.module.scss'
import { prettyWord } from '@/lib/utils'

type Props = {
	name: string | undefined
	address: string | undefined
	className?: string
	onClick: () => void
}

function AccountButton({ address, name, className, onClick }: Props) {
	return (
		<button
			type="button"
			color="dark"
			className={cx(styles.button, className)}
			onClick={onClick}
			title={name ? `${name} · ${address}` : address}
		>
			<Identicon value={address} size={16} theme="polkadot" />
			<span>{address ? prettyWord(address, 4) : name}</span>
		</button>
	)
}

export { AccountButton }
