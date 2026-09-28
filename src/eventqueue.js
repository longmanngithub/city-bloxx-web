// Asynchronous producer-consumer queue for immediate CheerpJ event bridge dispatch
export class EventQueue {
  constructor() {
    this.queue = [];
    this.waiters = [];
    this.started = false;
  }

  queueEvent(evt, skipIfExists = null) {
    if (!this.started) return;
    if (skipIfExists && this.queue.some(skipIfExists)) {
      return;
    }
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift();
      resolve(evt);
    } else {
      this.queue.push(evt);
    }
  }

  async waitForEvent() {
    this.started = true;
    if (this.queue.length > 0) {
      return this.queue.shift();
    }
    return new Promise(resolve => {
      this.waiters.push(resolve);
    });
  }
}
