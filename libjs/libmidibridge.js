export default {
    async Java_pl_zb3_freej2me_bridge_media_MidiBridge_getMidiPlayer(lib) {
        try {
            return window.libmidi ? window.libmidi.midiPlayer : null;
        } catch (e) {
            console.warn('[MidiBridge] getMidiPlayer error:', e);
            return null;
        }
    },
    async Java_pl_zb3_freej2me_bridge_media_MidiBridge_midiSetSequence(lib, player, sequence) {
        if (!player || !sequence) return -1;
        try {
            await player.setSequence(sequence.buffer);
            return player.duration || 0;
        } catch (e) {
            console.warn('[MidiBridge] midiSetSequence error:', e);
            return -1;
        }
    },
    async Java_pl_zb3_freej2me_bridge_media_MidiBridge_midiPlay(lib, player) {
        if (!player) return;
        try {
            player.play();
        } catch (e) {
            console.warn('[MidiBridge] midiPlay error:', e);
        }
    },
    async Java_pl_zb3_freej2me_bridge_media_MidiBridge_midiLoop(lib, player, times) {
        if (!player) return;
        try {
            player.loop(times);
        } catch (e) {
            console.warn('[MidiBridge] midiLoop error:', e);
        }
    },
    async Java_pl_zb3_freej2me_bridge_media_MidiBridge_midiStop(lib, player) {
        if (!player) return;
        try {
            player.stop();
        } catch (e) {
            console.warn('[MidiBridge] midiStop error:', e);
        }
    },
    async Java_pl_zb3_freej2me_bridge_media_MidiBridge_midiShortEvent(lib, player, status, data1, data2) {
        if (!player) return;
        try {
            player.shortEvent(status, data1, data2);
        } catch (e) {
            console.warn('[MidiBridge] midiShortEvent error:', e);
        }
    },
    async Java_pl_zb3_freej2me_bridge_media_MidiBridge_midiGetPosition(lib, player) {
        if (!player) return 0;
        try {
            return (await player.getPosition()) || 0;
        } catch (e) {
            console.warn('[MidiBridge] midiGetPosition error:', e);
            return 0;
        }
    },
    async Java_pl_zb3_freej2me_bridge_media_MidiBridge_midiSeek(lib, player, pos) {
        if (!player) return;
        try {
            player.seek(pos);
        } catch (e) {
            console.warn('[MidiBridge] midiSeek error:', e);
        }
    },
    async Java_pl_zb3_freej2me_bridge_media_MidiBridge_midiGetVolume(lib, player) {
        if (!player) return 100;
        try {
            return player.volume ?? 100;
        } catch (e) {
            console.warn('[MidiBridge] midiGetVolume error:', e);
            return 100;
        }
    },
    async Java_pl_zb3_freej2me_bridge_media_MidiBridge_midiSetVolume(lib, player, vol) {
        if (!player) return;
        try {
            player.volume = vol;
        } catch (e) {
            console.warn('[MidiBridge] midiSetVolume error:', e);
        }
    },
}
