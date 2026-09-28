export class TokenBucket {
  constructor({ rate, burst, now = Date.now }) {
    this.rate = rate;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.updatedAt = now();
  }
  take(count = 1) {
    const current = this.now();
    this.tokens = Math.min(
      this.burst,
      this.tokens + ((current - this.updatedAt) / 1000) * this.rate,
    );
    this.updatedAt = current;
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }
  retryAfterMs() {
    return Math.max(0, Math.ceil(((1 - this.tokens) / this.rate) * 1000));
  }
}

export function createSocketLimiters(now = Date.now) {
  return {
    all: new TokenBucket({ rate: 40, burst: 80, now }),
    push: new TokenBucket({ rate: 10, burst: 20, now }),
    pull: new TokenBucket({ rate: 10, burst: 20, now }),
    typing: new TokenBucket({ rate: 2, burst: 2, now }),
  };
}
