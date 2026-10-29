import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, StringColumn as StringColumn_, Index as Index_, IntColumn as IntColumn_, BigIntColumn as BigIntColumn_, ManyToOne as ManyToOne_, DateTimeColumn as DateTimeColumn_, OneToMany as OneToMany_, OneToOne as OneToOne_} from "@subsquid/typeorm-store"
import {Factory} from "./factory.model"
import {AccountBalance} from "./accountBalance.model"
import {Transfer} from "./transfer.model"
import {CoinKind} from "./_coinKind"
import {CurveLaunch} from "./curveLaunch.model"

@Entity_()
export class Coin {
    constructor(props?: Partial<Coin>) {
        Object.assign(this, props)
    }

    /**
     * Coin address
     */
    @PrimaryColumn_()
    id!: string

    @Index_()
    @StringColumn_({nullable: false})
    memeId!: string

    @StringColumn_({nullable: false})
    name!: string

    @StringColumn_({nullable: false})
    symbol!: string

    @IntColumn_({nullable: false})
    decimals!: number

    @BigIntColumn_({nullable: false})
    initialSupply!: bigint

    @BigIntColumn_({nullable: false})
    maxSupply!: bigint

    @BigIntColumn_({nullable: false})
    circulatingSupply!: bigint

    @StringColumn_({nullable: true})
    website!: string | undefined | null

    @StringColumn_({nullable: true})
    telegram!: string | undefined | null

    @StringColumn_({nullable: true})
    twitter!: string | undefined | null

    @StringColumn_({nullable: true})
    discord!: string | undefined | null

    @StringColumn_({nullable: true})
    tokenomics!: string | undefined | null

    @StringColumn_({nullable: false})
    description!: string

    @StringColumn_({nullable: true})
    image!: string | undefined | null

    @StringColumn_({array: true, nullable: false})
    screenshots!: (string)[]

    @StringColumn_({array: true, nullable: false})
    admins!: (string)[]

    @BigIntColumn_({nullable: false})
    distributed!: bigint

    @BigIntColumn_({nullable: false})
    minted!: bigint

    @BigIntColumn_({nullable: false})
    burned!: bigint

    @IntColumn_({nullable: false})
    holders!: number

    @Index_()
    @ManyToOne_(() => Factory, {nullable: true})
    factory!: Factory

    @StringColumn_({nullable: false})
    createdBy!: string

    @Index_()
    @DateTimeColumn_({nullable: false})
    timestamp!: Date

    @OneToMany_(() => AccountBalance, e => e.coin)
    balances!: AccountBalance[]

    @OneToMany_(() => Transfer, e => e.coin)
    transfers!: Transfer[]

    /**
     * CLASSIC for factory VFTs, CURVE for launchpad tokens
     */
    @Index_()
    @Column_("varchar", {length: 7, nullable: false})
    kind!: CoinKind

    /**
     * Addresses whose balances are not holders (the launchpad, then the RivrDEX pair)
     */
    @StringColumn_({array: true, nullable: false})
    excludedHolders!: (string)[]

    @OneToOne_(() => CurveLaunch, e => e.coin)
    curveLaunch!: CurveLaunch | undefined | null
}
