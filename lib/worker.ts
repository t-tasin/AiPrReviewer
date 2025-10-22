/**
 * BullMQ Worker - Processes PR review jobs from the queue
 * This is a background worker that should run continuously or via cron jobs
 */

import { Worker, WorkerOptions } from 'bullmq';
import { getRedisConnection, ReviewPRJob } from './queue';
import { reviewPullRequest } from './pr-reviewer';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Create and start the PR review worker
 * This worker will process jobs from the 'pr-reviews' queue
 */
export async function startReviewWorker() {
  const redisConnection = getRedisConnection();

  const worker = new Worker<ReviewPRJob>(
    'pr-reviews',
    async (job) => {
      console.log(`[WORKER] Processing job ${job.id}`);

      try {
        // Parse the webhook payload
        const payload = JSON.parse(job.data.body);

        // Process the PR review
        console.log(`[WORKER] Reviewing PR #${payload.pull_request.number}`);
        const metrics = await reviewPullRequest(payload);

        // Find repo and log metrics
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
              startTime: new Date(),
              endTime: new Date(),
              latencyMs: metrics.latencyMs,
              success: metrics.success,
              errorMessage: metrics.errorMessage,
              lineCommentCount: metrics.lineCommentCount,
              geminiCallDurationMs: metrics.geminiCallDurationMs,
              githubApiDurationMs: metrics.githubApiDurationMs,
              filesTotalCount: metrics.filesTotalCount || 0,
              fileCachedCount: metrics.fileCachedCount || 0,
              cacheHit: (metrics.fileCachedCount || 0) > 0,
            },
          });

          console.log(`[WORKER] Metrics logged for PR #${payload.pull_request.number}`);
        }

        console.log(`[WORKER] Job ${job.id} completed successfully`);
        return { success: true, metrics };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[WORKER] Job ${job.id} failed:`, errorMsg);
        throw error; // Re-throw to let BullMQ handle retries
      }
    },
    {
      connection: redisConnection,
      maxStalledCount: 2,
      stalledInterval: 30000,
      lockDuration: 30000,
      lockRenewTime: 15000,
    } as WorkerOptions
  );

  // Event listeners
  worker.on('completed', (job) => {
    console.log(`[WORKER] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[WORKER] Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', (err) => {
    console.error('[WORKER] Worker error:', err);
  });

  console.log('[WORKER] PR review worker started');
  return worker;
}

/**
 * Export worker creation function for use in serverless functions
 */
export { startReviewWorker as default };
