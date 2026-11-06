import { prisma } from '@/server/lib/db';

import "server-only"

type SnapshotKey = {
    id: number;
    platform: string | null;
    player_version: string | null;
    tag: string | null;
};

// Snapshots replaced by `latest` (same platform / version / tag) or uploaded before the retention window.
export async function findStaleSnapshotIds(latest: SnapshotKey, retentionDays: number): Promise<number[]> {
    const superseded = await prisma.asset_snapshots.findMany({
        where: {
            id: { not: latest.id },
            platform: latest.platform,
            player_version: latest.player_version,
            tag: latest.tag,
        },
        select: { id: true },
    });

    const expired = retentionDays > 0
        ? await prisma.asset_snapshots.findMany({
            where: {
                id: { not: latest.id },
                created_at: { lt: new Date(Date.now() - retentionDays * 86_400_000) },
            },
            select: { id: true },
        })
        : [];

    return [...new Set([...superseded, ...expired].map(s => s.id))];
}

// One transaction per snapshot so a failure leaves every other snapshot either fully removed or intact.
export async function purgeSnapshots(ids: number[]) {
    for (const id of ids) {
        await prisma.$transaction([
            prisma.asset_links.deleteMany({ where: { snapshot_id: id } }),
            prisma.asset_entries.deleteMany({ where: { snapshot_id: id } }),
            prisma.asset_snapshots.delete({ where: { id } }),
        ]);
    }
}
