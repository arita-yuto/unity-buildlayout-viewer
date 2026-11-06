/**
 * End-to-end test of the upload path: analyzeBuildLayout parses a BuildLayout.json, saves the
 * snapshot and purges superseded / expired snapshots. Requires DATABASE_URL on a test database.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { prisma } from '@/server/lib/db';
import { env } from '@/server/lib/env';
import { analyzeBuildLayout } from '@/server/lib/asset-analyzer';
import { purgeSnapshots } from '@/server/lib/snapshot-cleanup';

const PLATFORM = 'e2e-cleanup';
const TAG = 'e2e';
const DAY = 86_400_000;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildlayout-'));

// Minimal BuildLayout.json: Group -> Bundle -> File -> ExplicitAsset (4 entries, 6 links).
function writeLayout(version: string): string {
    const layout = {
        RemoteCatalogBuildPath: `ServerData/${PLATFORM}`,
        PlayerBuildVersion: version,
        BuildStartTime: '2026-11-01T00:00:00Z',
        references: {
            version: 2,
            RefIds: [
                { rid: 1, type: { class: 'BuildLayout/Group' }, data: { Name: 'DefaultLocalGroup', Guid: 'group-1', Bundles: [{ rid: 2 }] } },
                { rid: 2, type: { class: 'BuildLayout/Bundle' }, data: { Name: 'assets_textures_0123456789abcdef0123456789abcdef.bundle', FileSize: 1000, Hash: { Hash: 'bundle-hash' }, InternalName: 'assets_textures', Group: { rid: 1 }, Files: [{ rid: 3 }] } },
                { rid: 3, type: { class: 'BuildLayout/File' }, data: { Name: 'CAB-1', BundleObjectInfo: { Size: 500 }, PreloadInfoSize: 0, Bundle: { rid: 2 }, Assets: [{ rid: 4 }] } },
                { rid: 4, type: { class: 'BuildLayout/ExplicitAsset' }, data: { AssetPath: 'Assets/Textures/Logo.png', SerializedSize: 200, Guid: 'asset-4', AssetHash: { Hash: 'asset-hash' }, Bundle: { rid: 2 } } },
            ],
        },
    };
    const file = path.join(tmpDir, `${version}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(layout));
    return file;
}

async function removeAll() {
    const ids = (await prisma.asset_snapshots.findMany({ where: { platform: PLATFORM }, select: { id: true } })).map(s => s.id);
    await purgeSnapshots(ids);
}

describe('analyzeBuildLayout cleanup', () => {
    beforeAll(removeAll);
    afterAll(async () => {
        await removeAll();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('saves the snapshot with its entries and links', async () => {
        const result = await analyzeBuildLayout(writeLayout('1.0.0'), TAG, 'first', 'e2e-1');
        expect(result.status, result.message).toBe(200);

        const snapshot = await prisma.asset_snapshots.findFirstOrThrow({ where: { platform: PLATFORM, player_version: '1.0.0', tag: TAG } });
        expect(await prisma.asset_entries.count({ where: { snapshot_id: snapshot.id } })).toBe(4);
        expect(await prisma.asset_links.count({ where: { snapshot_id: snapshot.id } })).toBe(6);
    });

    it('re-uploading the same platform / version / tag purges the previous snapshot', async () => {
        const previous = await prisma.asset_snapshots.findFirstOrThrow({ where: { platform: PLATFORM, player_version: '1.0.0', tag: TAG } });

        const result = await analyzeBuildLayout(writeLayout('1.0.0'), TAG, 'second', 'e2e-2');
        expect(result.status, result.message).toBe(200);

        const remaining = await prisma.asset_snapshots.findMany({ where: { platform: PLATFORM, player_version: '1.0.0', tag: TAG } });
        expect(remaining).toHaveLength(1);
        expect(remaining[0].id).not.toBe(previous.id);
        expect(remaining[0].comment).toBe('second');
        expect(await prisma.asset_entries.count({ where: { snapshot_id: previous.id } })).toBe(0);
        expect(await prisma.asset_links.count({ where: { snapshot_id: previous.id } })).toBe(0);
        expect(await prisma.asset_entries.count({ where: { snapshot_id: remaining[0].id } })).toBe(4);
    });

    it('uploading purges snapshots older than SNAPSHOT_RETENTION_DAYS', async () => {
        const cutoff = new Date(Date.now() - env.SNAPSHOT_RETENTION_DAYS * DAY);
        expect(env.SNAPSHOT_RETENTION_DAYS).toBeGreaterThan(0);
        // Guard: an upload purges every expired snapshot, so refuse to run against a database holding real data.
        expect(await prisma.asset_snapshots.count({ where: { created_at: { lt: cutoff } } }), 'test database contains snapshots older than the retention window').toBe(0);

        const old = await prisma.asset_snapshots.create({
            data: { platform: PLATFORM, player_version: '0.0.1', tag: 'old', version: '1.0', created_at: new Date(cutoff.getTime() - 10 * DAY) },
        });
        await prisma.asset_entries.createMany({ data: [{ snapshot_id: old.id, rid: 1, class_name: 'BuildLayout/Group', name: 'g', size: BigInt(0), streamed_size: BigInt(0) }] });
        const recent = await prisma.asset_snapshots.create({
            data: { platform: PLATFORM, player_version: '0.0.2', tag: 'old', version: '1.0', created_at: new Date(cutoff.getTime() + 10 * DAY) },
        });

        const result = await analyzeBuildLayout(writeLayout('2.0.0'), TAG, 'third', 'e2e-3');
        expect(result.status, result.message).toBe(200);

        expect(await prisma.asset_snapshots.findUnique({ where: { id: old.id } })).toBeNull();
        expect(await prisma.asset_entries.count({ where: { snapshot_id: old.id } })).toBe(0);
        expect(await prisma.asset_snapshots.findUnique({ where: { id: recent.id } })).not.toBeNull();
    });
});
