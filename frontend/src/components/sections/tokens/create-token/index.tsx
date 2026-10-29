'use client'

import { atom, useAtom } from 'jotai'
import React, { useEffect } from 'react'
import { CreateForm } from './form'
import { ConfirmCreate } from './confirm'
import { ICreateTokenForm } from './schema'

type StepType = 'create' | 'confirm'
export const stepAtom = atom<StepType>('create')

export const dataTokenAtom = atom<ICreateTokenForm | undefined>(undefined)

export type LaunchMode = 'curve' | 'classic'
export const launchModeAtom = atom<LaunchMode>('curve')
export const createdTokenAtom = atom<`0x${string}` | undefined>(undefined)

export const CreateToken = () => {
	const [step, setStep] = useAtom(stepAtom)
	const [dataToken] = useAtom(dataTokenAtom)

	useEffect(() => {
		setStep('create')
	}, [])

	return step === 'create' ? <CreateForm /> : <ConfirmCreate data={dataToken} />
}
