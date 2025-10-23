'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';

interface MetricsData {
  totalPRs: number;
  totalGeminiCalls: number;
  totalCacheHits: number;
  cacheHitRatio: number;
  apiCallsSaved: number;
  estimatedSavings: string;
  averageLatencyMs: number;
  averageGeminiTimeMs: number;
  repositories: Array<{
    id: number;
    name: string;
    fullName: string;
    prsReviewed: number;
    cacheHits: number;
    cacheHitRatio: number;
  }>;
}

export default function MetricsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/login');
    }
  }, [status, router]);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const response = await fetch('/api/metrics/summary');
        if (response.ok) {
          const data = await response.json();
          setMetrics(data);
        }
      } catch (error) {
        console.error('Failed to fetch metrics:', error);
      } finally {
        setLoading(false);
      }
    };

    if (status === 'authenticated') {
      fetchMetrics();
    }
  }, [status]);

  if (status === 'loading' || loading) {
    return <div className="p-8">Loading metrics...</div>;
  }

  if (!metrics) {
    return <div className="p-8">No metrics available yet.</div>;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800">
      <div className="max-w-7xl mx-auto p-8">
        <h1 className="text-4xl font-bold text-white mb-8">📊 ReviewBuddy Metrics Dashboard</h1>

        {/* Key Metrics Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <MetricCard
            title="PRs Reviewed"
            value={metrics.totalPRs}
            icon="🔍"
            color="from-blue-500 to-blue-600"
          />
          <MetricCard
            title="Cache Hit Ratio"
            value={`${metrics.cacheHitRatio}%`}
            icon="🎯"
            color="from-green-500 to-green-600"
          />
          <MetricCard
            title="API Calls Saved"
            value={metrics.apiCallsSaved}
            icon="💰"
            color="from-purple-500 to-purple-600"
          />
          <MetricCard
            title="Estimated Savings"
            value={metrics.estimatedSavings}
            icon="💵"
            color="from-pink-500 to-pink-600"
          />
        </div>

        {/* Performance Metrics */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <div className="bg-slate-700 rounded-lg p-6">
            <h2 className="text-xl font-bold text-white mb-4">⚡ Performance</h2>
            <div className="space-y-4">
              <div>
                <p className="text-slate-300 text-sm">Average Review Time</p>
                <p className="text-3xl font-bold text-green-400">{metrics.averageLatencyMs}ms</p>
              </div>
              <div>
                <p className="text-slate-300 text-sm">Average Gemini API Time</p>
                <p className="text-2xl font-bold text-blue-400">{metrics.averageGeminiTimeMs}ms</p>
              </div>
            </div>
          </div>

          <div className="bg-slate-700 rounded-lg p-6">
            <h2 className="text-xl font-bold text-white mb-4">📈 Caching Impact</h2>
            <div className="space-y-4">
              <div>
                <p className="text-slate-300 text-sm">Total Cache Hits</p>
                <p className="text-3xl font-bold text-purple-400">{metrics.totalCacheHits}</p>
              </div>
              <div>
                <p className="text-slate-300 text-sm">Gemini API Calls Made</p>
                <p className="text-2xl font-bold text-red-400">{metrics.totalGeminiCalls}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Repository Breakdown */}
        {metrics.repositories.length > 0 && (
          <div className="bg-slate-700 rounded-lg p-6">
            <h2 className="text-xl font-bold text-white mb-6">📚 Repository Breakdown</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-slate-600">
                    <th className="px-4 py-2 text-slate-300">Repository</th>
                    <th className="px-4 py-2 text-slate-300">PRs Reviewed</th>
                    <th className="px-4 py-2 text-slate-300">Cache Hits</th>
                    <th className="px-4 py-2 text-slate-300">Cache Hit Ratio</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.repositories.map((repo) => (
                    <tr key={repo.id} className="border-b border-slate-600 hover:bg-slate-600">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-white">{repo.name}</p>
                        <p className="text-sm text-slate-400">{repo.fullName}</p>
                      </td>
                      <td className="px-4 py-3 text-white">{repo.prsReviewed}</td>
                      <td className="px-4 py-3 text-green-400">{repo.cacheHits}</td>
                      <td className="px-4 py-3">
                        <span className="px-3 py-1 bg-green-500/20 text-green-400 rounded">
                          {repo.cacheHitRatio}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ROI Summary */}
        <div className="mt-8 bg-gradient-to-r from-green-500 to-emerald-500 rounded-lg p-8">
          <h2 className="text-2xl font-bold text-white mb-4">🎯 ROI Summary</h2>
          <p className="text-white text-lg mb-4">
            By implementing intelligent caching, ReviewBuddy has achieved:
          </p>
          <ul className="space-y-2 text-white">
            <li>✅ <strong>{metrics.cacheHitRatio}%</strong> of reviews served from cache</li>
            <li>✅ <strong>{metrics.apiCallsSaved}</strong> API calls avoided</li>
            <li>✅ <strong>{metrics.estimatedSavings}</strong> in API costs saved</li>
            <li>✅ <strong>{metrics.totalPRs}</strong> PRs automatically reviewed</li>
            <li>✅ Average review time: <strong>{metrics.averageLatencyMs}ms</strong></li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  title,
  value,
  icon,
  color,
}: {
  title: string;
  value: string | number;
  icon: string;
  color: string;
}) {
  return (
    <div className={`bg-gradient-to-br ${color} rounded-lg p-6 text-white shadow-lg`}>
      <p className="text-3xl mb-2">{icon}</p>
      <p className="text-sm text-white/80 mb-2">{title}</p>
      <p className="text-3xl font-bold">{value}</p>
    </div>
  );
}
