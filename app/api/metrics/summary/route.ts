import { getServerSession } from 'next-auth/next';
import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

/**
 * GET /api/metrics/summary
 * Returns aggregated metrics for all reviewed PRs
 * Shows cache hit ratio, cost savings, and performance stats
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session || !session.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get user's repositories
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      include: { repositories: true },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const repositoryIds = user.repositories.map((r) => r.id);

    if (repositoryIds.length === 0) {
      return NextResponse.json(
        {
          totalPRs: 0,
          totalGeminiCalls: 0,
          totalCacheHits: 0,
          cacheHitRatio: 0,
          apiCallsSaved: 0,
          estimatedSavings: '$0.00',
          averageLatencyMs: 0,
          averageGeminiTimeMs: 0,
          repositories: [],
        },
        { status: 200 }
      );
    }

    // Get all metrics for user's repositories
    const metrics = await prisma.reviewMetric.findMany({
      where: {
        repositoryId: { in: repositoryIds },
      },
    });

    if (metrics.length === 0) {
      return NextResponse.json(
        {
          totalPRs: 0,
          totalGeminiCalls: 0,
          totalCacheHits: 0,
          cacheHitRatio: 0,
          apiCallsSaved: 0,
          estimatedSavings: '$0.00',
          averageLatencyMs: 0,
          averageGeminiTimeMs: 0,
          repositories: user.repositories.map((r) => ({
            id: r.id,
            name: r.name,
            fullName: r.fullName,
            prsReviewed: 0,
            cacheHits: 0,
            cacheHitRatio: 0,
          })),
        },
        { status: 200 }
      );
    }

    // Calculate aggregate metrics
    const totalPRs = metrics.length;
    const totalCacheHits = metrics.filter((m) => m.cacheHit).length;
    const cacheHitRatio = totalPRs > 0 ? (totalCacheHits / totalPRs) * 100 : 0;

    // Estimate Gemini API calls
    // Each file review = 1 API call if not cached
    const totalFilesReviewed = metrics.reduce((sum, m) => sum + (m.filesTotalCount || 0), 0);
    const totalFilesCached = metrics.reduce((sum, m) => sum + (m.fileCachedCount || 0), 0);
    const totalGeminiCalls = totalFilesReviewed - totalFilesCached;
    const apiCallsSaved = totalFilesCached;

    // Cost estimation
    // Google Gemini API: ~$0.075 per 1M input tokens
    // Average code review: ~500 input tokens
    // Cost per review: ~$0.0000375
    const costPerReview = 0.0000375;
    const estimatedSavings = apiCallsSaved * costPerReview;

    // Average latency
    const successfulMetrics = metrics.filter((m) => m.success);
    const averageLatencyMs =
      successfulMetrics.length > 0
        ? Math.round(
            successfulMetrics.reduce((sum, m) => sum + (m.latencyMs || 0), 0) / successfulMetrics.length
          )
        : 0;

    const averageGeminiTimeMs =
      successfulMetrics.length > 0
        ? Math.round(
            successfulMetrics.reduce((sum, m) => sum + (m.geminiCallDurationMs || 0), 0) / successfulMetrics.length
          )
        : 0;

    // Per-repository breakdown
    const repositoryMetrics = user.repositories.map((repo) => {
      const repoMetrics = metrics.filter((m) => m.repositoryId === repo.id);
      const repoCacheHits = repoMetrics.filter((m) => m.cacheHit).length;
      const repoCacheHitRatio = repoMetrics.length > 0 ? (repoCacheHits / repoMetrics.length) * 100 : 0;

      return {
        id: repo.id,
        name: repo.name,
        fullName: repo.fullName,
        prsReviewed: repoMetrics.length,
        cacheHits: repoCacheHits,
        cacheHitRatio: Math.round(repoCacheHitRatio * 100) / 100,
      };
    });

    return NextResponse.json(
      {
        totalPRs,
        totalGeminiCalls,
        totalCacheHits,
        cacheHitRatio: Math.round(cacheHitRatio * 100) / 100,
        apiCallsSaved,
        estimatedSavings: `$${estimatedSavings.toFixed(2)}`,
        averageLatencyMs,
        averageGeminiTimeMs,
        repositories: repositoryMetrics,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('[METRICS] Error fetching metrics:', error);
    return NextResponse.json(
      { error: 'Failed to fetch metrics' },
      { status: 500 }
    );
  }
}
