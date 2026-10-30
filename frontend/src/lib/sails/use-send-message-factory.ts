import {
	Account,
	AlertContainerFactory,
	useAlert,
	useApi,
} from '@gear-js/react-hooks'
import { CONTRACT_ADDRESS } from '../consts'
import { useCallback } from 'react'
import { SailsProgram, Init } from './meme-factory'
import { ActorId, TransactionBuilder } from 'sails-js'
import { useAuth } from '../hooks/use-auth'
import { assertWritesEnabled } from '../staging'

export enum MessageTypes {
	CREATE_FUNGIBLE_PROGRAM = 'createFungibleProgram',
}

const executeTransaction = async (
	transaction: TransactionBuilder<ActorId>,
	account: Account,
	alert: AlertContainerFactory
) => {
	assertWritesEnabled()
	transaction.withAccount(account.address, { signer: account.signer })
	transaction.withValue(BigInt(1e12))
	await transaction.calculateGas(true, 10)

	const { msgId, blockHash, response } = await transaction.signAndSend()

	console.log(`msg included in block ${blockHash}. Message id: ${msgId}`)

	const result = await response()

	alert.success('Successfully')

	return result
}

export const useMessages = () => {
	const { api, isApiReady } = useApi()
	const { walletAccount: account } = useAuth()
	const alert = useAlert()

	const sendMessage = useCallback(
		async (messageType: string, payload: Init) => {
			if (!account) throw new Error('Account is not found')
			if (!api) throw new Error('Api is not ready')

			const programId = CONTRACT_ADDRESS.ADDRESS

			const program = new SailsProgram(api, programId)

			const executeMessage = async (
				transactionBuilder: TransactionBuilder<ActorId>
			) => {
				const resultTransaction = await executeTransaction(
					transactionBuilder,
					account,
					alert
				)
				return resultTransaction
			}

			switch (messageType) {
				case MessageTypes.CREATE_FUNGIBLE_PROGRAM:
					return executeMessage(
						program.memeFactory.createFungibleProgram(payload)
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
