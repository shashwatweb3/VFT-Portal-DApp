import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, IntColumn as IntColumn_, ManyToOne as ManyToOne_, Index as Index_, DateTimeColumn as DateTimeColumn_} from "@subsquid/typeorm-store"
import {Factory} from "./factory.model"

@Entity_()
export class MemcoinFactoryEvent {
    constructor(props?: Partial<MemcoinFactoryEvent>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @StringColumn_({nullable: false})
    type!: string

    @StringColumn_({nullable: false})
    raw!: string

    @IntColumn_({nullable: false})
    blockNumber!: number

    @StringColumn_({nullable: false})
    txHash!: string

    @Index_()
    @ManyToOne_(() => Factory, {nullable: true})
    factory!: Factory | undefined | null

    @DateTimeColumn_({nullable: false})
    timestamp!: Date
}
