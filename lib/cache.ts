import crypto from 'crypto';
import { prisma } from './prisma';

/**
 * Calculate SHA-256 hash of file content
 */
export function hashFileContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Get cached review for a file by content hash
 * Returns the cached review comment or null if not found
 */
export async function getCachedReview(
  repositoryId: number,
  filePath: string,
  contentHash: string
): Promise<string | null> {
  try {
    const cache = await prisma.reviewCache.findUnique({
      where: {
        repositoryId_filePath_contentHash: {
          repositoryId,
          filePath,
          contentHash,
        },
      },
    });

    if (cache) {
      console.log(`[CACHE] Hit: ${filePath} (hash: ${contentHash.substring(0, 8)}...)`);
      return cache.review;
    }

    console.log(`[CACHE] Miss: ${filePath} (hash: ${contentHash.substring(0, 8)}...)`);
    return null;
  } catch (error) {
    console.error('[CACHE] Error retrieving cached review:', error);
    return null;
  }
}

/**
 * Store a review in cache
 */
export async function cacheReview(
  repositoryId: number,
  filePath: string,
  contentHash: string,
  review: string
): Promise<boolean> {
  try {
    await prisma.reviewCache.upsert({
      where: {
        repositoryId_filePath_contentHash: {
          repositoryId,
          filePath,
          contentHash,
        },
      },
      update: {
        review,
      },
      create: {
        repositoryId,
        filePath,
        contentHash,
        review,
      },
    });

    console.log(`[CACHE] Stored: ${filePath} (hash: ${contentHash.substring(0, 8)}...)`);
    return true;
  } catch (error) {
    console.error('[CACHE] Error storing review in cache:', error);
    return false;
  }
}

/**
 * Clear cache entries older than specified days
 * Useful for cleaning up old cached reviews
 */
export async function clearOldCache(repositoryId: number, daysOld: number = 30): Promise<number> {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await prisma.reviewCache.deleteMany({
      where: {
        repositoryId,
        createdAt: {
          lt: cutoffDate,
        },
      },
    });

    console.log(`[CACHE] Cleared ${result.count} entries older than ${daysOld} days`);
    return result.count;
  } catch (error) {
    console.error('[CACHE] Error clearing old cache:', error);
    return 0;
  }
}

/**
 * Get cache statistics for a repository
 */
export async function getCacheStats(repositoryId: number) {
  try {
    const totalCacheEntries = await prisma.reviewCache.count({
      where: { repositoryId },
    });

    const oldestEntry = await prisma.reviewCache.findFirst({
      where: { repositoryId },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });

    const newestEntry = await prisma.reviewCache.findFirst({
      where: { repositoryId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    return {
      totalCacheEntries,
      oldestEntry: oldestEntry?.createdAt || null,
      newestEntry: newestEntry?.createdAt || null,
    };
  } catch (error) {
    console.error('[CACHE] Error getting cache stats:', error);
    return {
      totalCacheEntries: 0,
      oldestEntry: null,
      newestEntry: null,
    };
  }
}
