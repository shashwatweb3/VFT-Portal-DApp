/* eslint-disable */

import { GearApi, BaseGearProgram, HexString } from '@gear-js/api';
import { TypeRegistry } from '@polkadot/types';
import { TransactionBuilder, ActorId, CodeId, QueryBuilder, getServiceNamePrefix, getFnNamePrefix, ZERO_ADDRESS } from 'sails-js';

export class LaunchpadProgram {
  public readonly registry: TypeRegistry;
  public readonly launchpad: LaunchpadService;
  private _program?: BaseGearProgram;

  constructor(public api: GearApi, programId?: `0x${string}`) {
    const types: Record<string, any> = {
      Config: {"vft_code_id":"[u8;32]","addrs":"Addrs","raise_target_vara":"u128","graduation_fee_vara":"u128","pair_creation_fee_vara":"u128","total_supply":"U256","curve_supply":"U256","token_decimals":"u8","fee_bps":"u16","creator_fee_bps":"u16","min_trade_vara":"u128","min_free_balance":"u128","graduation_timeout_blocks":"u32","launch_cooldown_blocks":"u32","gas":"GasConfig"},
      Addrs: {"rivr_factory":"[u8;32]","wvara":"[u8;32]","lp_dead":"[u8;32]","treasury":"[u8;32]"},
      GasConfig: {"gas_for_vft_init":"u64","gas_for_token_ops":"u64","gas_for_reply_deposit":"u64","reply_timeout":"u32","gas_for_create_pair":"u64","gas_for_add_liquidity":"u64"},
      TradeReceipt: {"seq":"u64","side":"Side","vara":"u128","tokens":"U256","fee":"u128","price_after_e18":"U256","completed_curve":"bool"},
      Side: {"_enum":["Buy","Sell"]},
      LaunchpadError: {"_enum":{"SpawnFailed":"String","TransferFailed":"Null","TradeStuck":"Null","NotStuck":"Null","Unreconcilable":"Null","GraduationFailed":{"step":"GradStep","reason":"String","retryable":"bool"},"NotGraduating":"Null","FirstBuySkipped":"String","NotUnwindable":"Null","NothingToClaim":"Null","BelowExistentialDeposit":"Null"}},
      GradStep: {"_enum":["WrapVara","FindOrCreatePair","ApproveToken","ApproveWvara","AlignPrice","AddLiquidity","BurnLp","RevokeMinter","RevokeBurner","RevokeAdmin","Settle","Done"]},
      TokenMeta: {"name":"String","symbol":"String","description":"String","image":"String","website":"Option<String>","telegram":"Option<String>","twitter":"Option<String>","discord":"Option<String>","tokenomics":"Option<String>"},
      Launch: {"token":"[u8;32]","creator":"[u8;32]","name":"String","symbol":"String","state":"LaunchState","step":"GradStep","v0":"U256","t0":"U256","virtual_vara":"U256","virtual_tokens":"U256","curve_supply":"U256","real_remaining":"U256","pool_tokens":"U256","escrow":"u128","pool_vara":"u128","graduation_fee":"u128","pair_creation_fee":"u128","creator_fees":"u128","protocol_fees":"u128","trade_seq":"u64","busy":"Option<PendingTrade>","lock":"bool","lock_expires_at":"u32","pair":"[u8;32]","pair_created_by_us":"bool","wvara_is_token0":"bool","wrapped":"bool","liquidity_added":"bool","pre_add_balances":"Option<(U256, U256)>","wvara_budget":"U256","token_budget":"U256","lp_burned":"U256","roles_renounced":"bool","created_at":"u32","ready_at":"u32","fail_reason":"String","fail_retryable":"bool","failed_since":"Option<u32>","graduation_timeout_blocks":"u32","addrs":"Addrs","terms_hash":"[u8; 32]","fee_bps":"u16","creator_fee_bps":"u16"},
      LaunchState: {"_enum":["Trading","Ready","Graduating","Graduated","Failed","Aborted"]},
      PendingTrade: {"side":"Side","trader":"[u8;32]","seq":"u64","vara_gross":"u128","vara_net":"u128","fee_creator":"u128","fee_protocol":"u128","tokens":"U256","prev_virtual_vara":"U256","prev_virtual_tokens":"U256","prev_real_remaining":"U256","prev_escrow":"u128","stuck":"bool","expires_at":"u32"},
      Quote: {"side":"Side","amount_in":"U256","amount_out":"U256","fee_vara":"u128","price_after_e18":"U256","completes_curve":"bool","refund_vara":"u128"},
    }

    this.registry = new TypeRegistry();
    this.registry.setKnownTypes({ types });
    this.registry.register(types);
    if (programId) {
      this._program = new BaseGearProgram(programId, api);
    }

    this.launchpad = new LaunchpadService(this);
  }

  public get programId(): `0x${string}` {
    if (!this._program) throw new Error(`Program ID is not set`);
    return this._program.id;
  }

  newCtorFromCode(code: Uint8Array | Buffer | HexString, config: Config): TransactionBuilder<null> {
    const builder = new TransactionBuilder<null>(
      this.api,
      this.registry,
      'upload_program',
      null,
      'New',
      config,
      'Config',
      'String',
      code,
      async (programId) =>  {
        this._program = await BaseGearProgram.new(programId, this.api);
      }
    );
    return builder;
  }

  newCtorFromCodeId(codeId: `0x${string}`, config: Config) {
    const builder = new TransactionBuilder<null>(
      this.api,
      this.registry,
      'create_program',
      null,
      'New',
      config,
      'Config',
      'String',
      codeId,
      async (programId) =>  {
        this._program = await BaseGearProgram.new(programId, this.api);
      }
    );
    return builder;
  }
}

export class LaunchpadService {
  constructor(private _program: LaunchpadProgram) {}

  public buy(token: ActorId, min_tokens_out: number | string | bigint, deadline_block: number): TransactionBuilder<{ ok: TradeReceipt } | { err: LaunchpadError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: TradeReceipt } | { err: LaunchpadError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'Buy',
      [token, min_tokens_out, deadline_block],
      '([u8;32], U256, u32)',
      'Result<TradeReceipt, LaunchpadError>',
      this._program.programId,
    );
  }

  /**
   * Pays the creator in the reply itself, which reaches a program caller too.
  */
  public claimCreatorFees(token: ActorId): TransactionBuilder<{ ok: number | string | bigint } | { err: LaunchpadError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: LaunchpadError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'ClaimCreatorFees',
      token,
      '[u8;32]',
      'Result<u128, LaunchpadError>',
      this._program.programId,
    );
  }

  /**
   * Pays out what is pending for the caller (deferred sell proceeds, bounced sends) in the
   * reply itself, so it reaches a program caller too. `token` zero holds refunds of launches
   * that failed to spawn.
  */
  public claimPayout(token: ActorId): TransactionBuilder<{ ok: number | string | bigint } | { err: LaunchpadError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: LaunchpadError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'ClaimPayout',
      token,
      '[u8;32]',
      'Result<u128, LaunchpadError>',
      this._program.programId,
    );
  }

  /**
   * Anyone may trigger it; the fees always go to the launch's treasury. Called by the treasury
   * itself they come in the reply (which works for a program treasury, e.g. a multisig);
   * otherwise they are sent, and a send that bounces waits for the treasury's `ClaimPayout`.
  */
  public claimProtocolFees(token: ActorId): TransactionBuilder<{ ok: number | string | bigint } | { err: LaunchpadError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: number | string | bigint } | { err: LaunchpadError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'ClaimProtocolFees',
      token,
      '[u8;32]',
      'Result<u128, LaunchpadError>',
      this._program.programId,
    );
  }

  /**
   * Runs exactly one graduation step. Permissionless; the keeper loops it until `Done`.
  */
  public graduate(token: ActorId): TransactionBuilder<{ ok: GradStep } | { err: LaunchpadError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: GradStep } | { err: LaunchpadError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'Graduate',
      token,
      '[u8;32]',
      'Result<GradStep, LaunchpadError>',
      this._program.programId,
    );
  }

  /**
   * Spawns a new VFT with the launchpad as its only admin, minter and burner and opens its
   * curve. Any attached value is the creator's first buy (the voucher only covers gas).
  */
  public launch(meta: TokenMeta, terms_hash: Array<number>, first_buy_min_tokens_out: number | string | bigint): TransactionBuilder<{ ok: ActorId } | { err: LaunchpadError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: ActorId } | { err: LaunchpadError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'Launch',
      [meta, terms_hash, first_buy_min_tokens_out],
      '(TokenMeta, [u8; 32], U256)',
      'Result<[u8;32], LaunchpadError>',
      this._program.programId,
    );
  }

  /**
   * Resolves a trade whose transfer reply timed out by reading the VFT balance the launchpad
   * actually holds. Anyone may call it.
  */
  public reconcile(token: ActorId): TransactionBuilder<{ ok: boolean } | { err: LaunchpadError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: boolean } | { err: LaunchpadError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'Reconcile',
      token,
      '[u8;32]',
      'Result<bool, LaunchpadError>',
      this._program.programId,
    );
  }

  public sell(token: ActorId, amount: number | string | bigint, min_vara_out: number | string | bigint, deadline_block: number): TransactionBuilder<{ ok: TradeReceipt } | { err: LaunchpadError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: TradeReceipt } | { err: LaunchpadError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'Sell',
      [token, amount, min_vara_out, deadline_block],
      '([u8;32], U256, u128, u32)',
      'Result<TradeReceipt, LaunchpadError>',
      this._program.programId,
    );
  }

  public setAddresses(addrs: Addrs): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'SetAddresses',
      addrs,
      'Addrs',
      'Null',
      this._program.programId,
    );
  }

  public setAdmin(admin: ActorId): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'SetAdmin',
      admin,
      '[u8;32]',
      'Null',
      this._program.programId,
    );
  }

  public setFees(fee_bps: number, creator_fee_bps: number, graduation_fee_vara: number | string | bigint): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'SetFees',
      [fee_bps, creator_fee_bps, graduation_fee_vara],
      '(u16, u16, u128)',
      'Null',
      this._program.programId,
    );
  }

  public setGas(gas: GasConfig): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'SetGas',
      gas,
      'GasConfig',
      'Null',
      this._program.programId,
    );
  }

  public setLimits(min_trade_vara: number | string | bigint, min_free_balance: number | string | bigint, graduation_timeout_blocks: number, launch_cooldown_blocks: number): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'SetLimits',
      [min_trade_vara, min_free_balance, graduation_timeout_blocks, launch_cooldown_blocks],
      '(u128, u128, u32, u32)',
      'Null',
      this._program.programId,
    );
  }

  public setPausedBuys(paused: boolean): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'SetPausedBuys',
      paused,
      'bool',
      'Null',
      this._program.programId,
    );
  }

  public setRaiseTarget(raise_target_vara: number | string | bigint): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'SetRaiseTarget',
      raise_target_vara,
      'u128',
      'Null',
      this._program.programId,
    );
  }

  public setVftCodeId(code_id: CodeId): TransactionBuilder<null> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<null>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'SetVftCodeId',
      code_id,
      '[u8;32]',
      'Null',
      this._program.programId,
    );
  }

  /**
   * Accepts value to top up the operating reserve that pays child-program deposits.
  */
  public topUpReserve(): TransactionBuilder<bigint> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<bigint>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'TopUpReserve',
      null,
      null,
      'u128',
      this._program.programId,
    );
  }

  /**
   * Pulls the pool VARA back out of wVARA after a failed or stale graduation and reopens
   * sells at the frozen curve. Buys stay closed for good.
  */
  public unwind(token: ActorId): TransactionBuilder<{ ok: null } | { err: LaunchpadError }> {
    if (!this._program.programId) throw new Error('Program ID is not set');
    return new TransactionBuilder<{ ok: null } | { err: LaunchpadError }>(
      this._program.api,
      this._program.registry,
      'send_message',
      'Launchpad',
      'Unwind',
      token,
      '[u8;32]',
      'Result<Null, LaunchpadError>',
      this._program.programId,
    );
  }

  public admin(): QueryBuilder<ActorId> {
    return new QueryBuilder<ActorId>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Launchpad',
      'Admin',
      null,
      null,
      '[u8;32]',
    );
  }

  public config(): QueryBuilder<Config> {
    return new QueryBuilder<Config>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Launchpad',
      'Config',
      null,
      null,
      'Config',
    );
  }

  public freeBalance(): QueryBuilder<bigint> {
    return new QueryBuilder<bigint>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Launchpad',
      'FreeBalance',
      null,
      null,
      'u128',
    );
  }

  public launchCount(): QueryBuilder<number> {
    return new QueryBuilder<number>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Launchpad',
      'LaunchCount',
      null,
      null,
      'u32',
    );
  }

  public launchInfo(token: ActorId): QueryBuilder<Launch | null> {
    return new QueryBuilder<Launch | null>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Launchpad',
      'LaunchInfo',
      token,
      '[u8;32]',
      'Option<Launch>',
    );
  }

  /**
   * Every launch, oldest first. Grows with the program; prefer `LaunchesPage`.
  */
  public launches(): QueryBuilder<Array<ActorId>> {
    return new QueryBuilder<Array<ActorId>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Launchpad',
      'Launches',
      null,
      null,
      'Vec<[u8;32]>',
    );
  }

  /**
   * Up to `limit` (at most `MAX_PAGE`) launches from position `offset`, oldest first.
  */
  public launchesPage(offset: number, limit: number): QueryBuilder<Array<ActorId>> {
    return new QueryBuilder<Array<ActorId>>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Launchpad',
      'LaunchesPage',
      [offset, limit],
      '(u32, u32)',
      'Vec<[u8;32]>',
    );
  }

  public nameTaken(name: string): QueryBuilder<boolean> {
    return new QueryBuilder<boolean>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Launchpad',
      'NameTaken',
      name,
      'String',
      'bool',
    );
  }

  public pendingPayout(token: ActorId, who: ActorId): QueryBuilder<bigint> {
    return new QueryBuilder<bigint>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Launchpad',
      'PendingPayout',
      [token, who],
      '([u8;32], [u8;32])',
      'u128',
    );
  }

  public quoteBuy(token: ActorId, vara_in: number | string | bigint): QueryBuilder<Quote> {
    return new QueryBuilder<Quote>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Launchpad',
      'QuoteBuy',
      [token, vara_in],
      '([u8;32], u128)',
      'Quote',
    );
  }

  public quoteSell(token: ActorId, tokens_in: number | string | bigint): QueryBuilder<Quote> {
    return new QueryBuilder<Quote>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Launchpad',
      'QuoteSell',
      [token, tokens_in],
      '([u8;32], U256)',
      'Quote',
    );
  }

  public totalLiabilities(): QueryBuilder<bigint> {
    return new QueryBuilder<bigint>(
      this._program.api,
      this._program.registry,
      this._program.programId,
      'Launchpad',
      'TotalLiabilities',
      null,
      null,
      'u128',
    );
  }

  public subscribeToLaunchedEvent(callback: (data: { token: ActorId; creator: ActorId; name: string; symbol: string; decimals: number; description: string; image: string; v0: number | string | bigint; t0: number | string | bigint; curve_supply: number | string | bigint; pool_tokens: number | string | bigint; raise_target_vara: number | string | bigint; fee_bps: number; creator_fee_bps: number; terms_hash: Array<number> }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Launchpad' && getFnNamePrefix(payload) === 'Launched') {
        callback(this._program.registry.createType('(String, String, {"token":"[u8;32]","creator":"[u8;32]","name":"String","symbol":"String","decimals":"u8","description":"String","image":"String","v0":"U256","t0":"U256","curve_supply":"U256","pool_tokens":"U256","raise_target_vara":"u128","fee_bps":"u16","creator_fee_bps":"u16","terms_hash":"[u8; 32]"})', message.payload)[2].toJSON() as unknown as { token: ActorId; creator: ActorId; name: string; symbol: string; decimals: number; description: string; image: string; v0: number | string | bigint; t0: number | string | bigint; curve_supply: number | string | bigint; pool_tokens: number | string | bigint; raise_target_vara: number | string | bigint; fee_bps: number; creator_fee_bps: number; terms_hash: Array<number> });
      }
    });
  }

  public subscribeToBoughtEvent(callback: (data: { token: ActorId; seq: number | string | bigint; trader: ActorId; vara_in: number | string | bigint; fee: number | string | bigint; tokens_out: number | string | bigint; sold_after: number | string | bigint; escrow_after: number | string | bigint; price_after_e18: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Launchpad' && getFnNamePrefix(payload) === 'Bought') {
        callback(this._program.registry.createType('(String, String, {"token":"[u8;32]","seq":"u64","trader":"[u8;32]","vara_in":"u128","fee":"u128","tokens_out":"U256","sold_after":"U256","escrow_after":"u128","price_after_e18":"U256"})', message.payload)[2].toJSON() as unknown as { token: ActorId; seq: number | string | bigint; trader: ActorId; vara_in: number | string | bigint; fee: number | string | bigint; tokens_out: number | string | bigint; sold_after: number | string | bigint; escrow_after: number | string | bigint; price_after_e18: number | string | bigint });
      }
    });
  }

  public subscribeToSoldEvent(callback: (data: { token: ActorId; seq: number | string | bigint; trader: ActorId; tokens_in: number | string | bigint; fee: number | string | bigint; vara_out: number | string | bigint; deferred: boolean; sold_after: number | string | bigint; escrow_after: number | string | bigint; price_after_e18: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Launchpad' && getFnNamePrefix(payload) === 'Sold') {
        callback(this._program.registry.createType('(String, String, {"token":"[u8;32]","seq":"u64","trader":"[u8;32]","tokens_in":"U256","fee":"u128","vara_out":"u128","deferred":"bool","sold_after":"U256","escrow_after":"u128","price_after_e18":"U256"})', message.payload)[2].toJSON() as unknown as { token: ActorId; seq: number | string | bigint; trader: ActorId; tokens_in: number | string | bigint; fee: number | string | bigint; vara_out: number | string | bigint; deferred: boolean; sold_after: number | string | bigint; escrow_after: number | string | bigint; price_after_e18: number | string | bigint });
      }
    });
  }

  public subscribeToReadyEvent(callback: (data: { token: ActorId; escrow: number | string | bigint; pool_vara: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Launchpad' && getFnNamePrefix(payload) === 'Ready') {
        callback(this._program.registry.createType('(String, String, {"token":"[u8;32]","escrow":"u128","pool_vara":"u128"})', message.payload)[2].toJSON() as unknown as { token: ActorId; escrow: number | string | bigint; pool_vara: number | string | bigint });
      }
    });
  }

  public subscribeToTradeStuckEvent(callback: (data: { token: ActorId; seq: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Launchpad' && getFnNamePrefix(payload) === 'TradeStuck') {
        callback(this._program.registry.createType('(String, String, {"token":"[u8;32]","seq":"u64"})', message.payload)[2].toJSON() as unknown as { token: ActorId; seq: number | string | bigint });
      }
    });
  }

  public subscribeToReconciledEvent(callback: (data: { token: ActorId; seq: number | string | bigint; committed: boolean }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Launchpad' && getFnNamePrefix(payload) === 'Reconciled') {
        callback(this._program.registry.createType('(String, String, {"token":"[u8;32]","seq":"u64","committed":"bool"})', message.payload)[2].toJSON() as unknown as { token: ActorId; seq: number | string | bigint; committed: boolean });
      }
    });
  }

  public subscribeToGraduationStepEvent(callback: (data: { token: ActorId; step: GradStep }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Launchpad' && getFnNamePrefix(payload) === 'GraduationStep') {
        callback(this._program.registry.createType('(String, String, {"token":"[u8;32]","step":"GradStep"})', message.payload)[2].toJSON() as unknown as { token: ActorId; step: GradStep });
      }
    });
  }

  public subscribeToGraduationFailedEvent(callback: (data: { token: ActorId; step: GradStep; reason: string; retryable: boolean }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Launchpad' && getFnNamePrefix(payload) === 'GraduationFailed') {
        callback(this._program.registry.createType('(String, String, {"token":"[u8;32]","step":"GradStep","reason":"String","retryable":"bool"})', message.payload)[2].toJSON() as unknown as { token: ActorId; step: GradStep; reason: string; retryable: boolean });
      }
    });
  }

  public subscribeToImbalancedListingEvent(callback: (data: { token: ActorId; pair: ActorId; reserve0: number | string | bigint; reserve1: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Launchpad' && getFnNamePrefix(payload) === 'ImbalancedListing') {
        callback(this._program.registry.createType('(String, String, {"token":"[u8;32]","pair":"[u8;32]","reserve0":"U256","reserve1":"U256"})', message.payload)[2].toJSON() as unknown as { token: ActorId; pair: ActorId; reserve0: number | string | bigint; reserve1: number | string | bigint });
      }
    });
  }

  public subscribeToGraduatedEvent(callback: (data: { token: ActorId; pair: ActorId; wvara_in_pool: number | string | bigint; tokens_in_pool: number | string | bigint; lp_burned: number | string | bigint; roles_renounced: boolean }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Launchpad' && getFnNamePrefix(payload) === 'Graduated') {
        callback(this._program.registry.createType('(String, String, {"token":"[u8;32]","pair":"[u8;32]","wvara_in_pool":"u128","tokens_in_pool":"U256","lp_burned":"U256","roles_renounced":"bool"})', message.payload)[2].toJSON() as unknown as { token: ActorId; pair: ActorId; wvara_in_pool: number | string | bigint; tokens_in_pool: number | string | bigint; lp_burned: number | string | bigint; roles_renounced: boolean });
      }
    });
  }

  public subscribeToUnwoundEvent(callback: (data: { token: ActorId; escrow: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Launchpad' && getFnNamePrefix(payload) === 'Unwound') {
        callback(this._program.registry.createType('(String, String, {"token":"[u8;32]","escrow":"u128"})', message.payload)[2].toJSON() as unknown as { token: ActorId; escrow: number | string | bigint });
      }
    });
  }

  public subscribeToFeesClaimedEvent(callback: (data: { token: ActorId; to: ActorId; amount: number | string | bigint; creator: boolean }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Launchpad' && getFnNamePrefix(payload) === 'FeesClaimed') {
        callback(this._program.registry.createType('(String, String, {"token":"[u8;32]","to":"[u8;32]","amount":"u128","creator":"bool"})', message.payload)[2].toJSON() as unknown as { token: ActorId; to: ActorId; amount: number | string | bigint; creator: boolean });
      }
    });
  }

  public subscribeToPayoutClaimedEvent(callback: (data: { token: ActorId; to: ActorId; amount: number | string | bigint }) => void | Promise<void>): Promise<() => void> {
    return this._program.api.gearEvents.subscribeToGearEvent('UserMessageSent', ({ data: { message } }) => {;
      if (!message.source.eq(this._program.programId) || !message.destination.eq(ZERO_ADDRESS)) {
        return;
      }

      const payload = message.payload.toHex();
      if (getServiceNamePrefix(payload) === 'Launchpad' && getFnNamePrefix(payload) === 'PayoutClaimed') {
        callback(this._program.registry.createType('(String, String, {"token":"[u8;32]","to":"[u8;32]","amount":"u128"})', message.payload)[2].toJSON() as unknown as { token: ActorId; to: ActorId; amount: number | string | bigint });
      }
    });
  }
}

// ---- types (from the generated global.d.ts, exported instead of ambient) ----

export interface Config {
  vft_code_id: CodeId;
  addrs: Addrs;
  /**
   * Gross VARA (planck) a curve must take in before it graduates. Set by the operator from
   * the USD target and the VARA price; frozen per launch.
  */
  raise_target_vara: number | string | bigint;
  /**
   * VARA kept out of the pool at graduation to pay pair creation, LP account ED and gas.
  */
  graduation_fee_vara: number | string | bigint;
  /**
   * VARA the RivrDEX factory requires with `CreatePair` (exactly 1 VARA on mainnet).
  */
  pair_creation_fee_vara: number | string | bigint;
  total_supply: number | string | bigint;
  curve_supply: number | string | bigint;
  token_decimals: number;
  /**
   * Total trade fee in basis points of the VARA leg.
  */
  fee_bps: number;
  /**
   * Creator's share, in basis points of the VARA leg (must be <= fee_bps).
  */
  creator_fee_bps: number;
  min_trade_vara: number | string | bigint;
  /**
   * Free balance (above all liabilities) the program must keep to spawn a token.
  */
  min_free_balance: number | string | bigint;
  /**
   * Blocks a launch may sit in `Ready` or `Failed` before anyone may `Unwind` it.
  */
  graduation_timeout_blocks: number;
  /**
   * Blocks a creator must wait between launches. Each launch costs the operating reserve the
   * new token's existential deposit, so this bounds how fast one wallet can drain it.
  */
  launch_cooldown_blocks: number;
  gas: GasConfig;
}

export interface Addrs {
  rivr_factory: ActorId;
  wvara: ActorId;
  lp_dead: ActorId;
  treasury: ActorId;
}

/**
 * Gas budgets for every cross-program message the launchpad sends.
*/
export interface GasConfig {
  /**
   * Gas handed to the VFT constructor when a token is spawned.
  */
  gas_for_vft_init: number | string | bigint;
  /**
   * Gas for a VFT transfer / approve / query and for wVARA mint / burn.
  */
  gas_for_token_ops: number | string | bigint;
  /**
   * Gas reserved for processing the reply of each awaited message.
  */
  gas_for_reply_deposit: number | string | bigint;
  /**
   * Blocks to wait for a reply before the await resolves with a timeout.
  */
  reply_timeout: number;
  /**
   * Gas attached to `Factory.CreatePair` (the factory spawns a Pair program from it).
  */
  gas_for_create_pair: number | string | bigint;
  /**
   * Gas attached to `Pair.AddLiquidity`; must exceed the pair's `gas_for_full_tx`.
  */
  gas_for_add_liquidity: number | string | bigint;
}

export interface TradeReceipt {
  seq: number | string | bigint;
  side: Side;
  vara: number | string | bigint;
  tokens: number | string | bigint;
  fee: number | string | bigint;
  price_after_e18: number | string | bigint;
  completed_curve: boolean;
}

export type Side = "Buy" | "Sell";

export type LaunchpadError = 
  | { SpawnFailed: string }
  | { TransferFailed: null }
  | { TradeStuck: null }
  | { NotStuck: null }
  | { Unreconcilable: null }
  | { GraduationFailed: { step: GradStep; reason: string; retryable: boolean } }
  | { NotGraduating: null }
  | { FirstBuySkipped: string }
  | { NotUnwindable: null }
  | { NothingToClaim: null }
  | { BelowExistentialDeposit: null };

export type GradStep = "WrapVara" | "FindOrCreatePair" | "ApproveToken" | "ApproveWvara" | "AlignPrice" | "AddLiquidity" | "BurnLp" | "RevokeMinter" | "RevokeBurner" | "RevokeAdmin" | "Settle" | "Done";

export interface TokenMeta {
  name: string;
  symbol: string;
  description: string;
  image: string;
  website: string | null;
  telegram: string | null;
  twitter: string | null;
  discord: string | null;
  tokenomics: string | null;
}

export interface Launch {
  token: ActorId;
  creator: ActorId;
  name: string;
  symbol: string;
  state: LaunchState;
  step: GradStep;
  v0: number | string | bigint;
  t0: number | string | bigint;
  virtual_vara: number | string | bigint;
  virtual_tokens: number | string | bigint;
  curve_supply: number | string | bigint;
  real_remaining: number | string | bigint;
  pool_tokens: number | string | bigint;
  /**
   * VARA held for sell-backs (and, once Ready, for the pool).
  */
  escrow: number | string | bigint;
  pool_vara: number | string | bigint;
  graduation_fee: number | string | bigint;
  pair_creation_fee: number | string | bigint;
  creator_fees: number | string | bigint;
  protocol_fees: number | string | bigint;
  trade_seq: number | string | bigint;
  busy: PendingTrade | null;
  /**
   * Set while a graduation step, an unwind or a reconcile has a message in flight.
  */
  lock: boolean;
  /**
   * Block after which `lock` is ignored: its holder can no longer be waiting on any reply, so
   * it trapped or ran out of gas after an await and anyone may resume.
  */
  lock_expires_at: number;
  pair: ActorId;
  pair_created_by_us: boolean;
  wvara_is_token0: boolean;
  wrapped: boolean;
  liquidity_added: boolean;
  /**
   * Our own (token, LP) balances read just before our AddLiquidity was sent. Only our
   * deposit can lower the first and raise the second at once, so a resume after a lost reply
   * tells from them whether it landed; reserves are moved by anyone and are not trusted.
  */
  pre_add_balances: [number | string | bigint, number | string | bigint] | null;
  /**
   * wVARA / tokens this launch may deposit after AlignPrice (its swap moves value between them).
  */
  wvara_budget: number | string | bigint;
  token_budget: number | string | bigint;
  lp_burned: number | string | bigint;
  roles_renounced: boolean;
  created_at: number;
  ready_at: number;
  fail_reason: string;
  fail_retryable: boolean;
  /**
   * Block of the first failure since the last completed step. Failed retries keep it, so an
   * early unwind waits `graduation_timeout_blocks` from here whatever the retry traffic.
  */
  failed_since: number | null;
  /**
   * Frozen at creation, like the fees: an admin change cannot shorten a live launch's wait.
  */
  graduation_timeout_blocks: number;
  addrs: Addrs;
  terms_hash: Array<number>;
  fee_bps: number;
  creator_fee_bps: number;
}

export type LaunchState = "Trading" | "Ready" | "Graduating" | "Graduated" | "Failed" | "Aborted";

/**
 * A trade whose VFT transfer is in flight. The curve state has already been moved; the
 * snapshot lets a failed transfer revert it exactly.
*/
export interface PendingTrade {
  side: Side;
  trader: ActorId;
  seq: number | string | bigint;
  vara_gross: number | string | bigint;
  vara_net: number | string | bigint;
  fee_creator: number | string | bigint;
  fee_protocol: number | string | bigint;
  tokens: number | string | bigint;
  prev_virtual_vara: number | string | bigint;
  prev_virtual_tokens: number | string | bigint;
  prev_real_remaining: number | string | bigint;
  prev_escrow: number | string | bigint;
  stuck: boolean;
  /**
   * Block after which the sending message can no longer be waiting on the transfer reply, so
   * a trade still in flight was abandoned (its continuation trapped) and may be reconciled.
  */
  expires_at: number;
}

export interface Quote {
  side: Side;
  amount_in: number | string | bigint;
  amount_out: number | string | bigint;
  fee_vara: number | string | bigint;
  price_after_e18: number | string | bigint;
  completes_curve: boolean;
  refund_vara: number | string | bigint;
}
