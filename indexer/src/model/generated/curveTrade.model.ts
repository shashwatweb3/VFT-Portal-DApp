import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, IntColumn as IntColumn_, StringColumn as StringColumn_, BigIntColumn as BigIntColumn_, DateTimeColumn as DateTimeColumn_} from "@subsquid/typeorm-store"
import {CurveLaunch} from "./curveLaunch.model"

@Entity_()
export class CurveTrade {
    constructor(props?: Partial<CurveTrade>) {
        Object.assign(this, props)
    }

    /**
     * <token>-<seq>
     */
    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => CurveLaunch, {nullable: true})
    launch!: CurveLaunch

    @IntColumn_({nullable: false})
    seq!: number

    @StringColumn_({nullable: false})
    side!: string

    @Index_()
    @StringColumn_({nullable: false})
    trader!: string

    @BigIntColumn_({nullable: false})
    vara!: bigint

    @BigIntColumn_({nullable: false})
    tokens!: bigint

    @BigIntColumn_({nullable: false})
    fee!: bigint

    @BigIntColumn_({nullable: false})
    priceAfterE18!: bigint

    @BigIntColumn_({nullable: false})
    soldAfter!: bigint

    @Index_()
    @IntColumn_({nullable: false})
    blockNumber!: number

    @Index_()
    @DateTimeColumn_({nullable: false})
    timestamp!: Date
}
