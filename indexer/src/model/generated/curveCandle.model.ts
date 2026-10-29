import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, IntColumn as IntColumn_, DateTimeColumn as DateTimeColumn_, BigIntColumn as BigIntColumn_} from "@subsquid/typeorm-store"
import {CurveLaunch} from "./curveLaunch.model"

@Entity_()
export class CurveCandle {
    constructor(props?: Partial<CurveCandle>) {
        Object.assign(this, props)
    }

    /**
     * <token>-<interval>-<bucketStartMs>
     */
    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => CurveLaunch, {nullable: true})
    launch!: CurveLaunch

    /**
     * Bucket size in seconds: 60, 300, 3600, 86400
     */
    @Index_()
    @IntColumn_({nullable: false})
    interval!: number

    @Index_()
    @DateTimeColumn_({nullable: false})
    bucketStart!: Date

    @BigIntColumn_({nullable: false})
    open!: bigint

    @BigIntColumn_({nullable: false})
    high!: bigint

    @BigIntColumn_({nullable: false})
    low!: bigint

    @BigIntColumn_({nullable: false})
    close!: bigint

    @BigIntColumn_({nullable: false})
    volumeVara!: bigint

    @IntColumn_({nullable: false})
    trades!: number
}
