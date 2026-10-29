module.exports = class Data1792413001821 {
    name = 'Data1792413001821'

    // Curve Launch: launchpad entities. Existing coins are backfilled as CLASSIC with no
    // excluded holders, so this is safe on a populated database.
    async up(db) {
        await db.query(`CREATE TABLE "curve_trade" ("id" character varying NOT NULL, "seq" integer NOT NULL, "side" text NOT NULL, "trader" text NOT NULL, "vara" numeric NOT NULL, "tokens" numeric NOT NULL, "fee" numeric NOT NULL, "price_after_e18" numeric NOT NULL, "sold_after" numeric NOT NULL, "block_number" integer NOT NULL, "timestamp" TIMESTAMP WITH TIME ZONE NOT NULL, "launch_id" character varying, CONSTRAINT "PK_f0b0b27fdbe0d1e25fc50bfe569" PRIMARY KEY ("id"))`)
        await db.query(`CREATE INDEX "IDX_ab81fea4ecf8fc1905de4555c8" ON "curve_trade" ("launch_id") `)
        await db.query(`CREATE INDEX "IDX_e0fdcf80ee5867c14f9a5d8dda" ON "curve_trade" ("trader") `)
        await db.query(`CREATE INDEX "IDX_f819ed4f677864d64b95b85038" ON "curve_trade" ("block_number") `)
        await db.query(`CREATE INDEX "IDX_1cbd335a0dd4e058954add45b3" ON "curve_trade" ("timestamp") `)
        await db.query(`CREATE TABLE "curve_candle" ("id" character varying NOT NULL, "interval" integer NOT NULL, "bucket_start" TIMESTAMP WITH TIME ZONE NOT NULL, "open" numeric NOT NULL, "high" numeric NOT NULL, "low" numeric NOT NULL, "close" numeric NOT NULL, "volume_vara" numeric NOT NULL, "trades" integer NOT NULL, "launch_id" character varying, CONSTRAINT "PK_0908f89f5849c0ecacb76855b08" PRIMARY KEY ("id"))`)
        await db.query(`CREATE INDEX "IDX_0f7c65f808307775af37a1d86b" ON "curve_candle" ("launch_id") `)
        await db.query(`CREATE INDEX "IDX_80a989a0b3e86b07a9cbdf7fe0" ON "curve_candle" ("interval") `)
        await db.query(`CREATE INDEX "IDX_2a2a9b277b1006ee39b0436f48" ON "curve_candle" ("bucket_start") `)
        await db.query(`CREATE TABLE "curve_launch" ("id" character varying NOT NULL, "creator" text NOT NULL, "status" character varying(10) NOT NULL, "v0" numeric NOT NULL, "t0" numeric NOT NULL, "curve_supply" numeric NOT NULL, "pool_tokens" numeric NOT NULL, "raise_target_vara" numeric NOT NULL, "sold" numeric NOT NULL, "escrow" numeric NOT NULL, "price_e18" numeric NOT NULL, "progress_bps" integer NOT NULL, "volume_vara" numeric NOT NULL, "fees_vara" numeric NOT NULL, "trade_count" integer NOT NULL, "last_seq" integer NOT NULL, "grad_step" text, "fail_reason" text, "pair" text, "pool_vara" numeric, "lp_burned" numeric, "roles_renounced" boolean, "graduated_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL, "coin_id" character varying, CONSTRAINT "REL_312b4de176a5e0048f56483cbb" UNIQUE ("coin_id"), CONSTRAINT "PK_0e16270cebb56d1b0c54ae1d3c9" PRIMARY KEY ("id"))`)
        await db.query(`CREATE UNIQUE INDEX "IDX_312b4de176a5e0048f56483cbb" ON "curve_launch" ("coin_id") `)
        await db.query(`CREATE INDEX "IDX_29abc49863cae4c32a4031847d" ON "curve_launch" ("creator") `)
        await db.query(`CREATE INDEX "IDX_b813dc18428b496d3a38c3c893" ON "curve_launch" ("status") `)
        await db.query(`CREATE INDEX "IDX_502df8495237e1b56e2716e933" ON "curve_launch" ("created_at") `)
        await db.query(`CREATE INDEX "IDX_1743e1931f57abf9a579e8a748" ON "curve_launch" ("updated_at") `)
        await db.query(`ALTER TABLE "coin" ADD "kind" character varying(7) NOT NULL DEFAULT 'CLASSIC'`)
        await db.query(`ALTER TABLE "coin" ADD "excluded_holders" text array NOT NULL DEFAULT '{}'`)
        await db.query(`CREATE INDEX "IDX_a81def541d680977fabe24ef0a" ON "coin" ("kind") `)
        await db.query(`ALTER TABLE "curve_trade" ADD CONSTRAINT "FK_ab81fea4ecf8fc1905de4555c84" FOREIGN KEY ("launch_id") REFERENCES "curve_launch"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`)
        await db.query(`ALTER TABLE "curve_candle" ADD CONSTRAINT "FK_0f7c65f808307775af37a1d86bf" FOREIGN KEY ("launch_id") REFERENCES "curve_launch"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`)
        await db.query(`ALTER TABLE "curve_launch" ADD CONSTRAINT "FK_312b4de176a5e0048f56483cbba" FOREIGN KEY ("coin_id") REFERENCES "coin"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`)
    }

    async down(db) {
        await db.query(`DROP TABLE "curve_trade"`)
        await db.query(`DROP INDEX "public"."IDX_ab81fea4ecf8fc1905de4555c8"`)
        await db.query(`DROP INDEX "public"."IDX_e0fdcf80ee5867c14f9a5d8dda"`)
        await db.query(`DROP INDEX "public"."IDX_f819ed4f677864d64b95b85038"`)
        await db.query(`DROP INDEX "public"."IDX_1cbd335a0dd4e058954add45b3"`)
        await db.query(`DROP TABLE "curve_candle"`)
        await db.query(`DROP INDEX "public"."IDX_0f7c65f808307775af37a1d86b"`)
        await db.query(`DROP INDEX "public"."IDX_80a989a0b3e86b07a9cbdf7fe0"`)
        await db.query(`DROP INDEX "public"."IDX_2a2a9b277b1006ee39b0436f48"`)
        await db.query(`DROP TABLE "curve_launch"`)
        await db.query(`DROP INDEX "public"."IDX_312b4de176a5e0048f56483cbb"`)
        await db.query(`DROP INDEX "public"."IDX_29abc49863cae4c32a4031847d"`)
        await db.query(`DROP INDEX "public"."IDX_b813dc18428b496d3a38c3c893"`)
        await db.query(`DROP INDEX "public"."IDX_502df8495237e1b56e2716e933"`)
        await db.query(`DROP INDEX "public"."IDX_1743e1931f57abf9a579e8a748"`)
        await db.query(`ALTER TABLE "coin" DROP COLUMN "kind"`)
        await db.query(`ALTER TABLE "coin" DROP COLUMN "excluded_holders"`)
        await db.query(`DROP INDEX "public"."IDX_a81def541d680977fabe24ef0a"`)
        await db.query(`ALTER TABLE "curve_trade" DROP CONSTRAINT "FK_ab81fea4ecf8fc1905de4555c84"`)
        await db.query(`ALTER TABLE "curve_candle" DROP CONSTRAINT "FK_0f7c65f808307775af37a1d86bf"`)
        await db.query(`ALTER TABLE "curve_launch" DROP CONSTRAINT "FK_312b4de176a5e0048f56483cbba"`)
    }
}
