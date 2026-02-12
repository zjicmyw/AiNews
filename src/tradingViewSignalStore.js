export class TradingViewSignalStore {
  constructor() {
    this.lastSignal = null;
  }

  save(signal) {
    this.lastSignal = {
      ...signal,
      received_at: Date.now()
    };
  }

  getRecentSignal(maxAgeSec) {
    if (!this.lastSignal) return null;
    const age = (Date.now() - this.lastSignal.received_at) / 1000;
    if (age > maxAgeSec) return null;
    return this.lastSignal;
  }
}
