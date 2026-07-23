import { decodePeakResidentBytes } from "@/audio/decode-budget";
import type { DecodeBudget } from "@/audio/decode-budget";

/**
 * Releases one previously acquired semaphore slot. Idempotent: only the first
 * call frees a slot, so a caller can release from a finally without tracking
 * whether an earlier branch already released. A second call is a no-op and can
 * never over-free a slot (which would let a phantom extra holder run).
 */
export type SemaphoreRelease = () => void;

export interface CountingSemaphore {
  /**
   * Acquires a slot, resolving with its release function. While every slot is
   * held the caller waits in FIFO (arrival) order until one is released.
   *
   * Passing an AbortSignal makes the wait abortable: if the signal fires while
   * the caller is still queued, the returned promise rejects with the signal's
   * reason and the waiter leaves the queue WITHOUT consuming a slot (so the
   * slot it was waiting for is still handed to the next waiter, or returned to
   * the pool). A caller that has already been granted a slot is unaffected by a
   * later abort and must still release it.
   */
  acquire(signal?: AbortSignal): Promise<SemaphoreRelease>;
  /** Current maximum number of simultaneously held slots. */
  readonly capacity: number;
  /** Slots not currently held (0 when full). */
  readonly available: number;
  /** Callers currently waiting in the FIFO queue for a slot. */
  readonly pending: number;
  /**
   * Adjusts the capacity in place. Raising it immediately grants freed slots to
   * queued waiters in FIFO order; lowering it never preempts a held slot, it
   * only blocks new acquisitions until enough held slots are released.
   */
  setCapacity(nextCapacity: number): void;
}

interface SemaphoreWaiter {
  grant: () => void;
}

function assertPositiveIntegerCapacity(capacity: number): number {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError("Semaphore capacity must be a positive safe integer.");
  }
  return capacity;
}

/**
 * A pure, DOM-free FIFO counting semaphore. It owns no timers and knows nothing
 * about audio; it just bounds how many holders run at once and hands waiting
 * slots out in arrival order. The browser-decode window builds on it to cap how
 * many concurrent, untrusted decodeAudioData allocations can be in flight, but
 * the primitive is deliberately general so it can be unit-tested in isolation.
 */
export function createCountingSemaphore(capacity: number): CountingSemaphore {
  let maxSlots = assertPositiveIntegerCapacity(capacity);
  // Slots currently held by callers. A slot is available while
  // `outstanding < maxSlots`. Tracking held slots (rather than a free count)
  // lets setCapacity change maxSlots without reconciling a separate counter.
  let outstanding = 0;
  const waiters: SemaphoreWaiter[] = [];

  // Hand free slots to queued waiters in FIFO order until capacity is reached
  // or the queue drains. The slot is reserved (`outstanding += 1`) before the
  // waiter is granted, because grant() resolves a promise whose continuation
  // runs later as a microtask; reserving first keeps the count correct if a
  // release/setCapacity re-enters between grants.
  const pump = () => {
    while (outstanding < maxSlots && waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter) {
        break;
      }
      outstanding += 1;
      waiter.grant();
    }
  };

  const makeRelease = (): SemaphoreRelease => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      outstanding -= 1;
      pump();
    };
  };

  const acquire = (signal?: AbortSignal): Promise<SemaphoreRelease> =>
    new Promise<SemaphoreRelease>((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(signal.reason);
        return;
      }

      if (outstanding < maxSlots) {
        outstanding += 1;
        resolve(makeRelease());
        return;
      }

      // No free slot: join the FIFO queue. Whichever of grant/abort happens
      // first flips `settled` and wins; the loser becomes a no-op. Enqueue
      // before wiring the abort listener so the two always refer to the same
      // queue entry.
      let settled = false;
      let removeAbortListener = () => {};
      const waiter: SemaphoreWaiter = {
        grant: () => {
          if (settled) {
            return;
          }
          settled = true;
          removeAbortListener();
          resolve(makeRelease());
        },
      };
      waiters.push(waiter);

      if (signal) {
        const onAbort = () => {
          if (settled) {
            return;
          }
          settled = true;
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(signal.reason);
        };
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });

  return {
    acquire,
    get capacity() {
      return maxSlots;
    },
    get available() {
      return Math.max(0, maxSlots - outstanding);
    },
    get pending() {
      return waiters.length;
    },
    setCapacity(nextCapacity: number) {
      maxSlots = assertPositiveIntegerCapacity(nextCapacity);
      pump();
    },
  };
}

/**
 * Browser-decode window capacity: how many browser decodeAudioData calls may
 * run at once so their combined transient allocation stays within the batch
 * aggregate cap. Each browser decode can transiently hold the browser decode
 * peak (the AudioBuffer plus its planar copy = 2x maxDecodedBytes), so the
 * window admits `floor(aggregate / browserPeak)` of them, never fewer than one
 * (a constrained device whose aggregate holds a single route still decodes one
 * file at a time). On the capable large tier the aggregate holds two
 * conservative routes, so this resolves to 2; constrained devices get 1. Pure
 * so the capacity rule is testable outside the DOM.
 */
export function browserDecodeWindowCapacity(
  aggregatePeakBytes: number,
  budget: DecodeBudget,
): number {
  const browserPeakBytes = decodePeakResidentBytes(
    "browser",
    budget.maxDecodedBytes,
  );
  return Math.max(1, Math.floor(aggregatePeakBytes / browserPeakBytes));
}
