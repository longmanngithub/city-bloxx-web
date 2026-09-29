// helpers

export function unlockAudioContext(audioCtx) {
    if (!audioCtx || audioCtx.state !== 'suspended') return;
    const b = document.body;
    if (!b) return;
    const events = ['touchstart','touchend', 'mousedown','keydown'];
    events.forEach(e => b.addEventListener(e, unlock, false));
    function unlock() {
        audioCtx.resume().catch(() => {}).then(clean);
    }
    function clean() {
        events.forEach(e => b.removeEventListener(e, unlock));
    }
}

export function createUnlockingAudioContext(...params) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    try {
        const ac = new AudioCtx(...params);
        unlockAudioContext(ac);
        return ac;
    } catch (e) {
        console.warn('AudioContext creation failed:', e);
        return null;
    }
}

export function closeContext(ctx) {
    if (!ctx) return Promise.resolve();
    try {
        return ctx.close();
    } catch (_) {
        return Promise.resolve();
    }
}

export class LibMidi {
    constructor(context, destination=null) {
        this.context = context || null;
        this.destination = (context && (destination || context.destination)) || null;
        this.initialized = false;
        this._midiPlayer = null;
    }

    async init() {
        if (!this.context || !this.context.audioWorklet || typeof AudioWorkletNode === 'undefined') {
            this.initialized = true;
            return;
        }

        try {
            const addModuleTask = this.context.audioWorklet.addModule(new URL('worklet.js', import.meta.url).toString());
            const module = await WebAssembly.compileStreaming(fetch(new URL('libmidi.wasm', import.meta.url)));
            await addModuleTask;

            const bootstrapNode = new AudioWorkletNode(this.context, "bootstrap", {
                processorOptions: {
                    module
                }
            });

            await new Promise((resolve, reject) => {
                bootstrapNode.port.onmessage = e => {
                    if (e.data.ok) {
                        resolve();
                    } else {
                        reject(e.data.error);
                    }
                };
            });
        } catch (err) {
            console.warn('LibMidi init failed/restricted on this device:', err);
        }

        this.initialized = true;
    }

    async close() {
        if (this._midiPlayer) {
            try { this._midiPlayer.close(); } catch (_) {}
            this._midiPlayer = null;
        }

        this.initialized = false;
    }

    get midiPlayer() {
        if (this.initialized && !this._midiPlayer) {
            this._midiPlayer = new MIDIPlayer(this.context, this.destination);
        }

        return this._midiPlayer;
    }
}


// todo: we could make this bidirectional with methods and events, but at this point no need to do so
class CmdClient {
    constructor(port) {
        this.port = port;
        this.messageCounter = 0;
        this.pendingMessages = {};
        this.port.addEventListener('message', this._handleMessage.bind(this));
    }

    send(what, transfer=[]) {
        const msgId = ++this.messageCounter;
        return new Promise((resolve, reject) => {
            this.pendingMessages[msgId] = { resolve, reject };
            this.port.postMessage({ ...what, msgId }, transfer);
        });
    }

    _handleMessage(event) {
        const data = event.data;
        if (data && data.replyFor) {
            const { replyFor, value, error } = data;
            const handlers = this.pendingMessages[replyFor];

            if (handlers) {
                if (error !== undefined) {
                    handlers.reject(error);
                } else {
                    handlers.resolve(value);
                }
                delete this.pendingMessages[replyFor];
            }
        }
    }
}



export class MIDIPlayer extends EventTarget {
    static _unregister = ([client, node, gainNode]) => {
        if (client) {
            try { client.send({cmd: "delete"}); } catch (_) {}
        }
        if (node) {
            try { node.disconnect(); } catch (_) {}
        }
        if (gainNode) {
            try { gainNode.disconnect(); } catch (_) {}
        }
    };

    static _finalizer = new FinalizationRegistry(args => {
        try {
            this._unregister(args);
        } catch (_) {}
    });

    constructor(audioContext, destination) {
        super();
        this.duration = 0;
        this.gainNode = null;
        this.node = null;
        this.client = null;

        if (!audioContext || !audioContext.audioWorklet || typeof AudioWorkletNode === 'undefined') {
            return;
        }

        try {
            this.gainNode = audioContext.createGain();
            this.gainNode.gain.value = 1;
            if (destination) {
                this.gainNode.connect(destination);
            }

            this.node = new AudioWorkletNode(audioContext, 'midi-player', {
                outputChannelCount: [2]
            });
            this.node.connect(this.gainNode);
            this.client = new CmdClient(this.node.port);

            const weakThis = new WeakRef(this);

            this.node.port.onmessage = e => {
                if (e.data?.replyFor) return;
                if (e.data === 'end-of-media') {
                    weakThis.deref()?.dispatchEvent(new Event('end-of-media'));
                }
            };

            MIDIPlayer._finalizer.register(this, [this.client, this.node, this.gainNode], this);
        } catch (err) {
            console.warn('MIDIPlayer construction failed:', err);
        }
    }

    send(what, transfer=[]) {
        return this.client ? this.client.send(what, transfer) : Promise.resolve();
    }

    async setSequence(buffer) {
        if (!this.client) return;
        try {
            const res = await this.send({cmd: "setSequence", buffer});
            const duration = res?.duration || 0;
            this.duration = duration;
        } catch (e) {
            console.warn("setSequence error:", e);
        }
    }

    play() {
        if (this.client) {
            try { this.send({cmd: "play"}); } catch (_) {}
        }
    }

    loop(times) {
        if (this.client) {
            try { this.send({cmd: "loop", times}); } catch (_) {}
        }
    }

    stop() {
        if (this.client) {
            try { this.send({cmd: "stop"}); } catch (_) {}
        }
    }

    shortEvent(status, data1, data2) {
        if (this.client) {
            try { this.send({cmd: "shortEvent", status, data1, data2}); } catch (_) {}
        }
    }

    getPosition() {
        return this.client ? this.send({cmd: "getPosition"}) : Promise.resolve(0);
    }

    seek(pos) {
        return this.client ? this.send({cmd: "seek", pos}) : Promise.resolve();
    }

    close() {
        if (this.client || this.node || this.gainNode) {
            MIDIPlayer._unregister([this.client, this.node, this.gainNode]);
            try {
                MIDIPlayer._finalizer.unregister(this);
            } catch (_) {}
            this.client = null;
            this.node = null;
            this.gainNode = null;
        }
    }

    get volume() {
        return this.gainNode?.gain?.value ?? 1;
    }

    set volume(v) {
        if (this.gainNode?.gain) {
            this.gainNode.gain.value = v;
        }
    }
}
