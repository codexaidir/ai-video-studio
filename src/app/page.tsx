'use client';

import { AuthProvider, useAuth } from '@/context/AuthContext';
import LoginPage from '@/components/video-studio/LoginPage';
import Dashboard from '@/components/video-studio/Dashboard';
import { Loader2 } from 'lucide-react';

// ---------------------------------------------------------------------------
// Inner shell that reads auth state and routes accordingly
// ---------------------------------------------------------------------------

function AppShell() {
  const { user, loading } = useAuth();

  // Initialising – show spinner
  if (loading) {
    return (
      <div className="min-h-screen bg-[#0A0A0C] flex flex-col items-center justify-center text-[#EDEDEF]">
        <Loader2 className="w-10 h-10 animate-spin text-purple-500 mb-4" />
        <p className="text-sm text-gray-400 font-mono">
          Initializing secure connection…
        </p>
      </div>
    );
  }

  // Not logged in → show login
  if (!user) {
    return <LoginPage />;
  }

  // Logged in → show dashboard
  return <Dashboard />;
}

// ---------------------------------------------------------------------------
// Page – wraps everything in the AuthProvider
// ---------------------------------------------------------------------------

export default function HomePage() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}