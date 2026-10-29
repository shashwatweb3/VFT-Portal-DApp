import { AboutCreateSlider } from '@/components/sections/homepage/about-create-slider'
import { CURVE_ENABLED } from '@/lib/consts'

type Props = {
	className?: string
}

export function AboutCreate({}: Props) {
	return (
		<section className="-mb-30 mt-25 px-4 sm:-mb-17.5 lg:mt-50">
			<h2 className="text-center text-[22px] leading-none text-primary sm:text-[32px]">
				{CURVE_ENABLED ? 'How Tokenator 2.0 works' : 'How to create your token'}
			</h2>
			<p className="mx-auto mt-5 max-w-[420px] text-center font-silkscreen text-[16px] leading-normal sm:mt-6 sm:text-[20px]">
				{CURVE_ENABLED
					? 'Launch on a bonding curve. When the curve sells out, anyone can trigger graduation and your token lists on RivrDEX.'
					: 'Deploy a VFT on Vara Network in three simple steps - free and instant.'}
			</p>
			<div className="-mx-4 mt-6 sm:mt-15">
				<AboutCreateSlider />
			</div>
		</section>
	)
}
