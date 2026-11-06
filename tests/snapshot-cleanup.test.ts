/**
 * Integration tests for snapshot retention cleanup. Requires DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/server/lib/db';
import { findStaleSnapshotIds, purgeSnapshots } from '@/server/lib/snapshot-cleanup';

const PLATFORM = 'cleanup-test';
const DAY = 86_400_000;
const byId = (a: number, b: number) => a - b;

async function createSnapshot(player_version: string, tag: string, ageDays: number) {
    const s = await prisma.asset_snapshots.create({
        data: { platform: PLATFORM, player_version, tag, version: '1.0', created_at: new Date(Date.now() - ageDays * DAY) },
    });
    await prisma.asset_entries.createMany({
        data: [{ snapshot_id: s.id, rid: 1, class_name: 'BuildLayout/Group', name: 'g', size: BigInt(0), streamed_size: BigInt(0) }],
    });
    await prisma.asset_links.createMany({
        data: [{ snapshot_id: s.id, from_id: 1, to_id: 1, link_type: 'BuildLayout/Bundle_Group' }],
    });
    return s;
}

async function removeAll() {
    const ids = (await prisma.asset_snapshots.findMany({ where: { platform: PLATFORM }, select: { id: true } })).map(s => s.id);
    await purgeSnapshots(ids);
}

describe('snapshot cleanup', () => {
    beforeAll(removeAll);
    afterAll(removeAll);

    it('finds superseded and expired snapshots and purges their rows', async () => {
        const expired = await createSnapshot('1.0.0', 'a', 100);
        const expiredOtherTag = await createSnapshot('1.0.0', 'b', 100);
        const recent = await createSnapshot('1.0.1', 'a', 10);
        const replaced = await createSnapshot('1.0.2', 'a', 1);
        const latest = await createSnapshot('1.0.2', 'a', 0);

        const stale = await findStaleSnapshotIds(latest, 90);
        expect([...stale].sort(byId)).toEqual([expired.id, expiredOtherTag.id, replaced.id].sort(byId));

        await purgeSnapshots(stale);

        const remaining = await prisma.asset_snapshots.findMany({ where: { platform: PLATFORM }, select: { id: true } });
        expect(remaining.map(s => s.id).sort(byId)).toEqual([recent.id, latest.id].sort(byId));
        expect(await prisma.asset_entries.count({ where: { snapshot_id: { in: stale } } })).toBe(0);
        expect(await prisma.asset_links.count({ where: { snapshot_id: { in: stale } } })).toBe(0);
        expect(await prisma.asset_entries.count({ where: { snapshot_id: { in: [recent.id, latest.id] } } })).toBe(2);
    });

    it('retention 0 disables age-based deletion but still removes superseded snapshots', async () => {
        const old = await createSnapshot('2.0.0', 'c', 400);
        const replaced = await createSnapshot('2.0.1', 'c', 400);
        const latest = await createSnapshot('2.0.1', 'c', 0);

        expect(await findStaleSnapshotIds(latest, 0)).toEqual([replaced.id]);

        await purgeSnapshots([old.id, replaced.id, latest.id]);
    });
});
