import { getApp, getApps, initializeApp } from 'firebase/app';
import { get, getDatabase, limitToLast, onValue, query, ref, set, type Unsubscribe } from 'firebase/database';

const firebaseConfig = {
  apiKey: 'AIzaSyAlX1ASvDrf5BBtaB72AUYqSoW34YvP_y4',
  authDomain: 'mrwan-dd795.firebaseapp.com',
  databaseURL: 'https://mrwan-dd795-default-rtdb.firebaseio.com',
  projectId: 'mrwan-dd795',
  storageBucket: 'mrwan-dd795.firebasestorage.app',
  messagingSenderId: '12538399995',
  appId: '1:12538399995:web:4a7e6b40f611891fecb45e',
  measurementId: 'G-KBTHXXDYBL',
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const db = getDatabase(app);

export type CrashPhase = 'waiting' | 'flight' | 'crashed';

export interface CrashCurrent {
  roundNumber: number;
  phase: CrashPhase;
  crashPoint: number;
  roundStartedAt: number;
  flightStartedAt: number;
  updatedAt: number;
}

export interface CrashPrediction {
  roundNumber?: number;
  crashPoint: number;
  updatedAt: number;
}

export interface CrashHistoryItem {
  roundNumber: number;
  crashPoint: number;
  crashedAt: number;
}

export interface ActivationCodeRecord {
  code?: string;
  is_active: boolean;
  type: 'airplane' | 'apple' | 'apple_promo';
  expires_at?: string;
  created_for?: string;
  used_attempts?: number;
  total_attempts?: number;
}

export const WAITING_DURATION_MS = 4800;
export const CRASHED_DURATION_MS = 2200;

export function calculateLiveMultiplier(flightStartedAt: number, now = Date.now()): number {
  if (!flightStartedAt || now <= flightStartedAt) return 1.0;
  const elapsedSec = (now - flightStartedAt) / 1000;
  return Math.exp(0.09 * elapsedSec);
}

export function subscribeConnectionState(cb: (connected: boolean) => void): Unsubscribe {
  const connectedRef = ref(db, '.info/connected');
  return onValue(connectedRef, (snap) => {
    cb(Boolean(snap.val()));
  });
}

export function subscribeCrashCurrent(
  cb: (data: CrashCurrent | null) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const currentRef = ref(db, 'crash/current');
  return onValue(
    currentRef,
    (snapshot) => {
      const val = snapshot.val();
      if (!val || typeof val !== 'object') {
        cb(null);
        return;
      }
      cb({
        roundNumber: Number(val.roundNumber ?? 0),
        phase: (val.phase as CrashPhase) || 'waiting',
        crashPoint: Number(val.crashPoint ?? 0),
        roundStartedAt: Number(val.roundStartedAt ?? 0),
        flightStartedAt: Number(val.flightStartedAt ?? 0),
        updatedAt: Number(val.updatedAt ?? 0),
      });
    },
    (err) => onError?.(err)
  );
}

function parsePredictionSnapshot(val: unknown): CrashPrediction | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') {
    return val > 0 ? { crashPoint: val, updatedAt: Date.now() } : null;
  }
  if (typeof val === 'object') {
    const rec = val as Record<string, unknown>;
    const point = Number(rec.crashPoint ?? 0);
    if (Number.isNaN(point) || point <= 0) return null;
    return {
      roundNumber: rec.roundNumber !== undefined ? Number(rec.roundNumber) : undefined,
      crashPoint: point,
      updatedAt: Number(rec.updatedAt ?? 0),
    };
  }
  return null;
}

export function subscribeCrashPrediction(
  cb: (data: CrashPrediction | null) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const predRef = ref(db, 'crash/prediction');
  return onValue(
    predRef,
    (snapshot) => {
      cb(parsePredictionSnapshot(snapshot.val()));
    },
    (err) => onError?.(err)
  );
}

export function subscribeCrashNextPrediction(
  cb: (data: CrashPrediction | null) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const nextPredRef = ref(db, 'crash/nextPrediction');
  return onValue(
    nextPredRef,
    (snapshot) => {
      cb(parsePredictionSnapshot(snapshot.val()));
    },
    (err) => onError?.(err)
  );
}

export function subscribeCrashOverride(
  cb: (data: CrashPrediction | null) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const overrideRef = ref(db, 'crash/override');
  return onValue(
    overrideRef,
    (snapshot) => {
      cb(parsePredictionSnapshot(snapshot.val()));
    },
    (err) => onError?.(err)
  );
}

export function subscribeCrashHistory(
  cb: (items: CrashHistoryItem[]) => void,
  onError?: (err: Error) => void
): Unsubscribe {
  const historyQuery = query(ref(db, 'crash/history'), limitToLast(10));
  return onValue(
    historyQuery,
    (snapshot) => {
      const val = snapshot.val();
      if (!val || typeof val !== 'object') {
        cb([]);
        return;
      }
      const list: CrashHistoryItem[] = Object.entries(val)
        .map(([key, item]) => {
          const rec = item as Record<string, unknown>;
          return {
            roundNumber: Number(rec?.roundNumber ?? key),
            crashPoint: Number(rec?.crashPoint ?? 0),
            crashedAt: Number(rec?.crashedAt ?? 0),
          };
        })
        .filter((item) => !Number.isNaN(item.crashPoint) && item.crashPoint > 0)
        .sort((a, b) => b.roundNumber - a.roundNumber);
      cb(list);
    },
    (err) => onError?.(err)
  );
}

export async function writeNextPrediction(
  crashPoint: number,
  roundNumber?: number
): Promise<void> {
  const payload: { crashPoint: number; updatedAt: number; roundNumber?: number } = {
    crashPoint: Number(crashPoint.toFixed(2)),
    updatedAt: Date.now(),
  };
  if (roundNumber !== undefined && !Number.isNaN(roundNumber) && roundNumber > 0) {
    payload.roundNumber = roundNumber;
  }
  await set(ref(db, 'crash/nextPrediction'), payload);
}

export async function fetchFirebaseActivationCode(
  activationCode: string
): Promise<{ path: string; data: ActivationCodeRecord } | null> {
  const candidatePaths = [
    `codes/airplane_codes/${activationCode}`,
    `codes/apple_codes/${activationCode}`,
  ];
  for (const path of candidatePaths) {
    try {
      const snap = await get(ref(db, path));
      if (snap.exists()) {
        return { path, data: snap.val() as ActivationCodeRecord };
      }
    } catch {
      // Fall back silently if rules restrict codes/ reads
    }
  }
  return null;
}

export async function saveFirebaseActivationCode(
  code: string,
  userId: string,
  expiresAtIso: string
): Promise<void> {
  try {
    await set(ref(db, `codes/airplane_codes/${code}`), {
      is_active: true,
      type: 'airplane',
      expires_at: expiresAtIso,
      created_for: userId,
      created_at: Date.now(),
    });
  } catch {
    // Graceful fallback handled by caller
  }
}
