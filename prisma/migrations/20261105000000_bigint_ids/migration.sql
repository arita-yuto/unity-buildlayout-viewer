-- asset_links_id_seq hit the int4 limit (2147483647); widen ids and their sequences to bigint.
-- Rewrites both tables under an exclusive lock.

-- AlterTable
ALTER TABLE "asset_entries" ALTER COLUMN "id" SET DATA TYPE BIGINT;
ALTER SEQUENCE "asset_entries_id_seq" AS BIGINT MAXVALUE 9223372036854775807;

-- AlterTable
ALTER TABLE "asset_links" ALTER COLUMN "id" SET DATA TYPE BIGINT;
ALTER SEQUENCE "asset_links_id_seq" AS BIGINT MAXVALUE 9223372036854775807;
-- Resume above the int4 range if the sequence was moved into negatives as a stopgap.
SELECT setval('asset_links_id_seq', 2147483647) FROM "asset_links_id_seq" WHERE last_value < 0;
