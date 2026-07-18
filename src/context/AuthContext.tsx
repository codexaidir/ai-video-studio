'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '@/lib/supabaseClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthContextType {
  session: Session | null;
  user: User | null;
  loading: boolean;
  sandboxMode: boolean;
  signInWithPassword: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [sandboxMode] = useState(!isSupabaseConfigured);
  const initializedRef = useRef(false);

  // ---- Initialise session on mount ----
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    if (isSupabaseConfigured) {
      // Real Supabase mode
      supabase.auth
        .getSession()
        .then(({ data: { session: initialSession } }) => {
          setSession(initialSession);
          setUser(initialSession?.user ?? null);
        })
        .catch((err) => console.error('Error fetching initial session:', err))
        .finally(() => setLoading(false));

      const { data: { subscription } } = supabase.auth.onAuthStateChange(
        (_event, currentSession) => {
          setSession(currentSession);
          setUser(currentSession?.user ?? null);
          setLoading(false);
        }
      );

      return () => subscription.unsubscribe();
    } else {
      // Sandbox / demo mode – hydrate from localStorage via async path
      // to avoid synchronous setState in effect body.
      Promise.resolve().then(() => {
        try {
          const stored = localStorage.getItem('ai_studio_user_session');
          if (stored) {
            const parsed = JSON.parse(stored);
            setUser(parsed.user ?? null);
            setSession(parsed as unknown as Session);
          }
        } catch {
          /* ignore corrupt data */
        }
      }).finally(() => setLoading(false));
    }
  }, []);

  // ---- Sign In ----
  const signInWithPassword = useCallback(
    async (email: string, password: string) => {
      if (isSupabaseConfigured) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error: error as Error | null };
      }

      // Sandbox mode – accept any email/password
      await new Promise((r) => setTimeout(r, 800)); // simulate latency
      const mockUser = {
        id: 'sandbox-user-001',
        email,
        role: 'authenticated',
        aud: 'authenticated',
        app_metadata: {},
        user_metadata: {},
        created_at: new Date().toISOString(),
      } as unknown as User;

      const mockSession = {
        access_token: 'mock-jwt',
        user: mockUser,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'bearer',
      } as unknown as Session;

      setUser(mockUser);
      setSession(mockSession);
      localStorage.setItem('ai_studio_user_session', JSON.stringify(mockSession));
      return { error: null };
    },
    []
  );

  // ---- Sign Out ----
  const signOut = useCallback(async () => {
    if (isSupabaseConfigured) {
      await supabase.auth.signOut().catch(console.error);
    } else {
      localStorage.removeItem('ai_studio_user_session');
    }
    setSession(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ session, user, loading, sandboxMode, signInWithPassword, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export const useAuth = (): AuthContextType => {
  const ctx = useContext(AuthContext);
  if (ctx === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
};