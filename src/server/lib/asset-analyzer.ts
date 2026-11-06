import fs from 'fs';
import { chain } from 'stream-chain';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/Pick';
import { streamArray } from 'stream-json/streamers/StreamArray';
import StreamObject from 'stream-json/streamers/StreamObject';
import { prisma } from '@/server/lib/db';
import { env } from '@/server/lib/env';
import { findStaleSnapshotIds, purgeSnapshots } from '@/server/lib/snapshot-cleanup';
import { asset_entries, asset_links, Prisma } from "@prisma/client"

import "server-only"

const cVersion = "1.0";

export class Step {
    private DEFAULT = "Starting upload...";
    private value: Map<string, string> = new Map<string, string>();

    public init(key: string) {
        this.value.set(key, this.DEFAULT);
    }

    public mark(key: string, text: string) {
        if (this.value.has(key) && this.value.get(key) === text) {
            return;
        }
        this.value.set(key, text);
    }

    public clear(key: string) {
        this.value.delete(key);
    }

    public current(key: string): string { return this.value.get(key) ?? ""; }
}
export const step = new Step();

export class SnapshotMetadata {
    constructor() {
        this.platform = "";
        this.playerVersion = "";
        this.buildTime = new Date();
    }
    public platform: string;
    public playerVersion: string
    public buildTime: Date;
}

type AssetEntry = {
    sql: Omit<asset_entries, "id" | "internal_guid">;
    data: any;
};

type AssetLink = Omit<asset_links, "id">

export async function analyzeBuildLayout(
    path: string,
    tag: string,
    comment: string,
    uuid: string
) {
    const sleep = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));

    try {
        console.log(`[analyzeBuildLayout] start uuid=${uuid} tag=${tag}`);
        step.mark(uuid, "Parsing metadata...");
        await sleep(5);

        const snapshot_meta = await extractSnapshotMetadata(path);
        console.log(`[analyzeBuildLayout] metadata: platform=${snapshot_meta.platform} playerVersion=${snapshot_meta.playerVersion} buildTime=${snapshot_meta.buildTime.toISOString()}`);

        step.mark(uuid, "Parsing BuildLayout.json...");
        await sleep(5);

        const parseStart = Date.now();
        const { assetMap, assetLinks } = await parseAssets(uuid, path, 0);
        console.log(`[analyzeBuildLayout] parse done: assets=${assetMap.size} links=${assetLinks.length} elapsed=${Date.now() - parseStart}ms`);

        step.mark(uuid, "Saving assets to DB...");
        await sleep(5);

        const dbStart = Date.now();
        const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            const snapshot = await tx.asset_snapshots.create({
                data: {
                    platform: snapshot_meta.platform,
                    player_version: snapshot_meta.playerVersion,
                    build_time: snapshot_meta.buildTime,
                    tag,
                    comment,
                    version: cVersion,
                }
            });

            const snapshot_id = snapshot.id;
            console.log(`[analyzeBuildLayout] snapshot created: id=${snapshot_id}`);

            await tx.asset_entries.createMany({
                data: Array.from(assetMap.values()).map(e => ({ ...e.sql, snapshot_id })),
                skipDuplicates: false,
            });

            await tx.asset_links.createMany({
                data: assetLinks.map(l => ({ ...l, snapshot_id })),
                skipDuplicates: false,
            });

            return snapshot;
        }, { timeout: 120_000 });
        console.log(`[analyzeBuildLayout] db save done: elapsed=${Date.now() - dbStart}ms`);

        step.mark(uuid, "Cleaning up old snapshots...");
        try {
            const stale = await findStaleSnapshotIds(created, env.SNAPSHOT_RETENTION_DAYS);
            if (stale.length > 0) {
                console.log(`[analyzeBuildLayout] purging ${stale.length} stale snapshot(s): ${stale.join(',')}`);
                await purgeSnapshots(stale);
            }
        } catch (err) {
            // The upload is already committed; a failed cleanup must not turn it into a 500.
            console.error(`[analyzeBuildLayout] cleanup failed uuid=${uuid}`, err);
        }

        fs.unlink(path, () => { });
        step.mark(uuid, "Done!");
        console.log(`[analyzeBuildLayout] done uuid=${uuid}`);

        return {
            status: 200,
            message: "Success",
            assetMap_count: assetMap.size,
            assetLinks_count: assetLinks.length,
            snapshot_meta,
        };
    } catch (err) {
        console.error(`[analyzeBuildLayout] error uuid=${uuid}`, err);

        return {
            status: 500,
            message: `${err}`,
        };
    }
}

async function extractSnapshotMetadata(filePath: string): Promise<SnapshotMetadata> {
    return new Promise((resolve, reject) => {
        const result: SnapshotMetadata = new SnapshotMetadata();

        const pipeline = chain([
            fs.createReadStream(filePath, { encoding: 'utf8' }),
            StreamObject.withParser(),
        ]);

        pipeline.on('data', ({ key, value }) => {
            switch (key) {
                case 'RemoteCatalogBuildPath':
                    result.platform = value?.split('/')?.pop();
                    break;
                case 'PlayerBuildVersion':
                    result.playerVersion = value;
                    break;
                case 'BuildStartTime':
                    result.buildTime = new Date(value);
                    break;
            }

            if (result.platform && result.playerVersion && result.buildTime) {
                pipeline.destroy();
                resolve(result);
            }
        });

        pipeline.on('end', () => {
            if (result.platform || result.playerVersion || result.buildTime) {
                resolve(result);
            } else {
                reject(new Error('Snapshot metadata not found'));
            }
        });

        pipeline.on('error', reject);
    });
}

async function parseAssets(uuid: string, filePath: string, snapshot_id: number): Promise<{
    assetMap: Map<number, AssetEntry>,
    assetLinks: AssetLink[]
}> {
    return new Promise((resolve, reject) => {
        const assetMap = new Map<number, AssetEntry>();
        const assetLinks: AssetLink[] = [];

        const pipeline = chain([
            fs.createReadStream(filePath, { encoding: 'utf8' }),
            parser(),
            pick({ filter: 'references.RefIds' }),
            streamArray()
        ]);

        pipeline.on('data', ({ value }) => {
            const class_name = value.type.class;
            if (class_name === "BuildLayout/SchemaData") {
                return;
            }

            let name = undefined;
            let size = BigInt(0);
            let guid = undefined;
            let hash = undefined;
            switch (class_name) {
                case 'BuildLayout/Group': {
                    name = value.data.Name;
                    size = BigInt(0);
                    guid = value.data.Guid;
                }
                    break;
                case 'BuildLayout/DataFromOtherAsset': case 'BuildLayout/ExplicitAsset': {
                    name = value.data.AssetPath;
                    size = value.data.SerializedSize;

                    switch (class_name) {
                        case 'BuildLayout/DataFromOtherAsset': guid = value.data.AssetGuid; break;
                        case 'BuildLayout/ExplicitAsset':
                            guid = value.data.Guid;
                            hash = value.data.AssetHash.Hash; break;
                    }
                }
                    break;
                case 'BuildLayout/File': {
                    name = value.data.Name;
                    size = value.data.BundleObjectInfo.Size;
                    if (size === BigInt(0)) {
                        size = value.data.PreloadInfoSize;
                    }
                }
                    break;
                case 'BuildLayout/SubFile': {
                    name = value.data.Name;
                    size = value.data.Size;
                }
                    break;
                case 'BuildLayout/Bundle': {
                    let rawName = value.data.Name as string;
                    name = rawName.replace(/_[0-9a-f]{32}(?=\.bundle$)/, '');
                    size = value.data.FileSize;
                    hash = value.data.Hash.Hash;
                    guid = value.data.InternalName;
                }
                    break;
                default:
                    break;
            }

            assetMap.set(value.rid, {
                sql: {
                    snapshot_id: snapshot_id,
                    rid: value.rid,
                    guid: guid,
                    hash: hash,
                    name: name,
                    class_name: value.type.class,
                    size: size,
                    streamed_size: value.data.StreamedSize ?? 0,
                },
                data: value.data
            });
            step.mark(uuid, `Parsing BuildLayout.json... ${assetMap.size} assets`);
            if (assetMap.size % 10000 === 0) {
                console.log(`[parseAssets] parsing... assets=${assetMap.size}`);
            }
        });
        pipeline.on('end', () => {
            console.log(`[parseAssets] all assets parsed: total=${assetMap.size}`);
            step.mark(uuid, "Resolving asset dependencies...");

            const sections = [
                "Files",
                "Bundles",
                "Dependencies",
                "DependentBundles",
                "ExternalReferences",
                "OtherAssets",
                "ExternallyReferencedAssets",
                "InternalReferencedOtherAssets",
                "InternalReferencedExplicitAssets",
                "Assets",
                "ReferencingAssets",
            ]
            const rootSections = [
                "Group", "Bundle"
            ]

            for (const [key, entry] of assetMap) {
                const data = entry.data ?? {};
                for (const section of sections.filter(s => s in data)) {
                    for (const bundle of data[section] ?? []) {
                        const from_id = bundle.rid;
                        const link_type = entry.sql.class_name + '_' + section;
                        assetLinks.push({ snapshot_id: snapshot_id, from_id: from_id, to_id: key, link_type: link_type });
                    }
                }

                for (const section of rootSections) {
                    if (entry.data?.[section]) {
                        const from_id = entry.data?.[section].rid;
                        const link_type = entry.sql.class_name + '_' + section;
                        assetLinks.push({ snapshot_id: snapshot_id, from_id: from_id, to_id: key, link_type: link_type });
                    }
                }

                if ("BundleDependencies" in data) {
                    const BundleDependencies = data["BundleDependencies"] ?? [];
                    for (const bundleDep of BundleDependencies) {
                        if ("AssetDependencies" in bundleDep) {
                            const AssetDependencies = Array.isArray(bundleDep["AssetDependencies"])
                                ? bundleDep["AssetDependencies"]
                                : [bundleDep["AssetDependencies"]];
                            for (const assetDep of AssetDependencies) {
                                if (assetDep.dependencyAsset) {
                                    const from_id = Number(key);
                                    const to_id = assetDep.dependencyAsset.rid;
                                    const link_type = entry.sql.class_name + "_BundleDependencies";
                                    assetLinks.push({ snapshot_id: snapshot_id, from_id: from_id, to_id: to_id, link_type: link_type });
                                }
                            }
                        }
                    }
                }
            }
            resolve({ assetMap, assetLinks });
        });

        pipeline.on('error', reject);
    });
}
