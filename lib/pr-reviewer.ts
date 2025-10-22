/**
 * Core PR review logic extracted for reuse between webhook and worker
 * This module contains all the business logic for reviewing a PR
 */

import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import parseDiff from 'parse-diff';

const prisma = new PrismaClient();

export interface LineComment {
  file: string;
  line: number;
  comment: string;
}

export interface ReviewMetrics {
  latencyMs: number;
  geminiCallDurationMs: number;
  githubApiDurationMs: number;
  lineCommentCount: number;
  success: boolean;
  errorMessage: string | null;
}

/**
 * Get AI review as JSON (line-specific comments)
 */
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

        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed)) {
            return parsed;
          }
        }

        console.log('[REVIEWER] Failed to parse JSON from Gemini, falling back to text');
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
        `[REVIEWER] Gemini API error (attempt ${attempt + 1}/${maxRetries}), retrying in ${delayMs}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError || new Error('Failed to get AI review after retries');
}

/**
 * Get single comment review (fallback)
 */
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
        `[REVIEWER] Gemini API error (attempt ${attempt + 1}/${maxRetries}), retrying in ${delayMs}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError || new Error('Failed to get AI review after retries');
}

/**
 * Get installation token for GitHub API
 */
async function getInstallationToken(): Promise<string> {
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    throw new Error('GitHub token not configured');
  }

  return token;
}

/**
 * Post line-specific comments to GitHub PR
 */
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
      console.log(`[REVIEWER] Posted line comment for ${lineComment.file}:${lineComment.line}`);
    } catch (error) {
      console.error(`[REVIEWER] Failed to post line comment for ${lineComment.file}:${lineComment.line}:`, error);
    }
  }

  return successCount;
}

/**
 * Post single comment to GitHub PR
 */
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

/**
 * Core review logic - processes a PR webhook event
 */
export async function reviewPullRequest(payload: any): Promise<ReviewMetrics> {
  const startTime = Date.now();
  let geminiCallDurationMs = 0;
  let githubApiDurationMs = 0;
  let lineCommentCount = 0;
  let success = false;
  let errorMessage: string | null = null;

  try {
    const { action, pull_request, repository, installation } = payload;

    console.log('[REVIEWER] Processing PR #' + pull_request.number);

    // Only process opened or synchronized events
    if (action !== 'opened' && action !== 'synchronize') {
      console.log(`[REVIEWER] Ignoring action: ${action}`);
      return {
        latencyMs: Date.now() - startTime,
        geminiCallDurationMs: 0,
        githubApiDurationMs: 0,
        lineCommentCount: 0,
        success: true,
        errorMessage: null,
      };
    }

    const githubRepoId = repository.id;

    // Find repository in database
    const dbRepository = await prisma.repository.findUnique({
      where: { githubRepoId },
      include: { configuration: true },
    });

    if (!dbRepository) {
      throw new Error(`Repository ${githubRepoId} not found in database`);
    }

    // Check if reviewer is enabled
    if (dbRepository.configuration && !dbRepository.configuration.enabled) {
      console.log(`[REVIEWER] Reviewer disabled for repository ${dbRepository.name}`);
      return {
        latencyMs: Date.now() - startTime,
        geminiCallDurationMs: 0,
        githubApiDurationMs: 0,
        lineCommentCount: 0,
        success: true,
        errorMessage: null,
      };
    }

    // Fetch PR diff
    console.log('[REVIEWER] Fetching PR diff...');
    const diffResponse = await axios.get(pull_request.diff_url, {
      headers: { Accept: 'application/vnd.github.v3.diff' },
    });

    const diff = diffResponse.data;
    if (!diff || diff.length === 0) {
      console.log('[REVIEWER] No diff content found');
      return {
        latencyMs: Date.now() - startTime,
        geminiCallDurationMs: 0,
        githubApiDurationMs: 0,
        lineCommentCount: 0,
        success: true,
        errorMessage: null,
      };
    }

    // Get AI review
    console.log('[REVIEWER] Calling Gemini API for review...');
    let lineComments: LineComment[] = [];
    let fallbackReview: string | null = null;

    try {
      const geminiStartTime = Date.now();
      lineComments = await getAiReviewAsJson(diff, dbRepository.configuration?.customPrompt);
      geminiCallDurationMs = Date.now() - geminiStartTime;
      console.log('[REVIEWER] AI review received as JSON:', lineComments.length, 'line comments in', geminiCallDurationMs, 'ms');
    } catch (error) {
      geminiCallDurationMs = Date.now() - startTime;
      console.error('[REVIEWER] Failed to get JSON review, attempting fallback:', error);
      try {
        const geminiStartTime = Date.now();
        fallbackReview = await getAiReviewAsText(diff, dbRepository.configuration?.customPrompt);
        geminiCallDurationMs = Date.now() - geminiStartTime;
        console.log('[REVIEWER] Fallback AI review received in', geminiCallDurationMs, 'ms');
      } catch (fallbackError) {
        throw fallbackError;
      }
    }

    // Get token
    const token = await getInstallationToken();

    // Post comments
    console.log('[REVIEWER] Posting comments to PR...');
    const githubStartTime = Date.now();

    if (lineComments.length > 0) {
      lineCommentCount = await postLineCommentsToPR(pull_request.comments_url, lineComments, token);

      if (lineCommentCount > 0) {
        const summary = `### 🤖 AI Code Review Complete\n\nFound and commented on ${lineCommentCount} line(s) that may need attention.`;
        await postCommentToPR(pull_request.comments_url, summary, token);
      }
    } else if (fallbackReview) {
      await postCommentToPR(pull_request.comments_url, fallbackReview, token);
      lineCommentCount = 1;
    }

    githubApiDurationMs = Date.now() - githubStartTime;

    success = true;
    console.log('[REVIEWER] Review completed successfully');

    return {
      latencyMs: Date.now() - startTime,
      geminiCallDurationMs,
      githubApiDurationMs,
      lineCommentCount,
      success,
      errorMessage: null,
    };
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[REVIEWER] Review failed:', errorMessage);

    return {
      latencyMs: Date.now() - startTime,
      geminiCallDurationMs,
      githubApiDurationMs,
      lineCommentCount,
      success: false,
      errorMessage,
    };
  }
}

export { getAiReviewAsJson, getAiReviewAsText, getInstallationToken, postLineCommentsToPR, postCommentToPR };
