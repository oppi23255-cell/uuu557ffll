/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  CRASHED_DURATION_MS,
  WAITING_DURATION_MS,
  fetchFirebaseActivationCode,
  saveFirebaseActivationCode,
  subscribeConnectionState,
  subscribeCrashCurrent,
  subscribeCrashHistory,
  subscribeCrashNextPrediction,
  subscribeCrashOverride,
  subscribeCrashPrediction,
  writeNextPrediction,
  type CrashCurrent,
  type CrashHistoryItem,
  type CrashPrediction,
} from './firebase';

type Screen = 'splash' | 'login' | 'getCode' | 'main';

const FORECAST_GIF_URL = 'https://i.postimg.cc/8zvcY1Mt/m.gif';
const FORECAST_GIF_FALLBACK = '/m.gif';

interface StoredCode {
  code: string;
  is_active: boolean;
  type: 'airplane' | 'apple' | 'apple_promo';
  expires_at: string;
  created_for: string;
  used_attempts?: number;
  total_attempts?: number;
}

interface CustomAlertState {
  open: boolean;
  type: 'success' | 'error';
  title: string;
  message: string;
  codeHighlight?: string;
  reminder?: string;
  buttonText: string;
  onConfirm?: () => void;
}

const LOGO_URL = '/src/assets/images/hack_lions_logo_1794853671925.jpg';
const PLAYER_ID_ICON_URL = '/src/assets/images/player_id_icon_1794853671505.jpg';
const PROMO_CODE = 'Mero990';
const STORAGE_KEY = 'hack_lions_activation_codes';
const SPLASH_DURATION_MS = 3500;

const PLATFORMS_ROW_1 = [
  { id: 'LINEBET', label: 'LINEBET', colorClass: 'text-[#00ff00]' },
  { id: '1XBET', label: '1XBET', colorClass: 'text-[#ff4500]' },
  { id: 'MELBET', label: 'MELBET', colorClass: 'text-[#ffff00]' },
];

const PLATFORMS_ROW_2 = [
  { id: 'Megapari', label: 'Megapari', colorClass: 'text-[#ff4500]' },
  { id: '888starz', label: '888starz', colorClass: 'text-[#ff0000]' },
  { id: 'BETWINNER', label: 'BETWINNER', colorClass: 'text-[#ffc107]' },
];

function generateActivationCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const segments = [5, 5, 5, 5];
  return segments
    .map((len) => {
      let segment = '';
      for (let i = 0; i < len; i++) {
        segment += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return segment;
    })
    .join('-');
}

function generateCrashPrediction(previousValue?: number, history: CrashHistoryItem[] = []): number {
  const recentPoints = new Set(history.slice(0, 4).map((h) => h.crashPoint.toFixed(2)));
  for (let attempt = 0; attempt < 8; attempt++) {
    const r = Math.max(0.05, Math.random());
    const raw = Math.min(18.0, Math.max(1.12, 0.96 / r));
    const rounded = Math.round(raw * 100) / 100;
    if (rounded > 1.0 && rounded !== previousValue && !recentPoints.has(rounded.toFixed(2))) {
      return rounded;
    }
  }
  return 2.35;
}

function isPlatformRoundStale(current: CrashCurrent | null, now = Date.now()): boolean {
  if (!current || !current.roundNumber) return true;
  if (current.phase === 'crashed') {
    return now - current.updatedAt > CRASHED_DURATION_MS + 4000;
  }
  if (current.phase === 'waiting') {
    return now - current.roundStartedAt > WAITING_DURATION_MS + 5000;
  }
  if (current.phase === 'flight') {
    if (current.crashPoint > 1) {
      const expectedFlightMs = (Math.log(current.crashPoint) / 0.09) * 1000;
      return now - current.flightStartedAt > expectedFlightMs + 6000;
    }
    return now - current.flightStartedAt > 18000;
  }
  return true;
}

function loadStoredCodes(): Record<string, StoredCode> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveStoredCode(entry: StoredCode): void {
  try {
    const existing = loadStoredCodes();
    existing[entry.code] = entry;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
  } catch {
    // Ignore storage quota errors
  }
}

async function copyTextSafely(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('splash');
  const [splashProgress, setSplashProgress] = useState(0);
  const [logoImgFailed, setLogoImgFailed] = useState(false);
  const [idIconFailed, setIdIconFailed] = useState(false);

  // Firebase RTDB connection state
  const [isFirebaseConnected, setIsFirebaseConnected] = useState(false);

  // Live Crash RTDB state (automatic onValue listeners)
  const [crashCurrent, setCrashCurrent] = useState<CrashCurrent | null>(null);
  const [crashCurrentLoaded, setCrashCurrentLoaded] = useState(false);
  const [crashPrediction, setCrashPrediction] = useState<CrashPrediction | null>(null);
  const [crashNextPrediction, setCrashNextPrediction] = useState<CrashPrediction | null>(null);
  const [crashOverride, setCrashOverride] = useState<CrashPrediction | null>(null);
  const [crashHistory, setCrashHistory] = useState<CrashHistoryItem[]>([]);

  // Active prediction state (works both when platform is live AND continuously when platform is idle)
  const [activePrediction, setActivePrediction] = useState<{ roundNumber: number; crashPoint: number } | null>(null);
  const lastPredictedRoundRef = useRef<number>(0);
  const lastPredictionValueRef = useRef<number | undefined>(undefined);
  const crashHistoryRef = useRef<CrashHistoryItem[]>([]);
  crashHistoryRef.current = crashHistory;

  // Login state
  const [selectedPlatform, setSelectedPlatform] = useState('1XBET');
  const [playerId, setPlayerId] = useState('');
  const [activationCode, setActivationCode] = useState('');
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Connection toast
  const [connectionMessage, setConnectionMessage] = useState('');
  const [showConnectionToast, setShowConnectionToast] = useState(false);
  const toastTimer1Ref = useRef<number | null>(null);
  const toastTimer2Ref = useRef<number | null>(null);

  // Modals
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [customAlert, setCustomAlert] = useState<CustomAlertState>({
    open: false,
    type: 'success',
    title: '',
    message: '',
    buttonText: 'حسنًا',
  });

  // Code Generator state
  const [genPlayerId, setGenPlayerId] = useState('');
  const [preview1, setPreview1] = useState<string | null>(null);
  const [preview2, setPreview2] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const [gifSrc, setGifSrc] = useState(FORECAST_GIF_URL);

  // Splash loading bar & transition
  useEffect(() => {
    if (screen !== 'splash') return;

    const progressTick = window.setTimeout(() => {
      setSplashProgress(100);
    }, 60);

    const finishTimer = window.setTimeout(() => {
      setScreen('login');
    }, SPLASH_DURATION_MS);

    return () => {
      window.clearTimeout(progressTick);
      window.clearTimeout(finishTimer);
    };
  }, [screen]);

  // Subscribe to Firebase RTDB connection state globally
  useEffect(() => {
    const unsub = subscribeConnectionState(setIsFirebaseConnected);
    return () => unsub();
  }, []);

  // Automatically listen to crash/current, crash/prediction, crash/nextPrediction, crash/override, crash/history
  useEffect(() => {
    if (screen !== 'main') return;

    const unsubCurrent = subscribeCrashCurrent((data) => {
      setCrashCurrent(data);
      setCrashCurrentLoaded(true);
    });
    const unsubPrediction = subscribeCrashPrediction(setCrashPrediction);
    const unsubNextPrediction = subscribeCrashNextPrediction(setCrashNextPrediction);
    const unsubOverride = subscribeCrashOverride(setCrashOverride);
    const unsubHistory = subscribeCrashHistory(setCrashHistory);

    return () => {
      unsubCurrent();
      unsubPrediction();
      unsubNextPrediction();
      unsubOverride();
      unsubHistory();
    };
  }, [screen]);

  // 1. Live Platform Sync: whenever crash/current updates on Firebase, sync or generate prediction for the round
  useEffect(() => {
    if (screen !== 'main' || !crashCurrent || !crashCurrent.roundNumber) return;
    if (isPlatformRoundStale(crashCurrent)) return;

    const currentRound = crashCurrent.roundNumber;
    const phase = crashCurrent.phase;

    let targetRound: number | null = null;
    if (phase === 'crashed') {
      targetRound = currentRound + 1;
    } else if (phase === 'waiting') {
      targetRound = currentRound;
    } else if (phase === 'flight' && lastPredictedRoundRef.current < currentRound) {
      targetRound = currentRound;
    }

    if (targetRound === null) return;
    if (lastPredictedRoundRef.current >= targetRound) return;

    const hasValidOverride =
      crashOverride &&
      crashOverride.crashPoint > 1 &&
      (crashOverride.roundNumber === undefined || crashOverride.roundNumber === targetRound);

    const hasValidPlatformPrediction =
      crashPrediction &&
      crashPrediction.crashPoint > 1 &&
      crashPrediction.roundNumber === targetRound;

    const hasValidCurrentPoint =
      phase !== 'crashed' &&
      targetRound === currentRound &&
      crashCurrent.crashPoint > 1;

    const hasValidNextPrediction =
      crashNextPrediction &&
      crashNextPrediction.crashPoint > 1 &&
      crashNextPrediction.roundNumber === targetRound;

    if (hasValidOverride || hasValidCurrentPoint || hasValidPlatformPrediction || hasValidNextPrediction) {
      const chosenPoint = hasValidOverride
        ? crashOverride!.crashPoint
        : hasValidCurrentPoint
          ? crashCurrent.crashPoint
          : hasValidPlatformPrediction
            ? crashPrediction!.crashPoint
            : crashNextPrediction!.crashPoint;

      lastPredictedRoundRef.current = targetRound;
      lastPredictionValueRef.current = chosenPoint;
      setActivePrediction({ roundNumber: targetRound, crashPoint: chosenPoint });
      return;
    }

    // Platform has no > 1 prediction for targetRound -> generate and write to crash/nextPrediction
    lastPredictedRoundRef.current = targetRound;
    const nextPoint = generateCrashPrediction(lastPredictionValueRef.current, crashHistoryRef.current);
    lastPredictionValueRef.current = nextPoint;
    setActivePrediction({ roundNumber: targetRound, crashPoint: nextPoint });

    writeNextPrediction(nextPoint, targetRound).catch((err) => {
      console.error('Failed to write crash/nextPrediction:', err);
    });
  }, [
    screen,
    crashCurrent,
    crashPrediction,
    crashNextPrediction,
    crashOverride,
  ]);

  // 2. Continuous Autonomous Cycle: if the user isn't inside MaxBet (so crash/current is stale/idle),
  // keep advancing round-by-round using the exact MaxBet timing (4800ms waiting + flight + 2200ms crashed)
  // and continuously fetching/writing fresh predictions for every new round.
  useEffect(() => {
    if (screen !== 'main' || !crashCurrentLoaded) return;

    let timerId: number | null = null;
    let cancelled = false;

    const scheduleNextRound = () => {
      if (cancelled) return;

      const now = Date.now();
      if (crashCurrent && !isPlatformRoundStale(crashCurrent, now)) {
        // Platform is currently active — re-check after a short interval in case it pauses later
        timerId = window.setTimeout(scheduleNextRound, 2500);
        return;
      }

      const baseRound = Math.max(
        lastPredictedRoundRef.current,
        crashCurrent?.roundNumber ?? 0
      );
      const nextRound = baseRound + 1;
      const nextPoint = generateCrashPrediction(lastPredictionValueRef.current, crashHistoryRef.current);

      lastPredictedRoundRef.current = nextRound;
      lastPredictionValueRef.current = nextPoint;
      setActivePrediction({ roundNumber: nextRound, crashPoint: nextPoint });

      writeNextPrediction(nextPoint, nextRound).catch((err) => {
        console.error('Failed to write autonomous crash/nextPrediction:', err);
      });

      const flightDurationMs = Math.max(1000, (Math.log(nextPoint) / 0.09) * 1000);
      const fullRoundMs = WAITING_DURATION_MS + flightDurationMs + CRASHED_DURATION_MS;

      timerId = window.setTimeout(scheduleNextRound, fullRoundMs);
    };

    // Start immediately if platform is stale/idle, otherwise monitor periodically
    if (!crashCurrent || isPlatformRoundStale(crashCurrent)) {
      scheduleNextRound();
    } else {
      timerId = window.setTimeout(scheduleNextRound, 3000);
    }

    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [screen, crashCurrentLoaded, crashCurrent]);

  // Cleanup connection toast timers
  useEffect(() => {
    return () => {
      if (toastTimer1Ref.current) window.clearTimeout(toastTimer1Ref.current);
      if (toastTimer2Ref.current) window.clearTimeout(toastTimer2Ref.current);
    };
  }, []);

  const handlePlatformSelect = (platformId: string) => {
    setSelectedPlatform(platformId);

    if (toastTimer1Ref.current) window.clearTimeout(toastTimer1Ref.current);
    if (toastTimer2Ref.current) window.clearTimeout(toastTimer2Ref.current);

    setConnectionMessage(`جاري الاتصال بسيرفر ${platformId}...`);
    setShowConnectionToast(true);

    toastTimer1Ref.current = window.setTimeout(() => {
      setConnectionMessage(`تم الاتصال بسيرفر ${platformId}`);
      toastTimer2Ref.current = window.setTimeout(() => {
        setShowConnectionToast(false);
      }, 2000);
    }, 2000);
  };

  const handleCopyPromo = async () => {
    const copied = await copyTextSafely(PROMO_CODE);
    if (copied) {
      setShowCopyModal(true);
    } else {
      setCustomAlert({
        open: true,
        type: 'error',
        title: 'Error',
        message: 'فشل نسخ الكود، يرجى نسخه يدويًا.',
        buttonText: 'حسنًا',
      });
    }
  };

  const handleActivateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');

    const trimmedId = playerId.trim();
    const trimmedCode = activationCode.trim();

    if (!trimmedId || !trimmedCode) {
      setCustomAlert({
        open: true,
        type: 'error',
        title: 'Error',
        message: 'يرجى كتابة الـ ID وكود التفعيل',
        buttonText: 'حسنًا',
      });
      return;
    }

    setIsSubmitting(true);
    setStatusMessage('Activation code is being verified');

    const firebaseMatch = await fetchFirebaseActivationCode(trimmedCode);
    const localCodes = loadStoredCodes();
    const codeData = firebaseMatch?.data ?? localCodes[trimmedCode];

    if (!codeData) {
      setStatusMessage(null);
      setLoginError('كود التفعيل غير صحيح');
      setIsSubmitting(false);
      return;
    }

    if (!codeData.is_active) {
      setStatusMessage(null);
      setLoginError('هذا الكود غير نشط');
      setIsSubmitting(false);
      return;
    }

    if (codeData.type === 'airplane' && codeData.expires_at) {
      const now = Date.now();
      const expiry = new Date(codeData.expires_at).getTime();
      if (now >= expiry) {
        setStatusMessage(null);
        setLoginError('كود التفعيل منتهي الصلاحية');
        setIsSubmitting(false);
        return;
      }
    }

    setStatusMessage(`I am contacting my server...\nPlayer ID: ${trimmedId}`);
    await new Promise((resolve) => window.setTimeout(resolve, 1000));

    setStatusMessage(null);
    setIsSubmitting(false);
    setScreen('main');
  };

  const handleFileChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    setter: React.Dispatch<React.SetStateAction<string | null>>
  ) => {
    const file = e.target.files?.[0];
    if (!file) {
      setter(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (typeof ev.target?.result === 'string') {
        setter(ev.target.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleGenerateCode = async () => {
    const trimmedId = genPlayerId.trim();
    if (!trimmedId || !preview1 || !preview2) {
      setCustomAlert({
        open: true,
        type: 'error',
        title: 'Error',
        message: 'يرجى إدخال ID حسابك واختيار الصورتين معًا.',
        buttonText: 'حسنًا',
      });
      return;
    }

    setIsGenerating(true);

    const newCode = generateActivationCode();
    const expiryTime = Date.now() + 10 * 60 * 1000;
    const expiryIso = new Date(expiryTime).toISOString();

    const entry: StoredCode = {
      code: newCode,
      is_active: true,
      type: 'airplane',
      expires_at: expiryIso,
      created_for: trimmedId,
    };

    saveStoredCode(entry);
    await saveFirebaseActivationCode(newCode, trimmedId, expiryIso);

    setIsGenerating(false);
    setCustomAlert({
      open: true,
      type: 'success',
      title: 'KEY',
      message: 'تم إنشاء كود التفعيل الخاص بك وهو:',
      codeHighlight: newCode,
      reminder: 'وتذكر أنه لن يتم تفعيل سيرفر الاسكريبت إلا إذا قمت ببقية الخطوات المطلوبة.',
      buttonText: 'حسنًا',
      onConfirm: async () => {
        await copyTextSafely(newCode);
        setPlayerId(trimmedId);
        setActivationCode(newCode);
        setLoginError('');
        setScreen('login');
      },
    });
  };

  const displayRoundNumber = activePrediction?.roundNumber ?? crashCurrent?.roundNumber;

  const activePredictionValue = (() => {
    const currentRound = crashCurrent?.roundNumber ?? 0;
    const platformLive = !isPlatformRoundStale(crashCurrent);

    if (platformLive) {
      if (
        crashOverride &&
        crashOverride.crashPoint > 1 &&
        (crashOverride.roundNumber === undefined || crashOverride.roundNumber >= currentRound)
      ) {
        return crashOverride.crashPoint.toFixed(2);
      }
      if (
        crashCurrent &&
        (crashCurrent.phase === 'waiting' || crashCurrent.phase === 'flight') &&
        crashCurrent.crashPoint > 1
      ) {
        return crashCurrent.crashPoint.toFixed(2);
      }
      if (
        crashPrediction &&
        crashPrediction.crashPoint > 1 &&
        (crashPrediction.roundNumber === undefined || crashPrediction.roundNumber >= currentRound)
      ) {
        return crashPrediction.crashPoint.toFixed(2);
      }
    }

    if (activePrediction && activePrediction.crashPoint > 1) {
      return activePrediction.crashPoint.toFixed(2);
    }

    if (crashNextPrediction && crashNextPrediction.crashPoint > 1) {
      return crashNextPrediction.crashPoint.toFixed(2);
    }

    return '0.00';
  })();

  const isLogoShrunk = isInputFocused || playerId.length > 0 || activationCode.length > 0;

  return (
    <div className="relative w-full h-full bg-black text-white select-none">
      {/* Status Verification Modal */}
      {statusMessage && (
        <div className="status-modal" role="dialog" aria-modal="true">
          <div className="status-box">
            <div className="spinner" aria-hidden="true" />
            <span className="text-base font-bold whitespace-pre-line text-center">{statusMessage}</span>
          </div>
        </div>
      )}

      {/* Splash Screen */}
      {screen === 'splash' && (
        <div
          className="splash-screen"
          onClick={() => setScreen('login')}
          title="اضغط للمتابعة"
        >
          {!logoImgFailed ? (
            <img
              src={LOGO_URL}
              alt="Hack Lions Logo"
              className="splash-logo"
              referrerPolicy="no-referrer"
              onError={() => setLogoImgFailed(true)}
            />
          ) : (
            <div className="splash-logo flex items-center justify-center border-4 border-[#ff4500] bg-neutral-950 text-[#ff4500] font-orbitron text-3xl font-bold">
              HL
            </div>
          )}
          <h1 className="splash-text font-orbitron tracking-wider">WELCOME TO HACK LIONS</h1>
          <div className="loading-bar-container">
            <div
              className="loading-bar-progress"
              style={{
                width: `${splashProgress}%`,
                transition: `width ${SPLASH_DURATION_MS / 1000}s linear`,
              }}
            />
          </div>
        </div>
      )}

      {/* Top Server Status on Login Screen */}
      {screen === 'login' && (
        <div className="top-info-container">
          <div className="top-info-box" dir="ltr">
            SERVER: <span>{isFirebaseConnected ? 'LIVE' : 'CONNECTING'}</span>
          </div>
        </div>
      )}

      {/* Login Screen */}
      {screen === 'login' && (
        <div className="login-screen">
          {!logoImgFailed ? (
            <img
              src={LOGO_URL}
              alt="Hack Lions Logo"
              className={`page-logo ${isLogoShrunk ? 'shrunk' : ''}`}
              referrerPolicy="no-referrer"
              onError={() => setLogoImgFailed(true)}
            />
          ) : (
            <div
              className={`page-logo flex items-center justify-center bg-neutral-950 text-[#ff4500] font-orbitron font-bold ${
                isLogoShrunk ? 'shrunk text-lg' : 'text-2xl'
              }`}
            >
              HL
            </div>
          )}

          {/* Promo Code Bar */}
          <div className="promo-code-bar">
            <span dir="ltr">
              Work On ALL With Promocode: <b>{PROMO_CODE}</b>
            </span>
            <button
              type="button"
              onClick={handleCopyPromo}
              className="copy-icon-btn"
              aria-label="Copy promocode"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
          </div>

          {/* Platforms Selector */}
          <div className="platforms-wrapper">
            <div className="platforms-container">
              <div className="platform-row-box">
                {PLATFORMS_ROW_1.map((platform) => (
                  <label key={platform.id} className="checkbox-label">
                    <input
                      type="checkbox"
                      name="bet_option"
                      checked={selectedPlatform === platform.id}
                      onChange={() => handlePlatformSelect(platform.id)}
                    />
                    <span className={platform.colorClass}>{platform.label}</span>
                  </label>
                ))}
              </div>
              <div className="platform-row-box">
                {PLATFORMS_ROW_2.map((platform) => (
                  <label key={platform.id} className="checkbox-label">
                    <input
                      type="checkbox"
                      name="bet_option"
                      checked={selectedPlatform === platform.id}
                      onChange={() => handlePlatformSelect(platform.id)}
                    />
                    <span className={platform.colorClass}>{platform.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* Login Form Container */}
          <form onSubmit={handleActivateSubmit} className="login-container">
            <div className="input-wrapper">
              <input
                type="text"
                className="code-input"
                placeholder="Player ID"
                maxLength={10}
                value={playerId}
                onChange={(e) => setPlayerId(e.target.value)}
                onFocus={() => setIsInputFocused(true)}
                onBlur={() => setIsInputFocused(false)}
                required
              />
              <div className="input-icon">
                {!idIconFailed ? (
                  <img
                    src={PLAYER_ID_ICON_URL}
                    alt="ID"
                    className="w-6 h-6 object-cover rounded-sm"
                    referrerPolicy="no-referrer"
                    onError={() => setIdIconFailed(true)}
                  />
                ) : (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#00ff00" strokeWidth="2">
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <circle cx="9" cy="10" r="2" />
                    <path d="M6 16c0-1.5 1.5-2.5 3-2.5s3 1 3 2.5" />
                    <line x1="14" y1="9" x2="18" y2="9" />
                    <line x1="14" y1="13" x2="18" y2="13" />
                  </svg>
                )}
              </div>
            </div>

            <div className="input-wrapper">
              <input
                type="password"
                className="code-input"
                placeholder="Activation Code"
                value={activationCode}
                onChange={(e) => setActivationCode(e.target.value)}
                onFocus={() => setIsInputFocused(true)}
                onBlur={() => setIsInputFocused(false)}
                required
              />
              <div className="input-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M16.5 8.25V6C16.5 3.51472 14.4853 1.5 12 1.5C9.51472 1.5 7.5 3.51472 7.5 6V8.25"
                    stroke="#00ff00"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M19.5 12.75H4.5C3.67157 12.75 3 13.4216 3 14.25V21C3 21.8284 3.67157 22.5 4.5 22.5H19.5C20.3284 22.5 21 21.8284 21 21V14.25C21 13.4216 20.3284 12.75 19.5 12.75Z"
                    stroke="#00ff00"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M12 17.25V18"
                    stroke="#00ff00"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            </div>

            {loginError && (
              <div className="text-[#ff4d4d] text-sm font-semibold -mt-1">
                <span>{loginError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="activate-submit-btn"
            >
              Activate
            </button>
          </form>

          {/* Get Code via Steps Button with CSS Animated Robot */}
          <button
            type="button"
            onClick={() => {
              setLoginError('');
              setScreen('getCode');
            }}
            className="get-code-btn"
          >
            <div className="robot-realistic" aria-hidden="true">
              <div className="head">
                <div className="eye left-eye" />
                <div className="eye right-eye" />
              </div>
              <div className="body" />
              <div className="arm left-arm" />
              <div className="arm right-arm" />
            </div>
            <span>أخذ كود عن طريق خطوات</span>
          </button>
        </div>
      )}

      {/* Code Generator Screen */}
      {screen === 'getCode' && (
        <div className="getcode-screen">
          <div className="futuristic-form-v2">
            <h2 className="form-title-v2">CODE GENERATOR</h2>

            <div className="input-wrapper mb-[30px]">
              <input
                type="text"
                className="code-input"
                placeholder="Player ID"
                maxLength={10}
                value={genPlayerId}
                onChange={(e) => setGenPlayerId(e.target.value)}
                required
              />
              <div className="input-icon">
                {!idIconFailed ? (
                  <img
                    src={PLAYER_ID_ICON_URL}
                    alt="ID"
                    className="w-6 h-6 object-cover rounded-sm"
                    referrerPolicy="no-referrer"
                    onError={() => setIdIconFailed(true)}
                  />
                ) : (
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#00ff00" strokeWidth="2">
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <circle cx="9" cy="10" r="2" />
                    <path d="M6 16c0-1.5 1.5-2.5 3-2.5s3 1 3 2.5" />
                  </svg>
                )}
              </div>
            </div>

            <p className="upload-prompt-v2 font-orbitron">UPLOAD PROOF OF REGISTRATION</p>

            <div className="image-upload-grid-v2">
              <label htmlFor="image-upload-1" className="upload-slot-v2">
                <input
                  id="image-upload-1"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleFileChange(e, setPreview1)}
                />
                {preview1 && (
                  <div
                    className="upload-preview-v2"
                    style={{ backgroundImage: `url('${preview1}')` }}
                  />
                )}
                <svg
                  className="upload-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </label>

              <label htmlFor="image-upload-2" className="upload-slot-v2">
                <input
                  id="image-upload-2"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleFileChange(e, setPreview2)}
                />
                {preview2 && (
                  <div
                    className="upload-preview-v2"
                    style={{ backgroundImage: `url('${preview2}')` }}
                  />
                )}
                <svg
                  className="upload-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </label>
            </div>

            <button
              type="button"
              disabled={isGenerating}
              onClick={handleGenerateCode}
              className="generate-button-v2 font-orbitron"
            >
              <span>{isGenerating ? 'GENERATING...' : 'GET MY CODE'}</span>
            </button>

            <button
              type="button"
              onClick={() => setScreen('login')}
              className="mt-4 w-full text-center text-sm text-neutral-400 hover:text-white transition-colors py-2 cursor-pointer"
            >
              العودة إلى تسجيل الدخول
            </button>
          </div>
        </div>
      )}

      {/* Main App Screen — Continuous Live & Autonomous Round Predictions */}
      {screen === 'main' && (
        <div className="main-app-screen">
          <div className="flex justify-center gap-4 w-full mb-4">
            <div className="custom-box border-green">
              <span>ID:</span>
              <span>{playerId}</span>
            </div>
            <div className="custom-box border-blue" dir="ltr">
              <span>Round:</span>
              <span>{displayRoundNumber ? `#${displayRoundNumber}` : isFirebaseConnected ? 'LIVE' : '...'}</span>
            </div>
          </div>

          <div className="flex-grow min-h-0 flex items-center justify-center w-full my-3">
            <div className="relative flex items-center justify-center w-full h-full max-w-[560px]">
              <img
                src={gifSrc || 'https://i.postimg.cc/8zvcY1Mt/m.gif'}
                alt="Predictor Animation"
                referrerPolicy="no-referrer"
                onError={() => {
                  if (gifSrc !== FORECAST_GIF_FALLBACK) {
                    setGifSrc(FORECAST_GIF_FALLBACK);
                  }
                }}
                className="w-full h-full object-contain block"
              />
              <span
                className="absolute inset-0 flex items-center justify-center font-orbitron text-4xl sm:text-5xl font-bold text-white tabular-nums drop-shadow-[0_0_12px_rgba(0,0,0,0.95)] pointer-events-none"
                dir="ltr"
              >
                {activePredictionValue}
              </span>
            </div>
          </div>

          <div className="flex flex-col items-center gap-4 w-full">
            <button
              type="button"
              onClick={handleCopyPromo}
              className="main-promo-box cursor-pointer hover:bg-[#ff4500]/20 transition-colors"
              dir="ltr"
            >
              LIONS Promocode :- <span className="promo-code-highlight">{PROMO_CODE}</span>
            </button>
          </div>
        </div>
      )}

      {/* Bottom Server Connection Toast */}
      {connectionMessage && (
        <div
          className="connection-status-toast"
          style={{ opacity: showConnectionToast ? 1 : 0, pointerEvents: 'none' }}
        >
          {connectionMessage}
        </div>
      )}

      {/* Copy Promo Modal */}
      {showCopyModal && (
        <div className="copy-modal-overlay" role="dialog" aria-modal="true">
          <div className="copy-modal-content">
            <svg className="checkmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">
              <circle className="checkmark__circle" cx="26" cy="26" r="25" fill="none" />
              <path className="checkmark__check" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8" />
            </svg>
            <h3 className="modal-title">تم نسخ البروموكود بنجاح!</h3>
            <p className="modal-text">
              لكي يعمل معك الاسكريبت بشكل صحيح، يجب عليك انشاء حساب <b>جديد</b> بالبروموكود الخاص بنا وهو{' '}
              <span className="promo-highlight">{PROMO_CODE}</span>.
            </p>
            <div className="modal-buttons">
              <button
                type="button"
                onClick={() => setShowCopyModal(false)}
                className="modal-button primary"
              >
                عملت كدا بالفعل
              </button>
              <button
                type="button"
                onClick={() => setShowCopyModal(false)}
                className="modal-button secondary"
              >
                سوف أعمل الآن
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom Alert Modal (Error / Generated Key) */}
      {customAlert.open && (
        <div className="custom-alert-overlay" role="dialog" aria-modal="true">
          <div className="alert-modal-content">
            <div className={`alert-modal-header ${customAlert.type}`}>{customAlert.title}</div>
            <div className="alert-modal-body">
              <p>{customAlert.message}</p>
              {customAlert.codeHighlight && (
                <div className="code-highlight">{customAlert.codeHighlight}</div>
              )}
              {customAlert.reminder && (
                <div className="reminder">{customAlert.reminder}</div>
              )}
            </div>
            <div className="alert-modal-footer">
              <button
                type="button"
                onClick={() => {
                  const cb = customAlert.onConfirm;
                  setCustomAlert((prev) => ({ ...prev, open: false }));
                  if (cb) cb();
                }}
                className={`alert-modal-button ${customAlert.type}`}
              >
                {customAlert.buttonText}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
