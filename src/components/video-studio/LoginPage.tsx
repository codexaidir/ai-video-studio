'use client';

import React, { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { Mail, Lock, Loader2, Film, AlertCircle } from 'lucide-react';

export default function LoginPage() {
  const { signInWithPassword } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError('Please enter both email and password.');
      return;
    }
    setError(null);
    setLoading(true);

    const { error: authErr } = await signInWithPassword(email.trim(), password);
    if (authErr) {
      setError(authErr.message || 'Authentication failed.');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-[#0A0A0C] text-[#EDEDEF] flex flex-col justify-center items-center px-4 relative overflow-hidden">
      {/* Ambient background glows */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-purple-900/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-1/4 left-1/3 w-80 h-80 bg-indigo-900/8 rounded-full blur-[100px] pointer-events-none" />

      <div className="w-full max-w-md z-10">
        {/* Brand header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center p-3 bg-purple-950/40 border border-purple-800/30 rounded-2xl mb-4 shadow-inner shadow-purple-500/10">
            <Film className="w-8 h-8 text-purple-400" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white mb-2">
            AI Video Studio
          </h1>
          <p className="text-sm text-gray-400">
            Create cinematic videos using Stable Diffusion
          </p>
        </div>

        {/* Login card */}
        <div className="bg-[#121215] border border-[#242429] rounded-2xl shadow-xl shadow-black/60 p-8">
          <div className="mb-6">
            <h2 className="text-xl font-semibold text-white">Welcome back</h2>
            <p className="text-xs text-gray-400 mt-1">
              Sign in with your administrator-assigned credentials
            </p>
          </div>

          {/* Error banner */}
          {error && (
            <div className="flex items-start gap-3 bg-red-950/30 border border-red-900/50 text-red-300 p-4 rounded-xl text-sm mb-6">
              <AlertCircle className="w-5 h-5 shrink-0 text-red-400" />
              <div>
                <p className="font-medium">Authentication Failed</p>
                <p className="text-xs text-red-200/80 mt-0.5">{error}</p>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Email */}
            <div>
              <label
                className="block text-xs font-medium text-gray-300 uppercase tracking-wider mb-2"
                htmlFor="login-email"
              >
                Email Address
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-500">
                  <Mail className="w-4 h-4" />
                </div>
                <input
                  id="login-email"
                  type="email"
                  required
                  placeholder="name@domain.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                  className="block w-full pl-10 pr-4 py-3 bg-[#1A1A1E] border border-[#2D2D34] rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/40 focus:border-purple-500 transition-all"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label
                className="block text-xs font-medium text-gray-300 uppercase tracking-wider mb-2"
                htmlFor="login-password"
              >
                Password
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-500">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  id="login-password"
                  type="password"
                  required
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  className="block w-full pl-10 pr-4 py-3 bg-[#1A1A1E] border border-[#2D2D34] rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/40 focus:border-purple-500 transition-all"
                />
              </div>
            </div>

            {/* Submit */}
            <button
              id="login-btn"
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 px-4 py-3.5 bg-gradient-to-r from-purple-600 to-violet-600 hover:from-purple-500 hover:to-violet-500 text-white font-medium rounded-xl text-sm transition-all focus:outline-none focus:ring-2 focus:ring-purple-500/50 shadow-lg shadow-purple-950/20 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                'Log In'
              )}
            </button>
          </form>
        </div>

        {/* Footer */}
        <p className="text-center mt-8 text-xs text-gray-500">
          Powered by FastAPI GPU Node &amp; Supabase Edge Functions.
        </p>
      </div>
    </div>
  );
}