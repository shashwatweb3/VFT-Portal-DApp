import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, OneToOne as OneToOne_, Index as Index_, JoinColumn as JoinColumn_, StringColumn as StringColumn_, BigIntColumn as BigIntColumn_, IntColumn as IntColumn_, BooleanColumn as BooleanColumn_, DateTimeColumn as DateTimeColumn_, OneToMany as OneToMany_} from "@subsquid/typeorm-store"
import {Coin} from "./coin.model"
import {CurveStatus} from "./_curveStatus"
import {CurveTrade} from "./curveTrade.model"
import {CurveCandle} from "./curveCandle.model"

@Entity_()
export class CurveLaunch {
    constructor(props?: Partial<CurveLaunch>) {
        Object.assign(this, props)
    }

    /**
     * Token (VFT) address
     */
    @PrimaryColumn_()
    id!: string

    @Index_({unique: true})
    @OneToOne_(() => Coin, {nullable: true})
    @JoinColumn_()
    coin!: Coin

    @Index_()
    @StringColumn_({nullable: false})
    creator!: string

    @Index_()
    @Column_("varchar", {length: 10, nullable: false})
    status!: CurveStatus

    @BigIntColumn_({nullable: false})
    v0!: bigint

    @BigIntColumn_({nullable: false})
    t0!: bigint

    @BigIntColumn_({nullable: false})
    curveSupply!: bigint

    @BigIntColumn_({nullable: false})
    poolTokens!: bigint

    @BigIntColumn_({nullable: false})
    raiseTargetVara!: bigint

    @BigIntColumn_({nullable: false})
    sold!: bigint

    @BigIntColumn_({nullable: false})
    escrow!: bigint

    @BigIntColumn_({nullable: false})
    priceE18!: bigint

    @IntColumn_({nullable: false})
    progressBps!: number

    @BigIntColumn_({nullable: false})
    volumeVara!: bigint

    @BigIntColumn_({nullable: false})
    feesVara!: bigint

    @IntColumn_({nullable: false})
    tradeCount!: number

    @IntColumn_({nullable: false})
    lastSeq!: number

    @StringColumn_({nullable: true})
    gradStep!: string | undefined | null

    @StringColumn_({nullable: true})
    failReason!: string | undefined | null

    @StringColumn_({nullable: true})
    pair!: string | undefined | null

    @BigIntColumn_({nullable: true})
    poolVara!: bigint | undefined | null

    @BigIntColumn_({nullable: true})
    lpBurned!: bigint | undefined | null

    @BooleanColumn_({nullable: true})
    rolesRenounced!: boolean | undefined | null

    @DateTimeColumn_({nullable: true})
    graduatedAt!: Date | undefined | null

    @Index_()
    @DateTimeColumn_({nullable: false})
    createdAt!: Date

    @Index_()
    @DateTimeColumn_({nullable: false})
    updatedAt!: Date

    @OneToMany_(() => CurveTrade, e => e.launch)
    trades!: CurveTrade[]

    @OneToMany_(() => CurveCandle, e => e.launch)
    candles!: CurveCandle[]
}
