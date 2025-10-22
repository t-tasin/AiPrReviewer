'use client';

import { useState, useEffect } from 'react';

interface Repository {
  id: number;
  githubRepoId: number;
  name: string;
  fullName: string;
  owner: string;
  installationId: number;
  configuration?: {
    id: number;
    customPrompt: string | null;
    enabled: boolean;
  };
}

interface Props {
  repository: Repository;
  onUpdate: () => void;
}

export default function RepositorySettings({ repository, onUpdate }: Props) {
  const [customPrompt, setCustomPrompt] = useState(
    repository.configuration?.customPrompt || ''
  );
  const [enabled, setEnabled] = useState(
    repository.configuration?.enabled ?? true
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState<'success' | 'error'>('success');

  const handleSave = async () => {
    try {
      setSaving(true);
      setMessage('');

      const response = await fetch('/api/config/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repositoryId: repository.id,
          customPrompt: customPrompt || null,
          enabled,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to update configuration');
      }

      setMessageType('success');
      setMessage('Configuration saved successfully!');
      onUpdate();

      setTimeout(() => setMessage(''), 3000);
    } catch (error) {
      setMessageType('error');
      setMessage(
        error instanceof Error ? error.message : 'Failed to save configuration'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setCustomPrompt(repository.configuration?.customPrompt || '');
    setEnabled(repository.configuration?.enabled ?? true);
  };

  return (
    <div className="rounded-lg bg-gray-800 p-6">
      <div className="mb-4">
        <h2 className="text-xl font-semibold text-white">{repository.name}</h2>
        <p className="text-sm text-gray-400">{repository.fullName}</p>
      </div>

      {message && (
        <div
          className={`mb-4 rounded-lg p-4 ${
            messageType === 'success'
              ? 'bg-green-900 text-green-200'
              : 'bg-red-900 text-red-200'
          }`}
        >
          {message}
        </div>
      )}

      <div className="space-y-6">
        {/* Enable/Disable Toggle */}
        <div>
          <label className="mb-2 block text-sm font-semibold text-white">
            Enable Gemini Reviewer for this repository
          </label>
          <label className="flex cursor-pointer items-center space-x-3">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-5 w-5 rounded bg-gray-700"
            />
            <span className="text-gray-400">
              {enabled ? 'Enabled' : 'Disabled'}
            </span>
          </label>
        </div>

        {/* Custom Prompt */}
        <div>
          <label className="mb-2 block text-sm font-semibold text-white">
            Custom AI Review Prompt
          </label>
          <p className="mb-3 text-xs text-gray-400">
            Leave blank to use the default prompt. You can customize the AI
            behavior for this repository.
          </p>
          <textarea
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder="You are a senior software engineer providing a code review..."
            rows={8}
            className="w-full rounded-lg bg-gray-700 px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>

        {/* Default Prompt Info */}
        <div className="rounded-lg bg-gray-700 p-4">
          <p className="text-sm font-semibold text-gray-300">
            Default Prompt (used if custom prompt is empty):
          </p>
          <p className="mt-2 text-xs text-gray-400">
            "You are a senior software engineer providing a code review. Review
            the following code diff and provide constructive feedback. Focus on
            potential bugs, code clarity, and adherence to best practices."
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-4">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 rounded-lg bg-blue-600 px-4 py-3 font-semibold text-white hover:bg-blue-700 disabled:bg-gray-600 transition"
          >
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
          <button
            onClick={handleReset}
            className="flex-1 rounded-lg border border-gray-600 px-4 py-3 font-semibold text-gray-300 hover:bg-gray-700 transition"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
