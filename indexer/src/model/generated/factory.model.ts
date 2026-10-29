import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, OneToMany as OneToMany_} from "@subsquid/typeorm-store"
import {Coin} from "./coin.model"

@Entity_()
export class Factory {
    constructor(props?: Partial<Factory>) {
        Object.assign(this, props)
    }

    @PrimaryColumn_()
    id!: string

    @StringColumn_({nullable: false})
    address!: string

    @StringColumn_({nullable: false})
    meta!: string

    @StringColumn_({nullable: false})
    coinMeta!: string

    @OneToMany_(() => Coin, e => e.factory)
    coins!: Coin[]
}
