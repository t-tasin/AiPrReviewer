import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import parseDiff from 'parse-diff';

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

// Type definition for line-specific comments
interface LineComment {
  file: string;
  line: number;
  comment: string;
}

// Get AI review from Gemini with retry logic - returns JSON format
async function getAiReviewAsJson(
  diff: string,
  customPrompt?: string | null
): Promise<LineComment[]> {
  const prompt = customPrompt
    ? `${customPrompt}\n\nReview this diff and respond with ONLY a valid JSON array.
Format: [{"file": "path/to/file", "line": LINE_NUMBER, "comment": "specific feedback for this line"}]
Focus on actionable feedback. Include only lines that need improvement.

Diff:
\`\`\`diff
${diff}
\`\`\``
    : `You are a senior software engineer providing line-by-line code review.
Review the diff and respond with ONLY a valid JSON array.
Format: [{"file": "path/to/file", "line": LINE_NUMBER, "comment": "specific feedback"}]
Focus on: potential bugs, code clarity, best practices, security issues.
Include only lines that need improvement. Empty array if no issues.

Diff:
\`\`\`diff
${diff}
\`\`\``;

  const modelName = 'gemini-2.5-flash';
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
  };

  // Retry logic for transient failures (503, 429, timeouts)
  const maxRetries = 3;
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await axios.post(geminiUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      });

      if (
        response.data &&
        response.data.candidates &&
        response.data.candidates[0]?.content
      ) {
        const responseText = response.data.candidates[0].content.parts[0].text;

        // Try to parse JSON from response
        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed)) {
            return parsed;
          }
        }

        // If JSON parsing fails, return empty array and fall back to single comment
        console.log('[WEBHOOK] Failed to parse JSON from Gemini, falling back to text');
        return [];
      }

      throw new Error('Invalid response structure from Gemini');
    } catch (error) {
      lastError = error;
      const isAxiosError = axios.isAxiosError(error);
      const status = isAxiosError ? error.response?.status : null;
      const isRetryable =
        !isAxiosError ||
        (status && (status === 429 || status === 503 || status >= 500));

      if (!isRetryable || attempt === maxRetries - 1) {
        throw error;
      }

      const delayMs = Math.pow(2, attempt) * 1000;
      console.log(
        `[WEBHOOK] Gemini API error (attempt ${attempt + 1}/${maxRetries}), retrying in ${delayMs}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError || new Error('Failed to get AI review after retries');
}

// Fallback: Get single comment review
async function getAiReviewAsText(
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

  const maxRetries = 3;
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await axios.post(geminiUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
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
    } catch (error) {
      lastError = error;
      const isAxiosError = axios.isAxiosError(error);
      const status = isAxiosError ? error.response?.status : null;
      const isRetryable =
        !isAxiosError ||
        (status && (status === 429 || status === 503 || status >= 500));

      if (!isRetryable || attempt === maxRetries - 1) {
        throw error;
      }

      const delayMs = Math.pow(2, attempt) * 1000;
      console.log(
        `[WEBHOOK] Gemini API error (attempt ${attempt + 1}/${maxRetries}), retrying in ${delayMs}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError || new Error('Failed to get AI review after retries');
}

// Post single comment to GitHub PR
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

// Post line-specific comments to GitHub PR
async function postLineCommentsToPR(
  commentsUrl: string,
  lineComments: LineComment[],
  token: string
): Promise<number> {
  let successCount = 0;

  for (const lineComment of lineComments) {
    try {
      const commentBody = `**${lineComment.file}** (line ${lineComment.line})\n\n${lineComment.comment}`;

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

      successCount++;
      console.log(`[WEBHOOK] Posted line comment for ${lineComment.file}:${lineComment.line}`);
    } catch (error) {
      console.error(`[WEBHOOK] Failed to post line comment for ${lineComment.file}:${lineComment.line}:`, error);
    }
  }

  return successCount;
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  let success = false;
  let errorMessage = '';
  let repoId: number | null = null;
  let prNumber: number | null = null;
  let lineCommentCount = 0;

  // Timing metrics
  let geminiCallStartTime = 0;
  let geminiCallDurationMs = 0;
  let githubApiStartTime = 0;
  let githubApiDurationMs = 0;

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

    // Get AI review with custom prompt if available (try JSON format first)
    console.log('[WEBHOOK] Sending diff to Gemini API for line-specific review...');
    let lineComments: LineComment[] = [];
    let fallbackReview: string | null = null;

    try {
      geminiCallStartTime = Date.now();
      lineComments = await getAiReviewAsJson(diff, dbRepository.configuration?.customPrompt);
      geminiCallDurationMs = Date.now() - geminiCallStartTime;
      console.log('[WEBHOOK] AI review received as JSON:', lineComments.length, 'line comments in', geminiCallDurationMs, 'ms');
    } catch (error) {
      geminiCallDurationMs = Date.now() - geminiCallStartTime;
      console.error('[WEBHOOK] Failed to get JSON review, attempting fallback:', error);
      try {
        geminiCallStartTime = Date.now();
        fallbackReview = await getAiReviewAsText(diff, dbRepository.configuration?.customPrompt);
        geminiCallDurationMs = Date.now() - geminiCallStartTime;
        console.log('[WEBHOOK] Fallback AI review received, length:', fallbackReview.length, 'bytes in', geminiCallDurationMs, 'ms');
      } catch (fallbackError) {
        geminiCallDurationMs = Date.now() - geminiCallStartTime;
        console.error('[WEBHOOK] Failed to get AI review:', fallbackError);
        throw fallbackError;
      }
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

    console.log('[WEBHOOK] Posting review to PR...');
    console.log('[WEBHOOK] Comments URL:', pull_request.comments_url);

    let commentCount = 0;
    try {
      githubApiStartTime = Date.now();
      if (lineComments.length > 0) {
        // Post line-specific comments
        console.log('[WEBHOOK] Posting', lineComments.length, 'line-specific comments...');
        commentCount = await postLineCommentsToPR(pull_request.comments_url, lineComments, token);
        lineCommentCount = commentCount; // Track for metrics
        console.log('[WEBHOOK]', commentCount, 'line-specific comments posted successfully');

        // Also post a summary comment
        if (commentCount > 0) {
          const summary = `### 🤖 AI Code Review Complete\n\nFound and commented on ${commentCount} line(s) that may need attention.`;
          await postCommentToPR(pull_request.comments_url, summary, token);
          console.log('[WEBHOOK] Summary comment posted');
        }
      } else if (fallbackReview) {
        // Fallback to single comment if JSON parsing failed
        console.log('[WEBHOOK] Using fallback review format...');
        await postCommentToPR(pull_request.comments_url, fallbackReview, token);
        commentCount = 1;
        console.log('[WEBHOOK] Fallback comment posted successfully');
      }
      githubApiDurationMs = Date.now() - githubApiStartTime;
      console.log('[WEBHOOK] GitHub API calls completed in', githubApiDurationMs, 'ms');
    } catch (error) {
      githubApiDurationMs = Date.now() - githubApiStartTime;
      console.error('[WEBHOOK] Failed to post comments:', error);
      throw error;
    }

    success = true;
    console.log('[WEBHOOK] Successfully completed review workflow');
    console.log(`[WEBHOOK] Review complete: ${lineCommentCount} line comments posted`);

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
            lineCommentCount,
            geminiCallDurationMs: geminiCallDurationMs || null,
            githubApiDurationMs: githubApiDurationMs || null,
          },
        });

        console.log('[WEBHOOK] Metrics logged:', {
          latencyMs,
          geminiMs: geminiCallDurationMs,
          githubMs: githubApiDurationMs,
          lineComments: lineCommentCount,
          success,
        });
      } catch (logError) {
        console.error('Failed to log metric:', logError);
      }
    }
  }
}
