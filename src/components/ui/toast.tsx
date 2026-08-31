'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * The app had no way to tell a user anything.
 *
 * Every outcome in the dashboard — withdrawal failed, claim failed, key export
 * failed, "connect your wallet to send tips" — was written to `console.error`.
 * From the user's side, buttons simply did nothing. This is the missing half of
 * every one of those interactions.
 */

export type ToastTone = 'success' | 'error' | 'info' | 'pending';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
  /** Optional link rendered as an action, e.g. a block explorer transaction. */
  action?: { label: string; href: string };
  /** Milliseconds before auto-dismiss. `null` keeps it until dismissed. */
  duration: number | null;
}

interface ToastContextValue {
  toast: (t: Omit<Toast, 'id' | 'duration'> & { duration?: number | null }) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return ctx;
}

const DEFAULT_DURATIONS: Record<ToastTone, number | null> = {
  success: 6000,
  info: 5000,
  pending: null,
  // Errors stay until dismissed — the user needs to be able to read and act on
  // them, and an error that vanishes is barely better than a console.log.
  error: null,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastContextValue['toast']>((input) => {
    const id = nextId.current++;
    const duration = input.duration !== undefined ? input.duration : DEFAULT_DURATIONS[input.tone];
    setToasts((prev) => [...prev, { ...input, id, duration }]);
    return id;
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div
      // `polite` rather than `assertive` so a screen reader finishes the current
      // sentence before announcing; errors are not interruptions here.
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

const TONE_STYLES: Record<ToastTone, { ring: string; icon: string; label: string }> = {
  success: { ring: 'ring-emerald-400/30 bg-emerald-950/80', icon: '✓', label: 'Success' },
  error: { ring: 'ring-red-400/30 bg-red-950/80', icon: '!', label: 'Error' },
  info: { ring: 'ring-sky-400/30 bg-sky-950/80', icon: 'i', label: 'Note' },
  pending: { ring: 'ring-amber-400/30 bg-amber-950/80', icon: '…', label: 'In progress' },
};

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [leaving, setLeaving] = useState(false);
  const styles = TONE_STYLES[toast.tone];

  useEffect(() => {
    if (toast.duration === null) return;
    const timer = setTimeout(() => setLeaving(true), toast.duration);
    return () => clearTimeout(timer);
  }, [toast.duration]);

  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => onDismiss(toast.id), 200);
    return () => clearTimeout(timer);
  }, [leaving, onDismiss, toast.id]);

  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      data-leaving={leaving || undefined}
      className={`pointer-events-auto w-full max-w-sm rounded-xl px-4 py-3 text-white shadow-lg ring-1 backdrop-blur-md ${styles.ring} motion-safe:animate-[toast-in_200ms_ease-out] data-[leaving]:opacity-0 data-[leaving]:translate-y-1 transition duration-200`}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs"
        >
          {styles.icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug">{toast.title}</p>
          {toast.description && (
            // `break-words` matters: these carry addresses and transaction hashes,
            // which are single 88-character tokens that otherwise blow out the card.
            <p className="mt-1 break-words text-xs font-light leading-relaxed text-white/70">
              {toast.description}
            </p>
          )}
          {toast.action && (
            <a
              href={toast.action.href}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block rounded-md px-2 py-1 text-xs font-medium text-white underline decoration-white/40 underline-offset-2 hover:decoration-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              {toast.action.label} ↗
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={() => setLeaving(true)}
          aria-label={`Dismiss ${styles.label.toLowerCase()} message`}
          className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-white/50 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden fill="none">
            <path
              d="M3 3l8 8M11 3l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
