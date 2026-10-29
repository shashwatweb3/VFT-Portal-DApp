'use client'

import { cn } from '@/lib/utils'

type Option<T extends string> = { value: T; label: string; hint?: string; disabled?: boolean }

type Props<T extends string> = {
	value: T
	onChange: (value: T) => void
	options: Option<T>[]
	className?: string
	disabled?: boolean
}

/** Two-to-four way toggle in the create wizard's button vocabulary (lime selected, dark outline otherwise). */
export function SegmentedControl<T extends string>({ value, onChange, options, className, disabled }: Props<T>) {
	return (
		<div
			role="tablist"
			className={cn('grid gap-3', options.length === 2 ? 'grid-cols-2' : options.length === 3 ? 'grid-cols-3' : 'grid-cols-4 max-sm:grid-cols-2', className)}
		>
			{options.map((option) => {
				const selected = option.value === value
				return (
					<button
						key={option.value}
						type="button"
						role="tab"
						aria-selected={selected}
						disabled={disabled || option.disabled}
						onClick={() => onChange(option.value)}
						className={cn(
							'font-ps2p flex flex-col items-center justify-center gap-1 rounded-lg px-3 py-3 text-[12px] leading-none transition disabled:opacity-50 max-sm:text-[10px]',
							selected
								? 'bg-primary text-[#242424]'
								: 'border-2 border-[#2E3B55] bg-[#0F1B34] text-[#FDFDFD] hocus:border-primary'
						)}
					>
						<span>{option.label}</span>
						{option.hint && (
							<span
								className={cn(
									'font-poppins text-[11px] leading-none',
									selected ? 'text-[#242424]/70' : 'text-[#A4AAB6]'
								)}
							>
								{option.hint}
							</span>
						)}
					</button>
				)
			})}
		</div>
	)
}
