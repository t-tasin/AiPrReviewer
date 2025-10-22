// A simple Express.js server to handle GitHub webhooks for the AI PR Reviewer MVP
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
// Use express.json() to parse raw JSON bodies.
// We need the raw body for signature verification, so we'll use a custom middleware.
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

const PORT = process.env.PORT || 3000;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- Security: Verify GitHub Webhook Signature ---
function verifyGitHubSignature(req) {
    if (!GITHUB_WEBHOOK_SECRET) {
        console.warn('GITHUB_WEBHOOK_SECRET is not set. Skipping signature verification.');
        // In a real production environment, you should ALWAYS have a secret and fail here.
        return true;
    }

    const signature = crypto
        .createHmac('sha256', GITHUB_WEBHOOK_SECRET)
        .update(req.rawBody)
        .digest('hex');
    const trusted = `sha256=${signature}`;
    const received = req.header('x-hub-signature-256');

    if (trusted !== received) {
        console.error('Invalid GitHub webhook signature.');
        return false;
    }
    return true;
}

// --- Main Webhook Handler ---
app.post('/webhook', async (req, res) => {
    // 1. Verify the signature
    if (!verifyGitHubSignature(req)) {
        return res.status(401).send('Unauthorized: Invalid signature.');
    }

    // 2. Check the event type (we only care about pull requests being opened or edited)
    const eventType = req.header('x-github-event');
    if (eventType !== 'pull_request') {
        return res.status(202).send('Accepted: Event is not a pull request, ignoring.');
    }

    const { action, pull_request } = req.body;
    if (action !== 'opened' && action !== 'synchronize') {
        return res.status(202).send(`Accepted: Action is '${action}', ignoring.`);
    }

    console.log(`Processing PR #${pull_request.number}: ${pull_request.title}`);

    try {
        // 3. Get the code diff
        const diffResponse = await axios.get(pull_request.diff_url, {
            headers: { 'Accept': 'application/vnd.github.v3.diff' }
        });
        const diff = diffResponse.data;

        if (!diff || diff.length === 0) {
            console.log('No diff content found. Skipping review.');
            return res.status(200).send('Success: No diff content.');
        }

        // 4. Get AI review from Gemini
        const review = await getAiReview(diff);

        // 5. Post the review as a comment on the PR
        await postCommentToPR(pull_request.comments_url, review);

        res.status(200).send('Success: Review comment posted.');
    } catch (error) {
        console.error('Error processing webhook:', error.message);
        if (error.response) {
            console.error('Error details:', error.response.data);
        }
        res.status(500).send('Internal Server Error.');
    }
});

// --- Helper Function: Get AI Review ---
// --- Helper Function: Get AI Review ---
// --- Helper Function: Get AI Review ---
async function getAiReview(diff) {
    console.log('Requesting review from Gemini...');
    const prompt = `
        You are a senior software engineer providing a code review.
        Review the following code diff and provide constructive feedback.
        Focus on potential bugs, code clarity, and adherence to best practices.
        Format your response in Markdown.

        Here is the diff:
        \`\`\`diff
        ${diff}
        \`\`\`
    `;

    // --- THIS IS THE FIX ---
    // We are changing the URL to use the 'v1' (stable) API
    // and the model name 'gemini-1.5-flash-latest'.
    const modelName = 'gemini-2.5-flash'; 
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
    // --- END OF FIX ---

    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
    };

    try {
        const response = await axios.post(geminiUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        // Check for a valid response structure
        if (response.data && response.data.candidates && response.data.candidates[0].content) {
            const reviewText = response.data.candidates[0].content.parts[0].text;
            return `### 🤖 AI Code Review\n\n${reviewText}`;
        } else {
            console.error('Invalid response structure from Gemini:', response.data);
            throw new Error('Invalid response structure from AI service.');
        }

    } catch (error) {
        console.error('Error calling Gemini API:', error.message);
        // Log more details if available
        if (error.response) {
            console.error('Error Data:', error.response.data.error.message); // Log the specific error message
            console.error('Error Status:', error.response.status);
        }
        throw new Error('Failed to get review from AI service.');
    }
}
// --- Helper Function: Post Comment to GitHub PR ---
async function postCommentToPR(commentsUrl, commentBody) {
    console.log(`Posting comment to ${commentsUrl}`);
    try {
        await axios.post(
            commentsUrl,
            { body: commentBody },
            {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json',
                },
            }
        );
        console.log('Successfully posted comment.');
    } catch (error) {
        console.error('Error posting comment to GitHub:', error.message);
        throw new Error('Failed to post comment to PR.');
    }
}

app.get('/', (req, res) => {
    res.send('AI Pull Request Reviewer is running!');
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
