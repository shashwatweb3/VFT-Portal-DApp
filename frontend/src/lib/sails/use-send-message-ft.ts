import {
	Account,
	AlertContainerFactory,
	useAlert,
	useApi,
} from '@gear-js/react-hooks'
import { useCallback } from 'react'
import { SailsProgram } from './meme-ft'
import { TransactionBuilder } from 'sails-js'
import { useAuth } from '../hooks/use-auth'
import { assertWritesEnabled } from '../staging'

export enum MessageTypes {
	TRANSFER_TO_USERS = 'transferToUsers',
	MINT = 'mint',
	BURN = 'burn',
	TRANSFER = 'transfer',
}

type TransferToUsersPayload = {
	toUsers: `0x${string}`[]
	value: number | string
}

type MintPayload = {
	to: `0x${string}`
	value: number | string
}

type BurnPayload = {
	from: `0x${string}`
	value: number | string
}

type TransferPayload = {
	to: `0x${string}`
	value: number | string
}

const executeTransaction = async (
	transaction: TransactionBuilder<boolean>,
	account: Account,
	alert: AlertContainerFactory
) => {
	assertWritesEnabled()
	transaction.withAccount(account.address, { signer: account.signer })
	await transaction.calculateGas()

	const { msgId, blockHash, isFinalized } = await transaction.signAndSend()

	console.log(`msg included in block ${blockHash}. Message id: ${msgId}`)

	try {
		const result = await isFinalized

		if (!result) {
			alert.error('Unknown error occurred')
		}

		if (result) {
			alert.success('Successfully')
		}

		return result
	} catch (error) {
		console.error('Error response: ', error)
	}
}

export const useMessages = () => {
	const { api, isApiReady } = useApi()
	const { walletAccount: account } = useAuth()

	const alert = useAlert()

	const sendMessage = useCallback(
		async (
			messageType: string,
			programId: `0x${string}`,
			payload:
				| TransferToUsersPayload
				| MintPayload
				| BurnPayload
				| TransferPayload
		) => {
			if (!account) throw new Error('Account is not found')
			if (!api) throw new Error('Api is not ready')

			const program = new SailsProgram(api, programId)

			const executeMessage = async (
				transactionBuilder: TransactionBuilder<boolean>
			) => {
				const resultTransaction = await executeTransaction(
					transactionBuilder,
					account,
					alert
				)
				return resultTransaction
			}

			switch (messageType) {
				case MessageTypes.TRANSFER_TO_USERS:
					const transferToUsersPayload = payload as TransferToUsersPayload
					return executeMessage(
						await program.vft.transferToUsers(
							transferToUsersPayload.toUsers,
							transferToUsersPayload.value
						)
					)

				case MessageTypes.MINT:
					const mintPayload = payload as MintPayload
					return executeMessage(
						await program.vft.mint(mintPayload.to, mintPayload.value)
					)

				case MessageTypes.BURN:
					const burnPayload = payload as BurnPayload
					return executeMessage(
						await program.vft.burn(burnPayload.from, burnPayload.value)
					)

				case MessageTypes.TRANSFER:
					const transferPayload = payload as TransferPayload
					return executeMessage(
						await program.vft.transfer(
							transferPayload.to,
							transferPayload.value
						)
					)

				default:
					throw new Error(`Unsupported message type: ${messageType}`)
			}
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[api, isApiReady, account]
	)

	return sendMessage
}
