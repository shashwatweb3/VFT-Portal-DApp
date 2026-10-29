import { ColumnDef } from '@tanstack/react-table'
import { type AlertContainerFactory, useAlert } from '@gear-js/react-hooks'
import Image from 'next/image'

import {
	copyToClipboard,
	formatDistributedPercentage,
	formatUnits,
	prettyWord,
} from '@/lib/utils'
import { getSafeImageSrc } from '@/lib/sanitize'
import { Sprite } from '@/components/ui/sprite'
import { Token } from '@/lib/hooks/use-fetch-coins'

const handleCopyClickAddress = async (
	address: string,
	alert?: AlertContainerFactory
) => {
	await copyToClipboard({ value: address, alert })
}

export const coinsTypesTableColumns: ColumnDef<Token>[] = [
	{
		accessorFn: (row) => row.image,
		id: 'image',
		cell: (info) => (
			<>
				<Image
					src={getSafeImageSrc(info?.row?.original?.image)}
					key={info?.row?.original?.id}
					alt={''}
					width={60}
					height={60}
					unoptimized={true}
					className="size-15 rounded-full object-cover"
					onError={(e) => {
						const target = e.target as HTMLImageElement
						target.onerror = null // prevents looping
						target.src = '/images/no-token.png'
					}}
				/>
			</>
		),
		header: 'Image',
		enableSorting: false,
	},
	{
		accessorFn: (row) => row.name,
		id: 'name',
		cell: (info) => (
			<div className="flex h-full flex-col">{info.row.original.name}</div>
		),
		header: () => <div className="group flex items-center">Name</div>,
		enableSorting: false,
	},
	{
		accessorFn: (row) => row.symbol,
		id: 'symbol',
		cell: (info) => (
			<div className="text-center">{info.row.original.symbol}</div>
		),
		header: () => (
			<div className="group flex items-center justify-center">Symbol</div>
		),
		enableSorting: false,
	},
	{
		accessorFn: (row) => row.kind,
		id: 'status',
		cell: (info) => <CoinStatus token={info.row.original} />,
		header: () => (
			<div className="group flex items-center justify-center">Status</div>
		),
		enableSorting: false,
	},
	{
		accessorFn: (row) => row.initialSupply,
		id: 'initialSupply',
		cell: (info) => (
			<div className="text-right">
				{formatUnits(
					BigInt(info.row.original.initialSupply),
					info.row.original.decimals
				)}
			</div>
		),
		header: () => (
			<div className="group flex items-center justify-end">Initial Supply</div>
		),
		enableSorting: false,
	},
	{
		accessorFn: (row) => row.maxSupply,
		id: 'maxSupply',
		cell: (info) => (
			<div className="text-right">
				{formatUnits(
					BigInt(info.row.original.maxSupply),
					info.row.original.decimals
				)}
			</div>
		),
		header: () => (
			<div className="group flex items-center justify-end">Max Supply</div>
		),
		enableSorting: false,
	},
	{
		accessorFn: (row) => row.circulatingSupply,
		id: 'circulatingSupply',
		cell: (info) => (
			<div className="text-right">
				{formatUnits(
					BigInt(info.row.original.circulatingSupply),
					info.row.original.decimals
				)}
			</div>
		),
		header: () => (
			<div className="group flex items-center justify-center">Total Supply</div>
		),
		enableSorting: false,
	},
	{
		accessorFn: (row) => row.distributed,
		id: 'distributed',
		cell: (info) => (
			<div className="text-right">
				{formatDistributedPercentage(
					info.row.original.distributed,
					info.row.original.maxSupply
				)}
				%
			</div>
		),
		header: () => (
			<div className="group flex items-center justify-end">Distributed</div>
		),
		enableSorting: false,
	},
	{
		accessorFn: (row) => row.holders,
		id: 'holders',
		cell: (info) => (
			<div className="text-right">{info.row.original.holders}</div>
		),
		header: () => (
			<div className="group flex items-center justify-center">Holders</div>
		),
		enableSorting: false,
	},
	{
		accessorFn: (row) => row.id,
		id: 'address',
		cell: (info) => TokenId(info.row.original.id),
		header: () => (
			<div className="group flex items-center justify-center">Address</div>
		),
		enableSorting: false,
	},
]

function TokenId(id: `0x${string}`) {
	const alert = useAlert()

	return (
		<div className="flex items-center justify-center gap-3 text-center">
			{prettyWord(id)}
			<button
				onClick={(e) => {
					e.stopPropagation()
					handleCopyClickAddress(id, alert)
				}}
			>
				<Sprite name="copy" size={16} />
			</button>
		</div>
	)
}

/** "On curve" + mini progress bar, "Graduated", or "Classic". */
export function CoinStatus({ token }: { token: Token }) {
	const launch = token.curveLaunch
	if (token.kind !== 'CURVE' || !launch) {
		return (
			<div className="flex justify-center">
				<span className="font-ps2p w-max rounded-sm border border-[#2E3B55] p-1 text-[8px] uppercase text-[#FDFDFD]/80">
					Classic
				</span>
			</div>
		)
	}
	const OTHER: Record<string, string> = {
		READY: 'Curve complete',
		GRADUATING: 'Graduating',
		FAILED: 'Paused',
		ABORTED: 'Sell-back',
	}
	if (OTHER[launch.status]) {
		return (
			<div className="flex justify-center">
				<span className="font-ps2p w-max rounded-sm bg-white p-1 text-[8px] uppercase text-black">
					{OTHER[launch.status]}
				</span>
			</div>
		)
	}
	if (launch.status === 'GRADUATED') {
		return (
			<div className="flex justify-center">
				<span className="font-ps2p bg-primary w-max rounded-sm p-1 text-[8px] uppercase text-black">
					Graduated
				</span>
			</div>
		)
	}
	const pct = Math.min(100, launch.progressBps / 100)
	return (
		<div className="flex flex-col items-center gap-1">
			<span className="font-ps2p w-max rounded-sm bg-white p-1 text-[8px] uppercase text-black">
				On curve
			</span>
			<div className="h-1.5 w-20 overflow-hidden rounded-full bg-[#2E3B55]">
				<div className="bg-primary h-full rounded-full" style={{ width: `${pct}%` }} />
			</div>
		</div>
	)
}
