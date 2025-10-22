import { NextRequest, NextResponse } from 'next/server';
import { getReviewQueue, isRedisConfigured, ReviewPRJob } from '@/lib/queue';
import { reviewPullRequest } from '@/lib/pr-reviewer';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Process one or more jobs from the review queue
 * This endpoint can be called on a schedule via cron or on-demand
 *
 * Query params:
 * - maxJobs: Maximum number of jobs to process (default: 1)
 * - timeout: Timeout in seconds (default: 25 for Vercel limit)
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    // Check if Redis is configured
    if (!isRedisConfigured()) {
      console.log('[WORKER] Redis not configured, skipping queue processing');
      return NextResponse.json(
        { status: 'redis_not_configured', message: 'REDIS_URL environment variable not set' },
        { status: 200 }
      );
    }

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams;
    const maxJobs = parseInt(searchParams.get('maxJobs') || '1');
    const timeoutSeconds = parseInt(searchParams.get('timeout') || '25');
    const timeoutMs = timeoutSeconds * 1000;

    console.log(`[WORKER] Starting queue processing (maxJobs: ${maxJobs}, timeout: ${timeoutSeconds}s)`);

    const queue = getReviewQueue();
    const results = {
      processed: 0,
      failed: 0,
      skipped: 0,
      errors: [] as string[],
      jobs: [] as any[],
    };

    // Get waiting jobs from queue
    const waitingJobs = await queue.getJobs(['waiting'], 0, maxJobs - 1);
    console.log(`[WORKER] Found ${waitingJobs.length} waiting jobs`);

    // Process jobs until timeout or maxJobs reached
    for (const job of waitingJobs) {
      // Check if we're running out of time
      if (Date.now() - startTime > timeoutMs - 5000) {
        console.log('[WORKER] Approaching timeout, stopping job processing');
        break;
      }

      try {
        console.log(`[WORKER] Processing job ${job.id}...`);

        // Mark job as active
        await job.updateProgress(50);

        try {
          // Parse job data
          const jobData: ReviewPRJob = job.data;
          const payload = JSON.parse(jobData.body);

          // Process the PR review
          const metrics = await reviewPullRequest(payload);

          // Find repo to log metrics
          const { repository } = payload;
          const dbRepository = await prisma.repository.findUnique({
            where: { githubRepoId: repository.id },
          });

          if (dbRepository) {
            // Log metrics to database
            await prisma.reviewMetric.create({
              data: {
                repositoryId: dbRepository.id,
                prNumber: payload.pull_request.number,
                startTime: new Date(startTime),
                endTime: new Date(),
                latencyMs: metrics.latencyMs,
                success: metrics.success,
                errorMessage: metrics.errorMessage,
                lineCommentCount: metrics.lineCommentCount,
                geminiCallDurationMs: metrics.geminiCallDurationMs,
                githubApiDurationMs: metrics.githubApiDurationMs,
              },
            });

            console.log(`[WORKER] Metrics logged for PR #${payload.pull_request.number}`);
          }

          // Mark job as complete
          await job.updateProgress(100);
          // Remove completed job from queue (cleanup)
          if (job.id) {
            await queue.remove(job.id);
          }

          results.processed++;
          results.jobs.push({
            jobId: job.id,
            prNumber: payload.pull_request.number,
            repo: repository.full_name,
            latencyMs: metrics.latencyMs,
            success: metrics.success,
            lineComments: metrics.lineCommentCount,
          });

          console.log(`[WORKER] Job ${job.id} completed successfully`);
        } catch (jobError) {
          results.failed++;
          const errorMsg = jobError instanceof Error ? jobError.message : String(jobError);
          results.errors.push(errorMsg);

          console.error(`[WORKER] Job ${job.id} processing failed:`, errorMsg);

          // Job will be retried automatically based on queue configuration (attempts: 3)
          // For now, we don't explicitly handle retry - BullMQ does it automatically
          console.log(`[WORKER] Job will be retried based on queue configuration`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.errors.push(errorMsg);
        console.error('[WORKER] Error processing job:', errorMsg);
      }
    }

    const totalTime = Date.now() - startTime;
    console.log(`[WORKER] Queue processing completed in ${totalTime}ms:`, {
      processed: results.processed,
      failed: results.failed,
      skipped: results.skipped,
    });

    return NextResponse.json({
      status: 'completed',
      duration: totalTime,
      results,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[WORKER] Fatal error:', errorMsg);

    return NextResponse.json(
      {
        status: 'error',
        error: errorMsg,
      },
      { status: 500 }
    );
  }
}

/**
 * Health check endpoint to verify worker can access queue
 */
export async function GET(request: NextRequest) {
  try {
    if (!isRedisConfigured()) {
      return NextResponse.json(
        { status: 'redis_not_configured' },
        { status: 503 }
      );
    }

    const queue = getReviewQueue();
    const counts = await queue.getJobCounts();

    return NextResponse.json({
      status: 'healthy',
      queue: {
        waiting: counts.waiting || 0,
        active: counts.active || 0,
        completed: counts.completed || 0,
        failed: counts.failed || 0,
        delayed: counts.delayed || 0,
      },
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { status: 'error', error: errorMsg },
      { status: 503 }
    );
  }
}
