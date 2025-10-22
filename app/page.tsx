'use client';

import Link from 'next/link';

export default function Home() {
  console.log('[Home Page] Rendering home page');

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-900">
      <div className="max-w-2xl text-center">
        <h1 className="mb-4 text-5xl font-bold text-white">
          🤖 Gemini Reviewer
        </h1>
        <p className="mb-8 text-xl text-gray-400">
          AI-powered code reviews for your GitHub pull requests
        </p>
        <p className="mb-8 text-gray-300">
          Automatically review code changes using Google's Gemini AI. Configure
          custom review prompts per repository and track metrics to measure the
          impact on your development workflow.
        </p>

        <Link
          href="/login"
          className="inline-block rounded-lg bg-blue-600 px-8 py-3 font-semibold text-white hover:bg-blue-700 transition"
        >
          Get Started with GitHub
        </Link>

        <div className="mt-16 grid grid-cols-3 gap-8">
          <div className="rounded-lg bg-gray-800 p-6">
            <div className="mb-4 text-3xl">🔐</div>
            <h3 className="mb-2 font-semibold text-white">Secure OAuth</h3>
            <p className="text-sm text-gray-400">
              Sign in securely with your GitHub account. We use industry-standard OAuth 2.0.
            </p>
          </div>
          <div className="rounded-lg bg-gray-800 p-6">
            <div className="mb-4 text-3xl">⚙️</div>
            <h3 className="mb-2 font-semibold text-white">
              Customizable Prompts
            </h3>
            <p className="text-sm text-gray-400">
              Define custom AI review instructions for each repository.
            </p>
          </div>
          <div className="rounded-lg bg-gray-800 p-6">
            <div className="mb-4 text-3xl">📊</div>
            <h3 className="mb-2 font-semibold text-white">Track Metrics</h3>
            <p className="text-sm text-gray-400">
              Monitor latency, success rates, and productivity gains over time.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
