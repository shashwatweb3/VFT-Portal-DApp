import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, Index as Index_, ManyToOne as ManyToOne_, BigIntColumn as BigIntColumn_} from "@subsquid/typeorm-store"
import {Coin} from "./coin.model"

@Entity_()
export class AccountBalance {
    constructor(props?: Partial<AccountBalance>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @Index_()
    @StringColumn_({nullable: false})
    address!: string

    @Index_()
    @ManyToOne_(() => Coin, {nullable: true})
    coin!: Coin

    @BigIntColumn_({nullable: false})
    balance!: bigint
}
