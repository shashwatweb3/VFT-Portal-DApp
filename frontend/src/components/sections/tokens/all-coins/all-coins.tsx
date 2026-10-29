'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
	PaginationState,
	getCoreRowModel,
	getFilteredRowModel,
	getPaginationRowModel,
	getSortedRowModel,
	useReactTable,
} from '@tanstack/react-table'

import { DataTable } from '@/components/common/data-table'
import { BackButton } from '@/components/common/back-button'
import { coinsTypesTableColumns } from './table.columns'
import { useFetchCoins, type CoinFilter } from '@/lib/hooks/use-fetch-coins'
import { SegmentedControl } from '@/components/sections/tokens/curve/segmented-control'
import { launchpadEnabled } from '@/lib/sails/use-launchpad'
import { CurveBoard } from '@/components/sections/tokens/curve/curve-board'
import { fuzzyFilter } from '@/components/common/data-table/fuzzy-filter'

export const AllCoins = () => {
	const router = useRouter()

	const [globalFilter, setGlobalFilter] = useState('')
	const [filter, setFilter] = useState<CoinFilter>('all')

	// `/tokens?filter=curve` deep link from the menus (read once, client side).
	useEffect(() => {
		const param = new URLSearchParams(window.location.search).get('filter')
		if (param === 'curve' || param === 'graduated' || param === 'classic') setFilter(param)
	}, [])
	const [{ pageIndex, pageSize }, setPagination] = useState<PaginationState>({
		pageIndex: 0,
		pageSize: 10,
	})

	const pagination = useMemo(
		() => ({
			pageIndex,
			pageSize,
		}),
		[pageIndex, pageSize]
	)

	const { tokenData, totalCoins } = useFetchCoins(
		pagination.pageSize,
		pagination.pageIndex * pagination.pageSize,
		globalFilter,
		filter
	)

	useEffect(() => {
		setPagination((p) => ({ pageIndex: 0, pageSize: p.pageSize }))
	}, [filter])

	useEffect(() => {
		if (globalFilter) {
			setPagination({ pageIndex: 0, pageSize: pagination.pageSize })
		}
	}, [globalFilter, totalCoins])

	const table = useReactTable({
		data: tokenData,
		columns: launchpadEnabled() ? coinsTypesTableColumns : coinsTypesTableColumns.filter((c) => c.id !== 'status'),
		getCoreRowModel: getCoreRowModel(),
		filterFns: {
			fuzzy: fuzzyFilter,
		},
		state: {
			globalFilter,
			pagination,
		},
		pageCount: Math.ceil(totalCoins / pagination.pageSize) ?? 0,
		onGlobalFilterChange: setGlobalFilter,
		globalFilterFn: fuzzyFilter,
		onPaginationChange: setPagination,
		getSortedRowModel: getSortedRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		manualPagination: true,
	})

	const handleRowClick = (row: any) => {
		router.push(`/tokens/${row.original.id}`)
	}

	return (
		<div className="ju my-10 flex flex-col gap-8">
			<BackButton />
			{launchpadEnabled() && <CurveBoard />}
			{launchpadEnabled() && (
				<SegmentedControl<CoinFilter>
					value={filter}
					onChange={setFilter}
					options={[
						{ value: 'all', label: 'All' },
						{ value: 'curve', label: 'On curve' },
						{ value: 'graduated', label: 'Graduated' },
						{ value: 'classic', label: 'Classic' },
					]}
				/>
			)}
			<DataTable
				nameTable="All Tokens"
				table={table}
				onRowClick={handleRowClick}
				setGlobalFilter={setGlobalFilter}
				globalFilter={globalFilter}
				total={totalCoins}
				limit={pagination.pageSize}
			/>
		</div>
	)
}
