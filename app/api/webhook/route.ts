import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Verify GitHub webhook signature
function verifyGitHubSignature(req: NextRequest, body: string): boolean {
  const signature = req.headers.get('x-hub-signature-256');
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!signature) {
    console.error('[WEBHOOK] Missing x-hub-signature-256 header');
    return false;
  }

  if (!secret) {
    console.error('[WEBHOOK] Missing GITHUB_WEBHOOK_SECRET environment variable');
    return false;
  }

  const hash = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  const expectedSignature = `sha256=${hash}`;

  const isValid = crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );

  if (!isValid) {
    console.error('[WEBHOOK] Signature verification failed');
    console.error('[WEBHOOK] Received signature:', signature.substring(0, 20) + '...');
    console.error('[WEBHOOK] Expected signature:', expectedSignature.substring(0, 20) + '...');
  } else {
    console.log('[WEBHOOK] Signature verification successful');
  }

  return isValid;
}

// Get GitHub App installation token
async function getInstallationToken(): Promise<string> {
  try {
    // In a production implementation, you'd:
    // 1. Generate a JWT signed with GITHUB_APP_PRIVATE_KEY
    // 2. Exchange it for an installation-specific token using GitHub API
    // For now, we use GITHUB_TOKEN which is configured as a GitHub App token
    const token = process.env.GITHUB_TOKEN;

    if (!token) {
      throw new Error('GitHub token not configured');
    }

    return token;
  } catch (error) {
    console.error('Error getting installation token:', error);
    throw error;
  }
}

// Get AI review from Gemini
async function getAiReview(
  diff: string,
  customPrompt?: string | null
): Promise<string> {
  const prompt = customPrompt
    ? `${customPrompt}\n\nHere is the diff to review:\n\`\`\`diff\n${diff}\n\`\`\``
    : `You are a senior software engineer providing a code review.
Review the following code diff and provide constructive feedback.
Focus on potential bugs, code clarity, and adherence to best practices.
Format your response in Markdown.

Here is the diff:
\`\`\`diff
${diff}
\`\`\``;

  const modelName = 'gemini-2.5-flash';
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
  };

  const response = await axios.post(geminiUrl, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (
    response.data &&
    response.data.candidates &&
    response.data.candidates[0]?.content
  ) {
    const reviewText = response.data.candidates[0].content.parts[0].text;
    return `### 🤖 AI Code Review\n\n${reviewText}`;
  }

  throw new Error('Invalid response structure from Gemini');
}

// Post comment to GitHub PR
async function postCommentToPR(
  commentsUrl: string,
  commentBody: string,
  token: string
): Promise<void> {
  await axios.post(
    commentsUrl,
    { body: commentBody },
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    }
  );
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  let success = false;
  let errorMessage = '';
  let repoId: number | null = null;
  let prNumber: number | null = null;

  try {
    // Read raw body for signature verification
    const body = await request.text();

    // Verify GitHub signature
    if (!verifyGitHubSignature(request, body)) {
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 401 }
      );
    }

    const payload = JSON.parse(body);

    // Check event type
    const eventType = request.headers.get('x-github-event');

    // Handle installation event - update repositories with correct installation ID
    if (eventType === 'installation') {
      const { action, installation, repositories } = payload;

      console.log('[WEBHOOK] Installation event received');
      console.log('[WEBHOOK] Installation action:', action);
      console.log('[WEBHOOK] Installation ID:', installation.id);
      console.log('[WEBHOOK] Number of repositories:', repositories?.length || 0);

      if ((action === 'created' || action === 'added') && repositories) {
        console.log(`[WEBHOOK] Processing ${repositories.length} repositories for installation`);

        for (const repo of repositories) {
          try {
            // Update existing repository with installation ID
            const updated = await prisma.repository.updateMany({
              where: { githubRepoId: repo.id },
              data: {
                installationId: installation.id,
              },
            });

            if (updated.count > 0) {
              console.log(`[WEBHOOK] Updated repository ${repo.full_name} with installation ID ${installation.id}`);
            } else {
              console.log(`[WEBHOOK] Repository ${repo.full_name} not found in database - it may be synced later`);
            }
          } catch (error) {
            console.error(`[WEBHOOK] Failed to update repository ${repo.full_name}:`, error);
          }
        }

        success = true;
        console.log('[WEBHOOK] Installation event processed successfully');
        return NextResponse.json({ status: 'installation_processed' }, { status: 200 });
      }

      console.log('[WEBHOOK] Installation event ignored');
      return NextResponse.json({ status: 'installation_ignored' }, { status: 202 });
    }

    if (eventType !== 'pull_request') {
      return NextResponse.json({ status: 'ignored' }, { status: 202 });
    }

    const { action, pull_request, repository, installation } = payload;

    console.log('[WEBHOOK] Event payload received');
    console.log('[WEBHOOK] Event action:', action);
    console.log('[WEBHOOK] Repository ID:', repository?.id);
    console.log('[WEBHOOK] Installation ID:', installation?.id);
    console.log('[WEBHOOK] PR title:', pull_request?.title);

    // Only process opened or synchronized events
    if (action !== 'opened' && action !== 'synchronize') {
      console.log(`[WEBHOOK] Ignoring action: ${action}`);
      return NextResponse.json({ status: 'ignored' }, { status: 202 });
    }

    prNumber = pull_request.number;
    const githubRepoId = repository.id;

    console.log(
      `[WEBHOOK] Processing PR #${pull_request.number}: ${pull_request.title}`
    );

    // Find repository in database
    const dbRepository = await prisma.repository.findUnique({
      where: { githubRepoId: githubRepoId },
      include: { configuration: true },
    });

    if (!dbRepository) {
      console.error(`[WEBHOOK] Repository ${githubRepoId} not found in database`);
      console.error('[WEBHOOK] This could mean:');
      console.error('  1. The app was not installed for this repo');
      console.error('  2. The installation webhook did not execute properly');
      console.error('  3. Database sync failed');
      return NextResponse.json(
        { status: 'repository_not_found', error: 'Repo not in database' },
        { status: 404 }
      );
    }

    console.log('[WEBHOOK] Repository found in database:', dbRepository.fullName);

    repoId = dbRepository.id;

    // Check if reviewer is enabled for this repo
    if (dbRepository.configuration && !dbRepository.configuration.enabled) {
      console.log(`[WEBHOOK] Reviewer disabled for repository ${dbRepository.name}`);
      return NextResponse.json(
        { status: 'reviewer_disabled' },
        { status: 202 }
      );
    }

    console.log('[WEBHOOK] Reviewer enabled, proceeding with review');
    console.log('[WEBHOOK] Custom prompt:', dbRepository.configuration?.customPrompt ? 'Yes' : 'No');

    // Get PR diff
    console.log('[WEBHOOK] Fetching PR diff from:', pull_request.diff_url);
    let diffResponse;
    try {
      diffResponse = await axios.get(pull_request.diff_url, {
        headers: { Accept: 'application/vnd.github.v3.diff' },
      });
    } catch (error) {
      console.error('[WEBHOOK] Failed to fetch PR diff:', error);
      throw error;
    }

    const diff = diffResponse.data;
    console.log('[WEBHOOK] Diff content length:', diff?.length || 0, 'bytes');

    if (!diff || diff.length === 0) {
      console.log('[WEBHOOK] No diff content found');
      return NextResponse.json({ status: 'no_diff' }, { status: 200 });
    }

    // Get AI review with custom prompt if available
    console.log('[WEBHOOK] Sending diff to Gemini API for review...');
    let review;
    try {
      review = await getAiReview(diff, dbRepository.configuration?.customPrompt);
      console.log('[WEBHOOK] AI review received, length:', review.length, 'bytes');
    } catch (error) {
      console.error('[WEBHOOK] Failed to get AI review:', error);
      throw error;
    }

    // Get token and post comment
    // Use the installation ID from the webhook payload (more reliable than database)
    const webhookInstallationId = installation?.id;
    console.log('[WEBHOOK] Using webhook installation ID:', webhookInstallationId);
    console.log('[WEBHOOK] Getting installation token...');
    let token;
    try {
      if (!webhookInstallationId) {
        throw new Error('Installation ID not provided in webhook payload');
      }
      token = await getInstallationToken();
      console.log('[WEBHOOK] Installation token obtained');
    } catch (error) {
      console.error('[WEBHOOK] Failed to get installation token:', error);
      throw error;
    }

    console.log('[WEBHOOK] Posting comment to PR...');
    console.log('[WEBHOOK] Comments URL:', pull_request.comments_url);
    try {
      await postCommentToPR(pull_request.comments_url, review, token);
      console.log('[WEBHOOK] Comment posted successfully');
    } catch (error) {
      console.error('[WEBHOOK] Failed to post comment:', error);
      throw error;
    }

    success = true;
    console.log('[WEBHOOK] Successfully completed review workflow');

    return NextResponse.json({ status: 'success' }, { status: 200 });
  } catch (error) {
    errorMessage =
      error instanceof Error
        ? error.message
        : 'Unknown error occurred';
    console.error('[WEBHOOK] ❌ Error occurred:', errorMessage);
    console.error('[WEBHOOK] Full error:', error);
    if (error instanceof Error) {
      console.error('[WEBHOOK] Error stack:', error.stack);
    }

    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  } finally {
    // Log metrics
    const endTime = Date.now();
    const latencyMs = endTime - startTime;

    if (repoId) {
      try {
        await prisma.reviewMetric.create({
          data: {
            repositoryId: repoId,
            prNumber,
            startTime: new Date(startTime),
            endTime: new Date(endTime),
            latencyMs,
            success,
            errorMessage: errorMessage || null,
          },
        });
      } catch (logError) {
        console.error('Failed to log metric:', logError);
      }
    }
  }
}
